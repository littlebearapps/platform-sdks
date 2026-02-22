/**
 * Pattern Discovery Worker
 *
 * AI-assisted discovery of transient error patterns.
 * Analyses high-frequency unclassified errors and suggests
 * regex patterns for human approval.
 *
 * Schedule: Daily at 2:00 AM UTC
 *
 * @module workers/pattern-discovery
 * @created 2026-02-02
 */

import type {
  KVNamespace,
  ExecutionContext,
  ScheduledEvent,
  D1Database,
} from '@cloudflare/workers-types';
import {
  withCronBudget,
  CircuitBreakerError,
  completeTracking,
  createLogger,
  createLoggerFromRequest,
  health,
  MONITOR_PATTERN_DISCOVERY,
  HEARTBEAT_HEALTH,
} from '@littlebearapps/platform-sdk';
import {
  queryUnclassifiedErrors,
  clusterErrors,
  buildClusterObjects,
  getSampleMessages,
  storeClusters,
  getPendingClusters,
  updateClusterStatus,
  MAX_SAMPLES_PER_CLUSTER,
} from './lib/pattern-discovery/clustering';
import {
  suggestPatterns,
  evaluateStaticPatterns,
  type StaticPatternInput,
} from './lib/pattern-discovery/ai-prompt';
import { TRANSIENT_ERROR_PATTERNS } from './lib/error-collector/fingerprint';
import {
  validatePatternSafety,
  backtestPattern,
  storeBacktestResult,
  compilePattern,
} from './lib/pattern-discovery/validation';
import {
  storePatternSuggestions,
  getPendingSuggestions,
  approveSuggestion,
  rejectSuggestion,
  refreshDynamicPatternsCache,
  getApprovedPatterns,
  getPatternStats,
} from './lib/pattern-discovery/storage';
import {
  runShadowEvaluationCycle,
  enterShadowMode,
  DEFAULT_EVALUATION_CONFIG,
  type AIContextEnv,
} from './lib/pattern-discovery/shadow-evaluation';
import type { DiscoveryResult, ErrorCluster, PatternRule } from './lib/pattern-discovery/types';
import { pingHeartbeat } from '@littlebearapps/platform-sdk';

// =============================================================================
// TYPES
// =============================================================================

interface Env {
  PLATFORM_DB: D1Database;
  PLATFORM_CACHE: KVNamespace;
  PLATFORM_TELEMETRY: Queue;
  NOTIFICATIONS_API?: Fetcher; // Optional: for creating dashboard notifications
  PLATFORM_AI_GATEWAY_KEY: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  GATUS_HEARTBEAT_URL?: string; // Gatus heartbeat ping URL for cron monitoring
  GATUS_TOKEN?: string; // Bearer token for Gatus external endpoints
}

/**
 * Create a dashboard notification for new pattern suggestions.
 * Non-blocking - failures are logged but don't affect discovery.
 */
async function createPatternNotification(
  api: Fetcher | undefined,
  suggestionsCount: number
): Promise<void> {
  if (!api || suggestionsCount === 0) return;

  try {
    await api.fetch('https://platform-notifications/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'info',
        source: 'pattern-discovery',
        title: `${suggestionsCount} new pattern suggestion${suggestionsCount !== 1 ? 's' : ''} pending review`,
        description: `AI discovered ${suggestionsCount} potential transient error pattern${suggestionsCount !== 1 ? 's' : ''}. Review and approve in the Pattern Discovery dashboard.`,
        priority: 'low',
        action_url: '/patterns',
        action_label: 'Review Patterns',
        project: 'platform',
      }),
    });
  } catch (e) {
    // Non-blocking - log and continue
    console.error('Failed to create pattern notification:', e);
  }
}

/**
 * Create a dashboard notification when shadow patterns are ready for human review.
 * Higher priority than discovery notifications since these need action.
 */
async function createReviewNotification(
  api: Fetcher | undefined,
  readyCount: number
): Promise<void> {
  if (!api || readyCount === 0) return;

  try {
    await api.fetch('https://platform-notifications/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'warning',
        source: 'pattern-discovery',
        title: `${readyCount} pattern${readyCount !== 1 ? 's' : ''} ready for your review`,
        description: `Shadow evaluation completed. ${readyCount} pattern${readyCount !== 1 ? 's have' : ' has'} collected enough evidence and need${readyCount === 1 ? 's' : ''} human review before approval.`,
        priority: 'medium',
        action_url: '/patterns',
        action_label: 'Review Patterns',
        project: 'platform',
      }),
    });
  } catch (e) {
    console.error('Failed to create review notification:', e);
  }
}

// =============================================================================
// FEATURE ID
// =============================================================================

const FEATURE_ID = MONITOR_PATTERN_DISCOVERY;

// =============================================================================
// MAIN WORKER
// =============================================================================

export default {
  /**
   * Scheduled handler - runs daily pattern discovery and shadow evaluation
   *
   * Cron schedule: 0 2 * * * (2:00 AM UTC)
   * - Pattern discovery: Find new patterns from error clusters
   * - Shadow evaluation: Auto-promote/demote patterns based on performance
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const log = createLogger({ worker: 'pattern-discovery', featureId: FEATURE_ID });
    log.info('Pattern discovery triggered', {
      scheduled_time: new Date(event.scheduledTime).toISOString(),
    });

    // Gatus heartbeat is pinged on success/fail only (no /start support)

    try {
      const trackedEnv = withCronBudget(env, FEATURE_ID, {
        ctx,
        cronExpression: '0 2 * * *', // Daily at 2:00 AM UTC
      });

      // Step 1: Run pattern discovery
      const discoveryResult = await runDiscovery(env, log);

      // Create dashboard notification if suggestions were created
      if (discoveryResult.suggestionsCreated > 0) {
        ctx.waitUntil(createPatternNotification(env.NOTIFICATIONS_API, discoveryResult.suggestionsCreated));
      }

      // Step 2: Run shadow evaluation cycle (marks patterns ready for review, auto-demotes stale)
      // Pass env for AI explainer generation
      const aiEnv: AIContextEnv = {
        CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
        PLATFORM_AI_GATEWAY_KEY: env.PLATFORM_AI_GATEWAY_KEY,
      };
      const evaluationResult = await runShadowEvaluationCycle(
        env.PLATFORM_DB,
        env.PLATFORM_CACHE,
        log,
        DEFAULT_EVALUATION_CONFIG,
        aiEnv
      );

      // Notify when patterns are ready for human review
      if (evaluationResult.readyForReview > 0) {
        ctx.waitUntil(createReviewNotification(env.NOTIFICATIONS_API, evaluationResult.readyForReview));
      }

      // Refresh KV cache of approved patterns so error-collector always has latest
      await refreshDynamicPatternsCache(env.PLATFORM_DB, env.PLATFORM_CACHE, log);

      // Send heartbeat
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await health(HEARTBEAT_HEALTH, env.PLATFORM_CACHE as any, env.PLATFORM_TELEMETRY, ctx);
      await completeTracking(trackedEnv);

      // Signal success to Gatus heartbeat
      pingHeartbeat(ctx, env.GATUS_HEARTBEAT_URL, env.GATUS_TOKEN, true);

      log.info('Pattern discovery and evaluation complete', {
        discovery: {
          runId: discoveryResult.runId,
          clustersFound: discoveryResult.clustersFound,
          suggestionsCreated: discoveryResult.suggestionsCreated,
          errors: discoveryResult.errors.length,
        },
        evaluation: evaluationResult,
      });
    } catch (error) {
      if (error instanceof CircuitBreakerError) {
        log.warn('Circuit breaker STOP', error, { reason: error.reason });
        return;
      }

      // Signal failure to Gatus heartbeat
      pingHeartbeat(ctx, env.GATUS_HEARTBEAT_URL, env.GATUS_TOKEN, false);

      log.error('Pattern discovery failed', error);
    }
  },

  /**
   * HTTP handler for manual triggers and API endpoints
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check (lightweight, no SDK overhead)
    if (url.pathname === '/health') {
      return Response.json({
        status: 'ok',
        service: 'pattern-discovery',
        timestamp: new Date().toISOString(),
      });
    }

    const log = createLoggerFromRequest(request, env, 'pattern-discovery', FEATURE_ID);

    try {
      // Manual discovery trigger
      if (url.pathname === '/discover' && request.method === 'GET') {
        const result = await runDiscovery(env, log);
        return Response.json(result);
      }

      // Get pending suggestions
      if (url.pathname === '/suggestions' && request.method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '20', 10);
        const suggestions = await getPendingSuggestions(env.PLATFORM_DB, limit);
        return Response.json({ suggestions, count: suggestions.length });
      }

      // Get shadow patterns ready for human review (have review_context)
      if (url.pathname === '/ready-for-review' && request.method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '20', 10);
        // Query shadow patterns that have review_context populated
        const result = await env.PLATFORM_DB
          .prepare(`
            SELECT
              id, pattern_type as patternType, pattern_value as patternValue,
              category, scope, confidence_score as confidenceScore,
              sample_messages as sampleMessages, ai_reasoning as aiReasoning,
              cluster_id as clusterId, status,
              reviewed_by as reviewedBy, reviewed_at as reviewedAt,
              rejection_reason as rejectionReason,
              backtest_match_count as backtestMatchCount,
              backtest_total_errors as backtestTotalErrors,
              backtest_match_rate as backtestMatchRate,
              shadow_mode_start as shadowModeStart,
              shadow_mode_end as shadowModeEnd,
              shadow_mode_matches as shadowModeMatches,
              shadow_match_days as shadowMatchDays,
              enabled_at as enabledAt, disabled_at as disabledAt,
              last_matched_at as lastMatchedAt, match_count as matchCount,
              is_protected as isProtected, source, original_regex as originalRegex,
              review_context as reviewContext,
              created_at as createdAt, updated_at as updatedAt
            FROM transient_pattern_suggestions
            WHERE status = 'shadow' AND review_context IS NOT NULL
            ORDER BY
              json_extract(review_context, '$.totalMatches') DESC,
              created_at ASC
            LIMIT ?
          `)
          .bind(limit)
          .all();

        const suggestions = result.results.map((r: Record<string, unknown>) => ({
          ...r,
          sampleMessages: typeof r.sampleMessages === 'string' ? JSON.parse(r.sampleMessages as string) : [],
          shadowMatchDays: typeof r.shadowMatchDays === 'string' && r.shadowMatchDays ? JSON.parse(r.shadowMatchDays as string) : [],
          reviewContext: typeof r.reviewContext === 'string' && r.reviewContext ? JSON.parse(r.reviewContext as string) : null,
          isProtected: Boolean(r.isProtected),
        }));

        return Response.json({ suggestions, count: suggestions.length });
      }

      // Approve a suggestion
      if (url.pathname.startsWith('/suggestions/') && request.method === 'POST') {
        const id = url.pathname.split('/').pop();
        const action = url.searchParams.get('action');

        if (!id) {
          return Response.json({ error: 'Missing suggestion ID' }, { status: 400 });
        }

        if (action === 'approve') {
          const reviewedBy = url.searchParams.get('by') || 'api';

          // Run backtest first
          const suggestion = (await getPendingSuggestions(env.PLATFORM_DB, 100)).find(
            (s) => s.id === id
          );
          if (!suggestion) {
            return Response.json({ error: 'Suggestion not found' }, { status: 404 });
          }

          const rule: PatternRule = {
            type: suggestion.patternType,
            value: suggestion.patternValue,
            category: suggestion.category,
            scope: suggestion.scope as PatternRule['scope'],
          };

          // Validate safety
          const safetyError = validatePatternSafety(suggestion.patternType, suggestion.patternValue);
          if (safetyError) {
            return Response.json({ error: `Safety check failed: ${safetyError}` }, { status: 400 });
          }

          // Run backtest
          const backtestResult = await backtestPattern(id, rule, env.PLATFORM_DB, log);
          await storeBacktestResult(env.PLATFORM_DB, backtestResult, log);

          if (backtestResult.overMatching) {
            return Response.json(
              {
                error: 'Pattern over-matches',
                matchRate: backtestResult.matchRate,
                threshold: 0.8,
              },
              { status: 400 }
            );
          }

          // Approve
          const success = await approveSuggestion(
            env.PLATFORM_DB,
            env.PLATFORM_CACHE,
            id,
            reviewedBy,
            log
          );
          return Response.json({ success, action: 'approved' });
        }

        if (action === 'reject') {
          const reviewedBy = url.searchParams.get('by') || 'api';
          const reason = url.searchParams.get('reason') || 'Rejected via API';
          const success = await rejectSuggestion(env.PLATFORM_DB, id, reviewedBy, reason, log);
          return Response.json({ success, action: 'rejected' });
        }

        return Response.json({ error: 'Invalid action' }, { status: 400 });
      }

      // Refresh KV cache
      if (url.pathname === '/cache/refresh' && request.method === 'POST') {
        await refreshDynamicPatternsCache(env.PLATFORM_DB, env.PLATFORM_CACHE, log);
        return Response.json({ status: 'refreshed' });
      }

      // List approved patterns with match stats
      if (url.pathname === '/patterns' && request.method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        const offset = parseInt(url.searchParams.get('offset') || '0', 10);
        const patterns = await getApprovedPatterns(env.PLATFORM_DB, limit, offset);
        return Response.json({ patterns, count: patterns.length, limit, offset });
      }

      // Pattern stats summary
      if (url.pathname === '/patterns/stats' && request.method === 'GET') {
        const stats = await getPatternStats(env.PLATFORM_DB);
        return Response.json(stats);
      }

      // Run shadow evaluation manually
      if (url.pathname === '/evaluate-shadow' && request.method === 'GET') {
        const aiEnv: AIContextEnv = {
          CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
          PLATFORM_AI_GATEWAY_KEY: env.PLATFORM_AI_GATEWAY_KEY,
        };
        const result = await runShadowEvaluationCycle(
          env.PLATFORM_DB,
          env.PLATFORM_CACHE,
          log,
          DEFAULT_EVALUATION_CONFIG,
          aiEnv
        );
        return Response.json(result);
      }

      // Move a pending suggestion into shadow mode
      if (url.pathname.startsWith('/suggestions/') && url.pathname.endsWith('/shadow') && request.method === 'POST') {
        const id = url.pathname.split('/')[2];
        if (!id) {
          return Response.json({ error: 'Missing suggestion ID' }, { status: 400 });
        }

        const success = await enterShadowMode(env.PLATFORM_DB, id, log);
        if (success) {
          return Response.json({ success: true, action: 'entered-shadow' });
        }
        return Response.json({ error: 'Failed to enter shadow mode' }, { status: 400 });
      }

      // Evaluate static patterns for potential migration
      if (url.pathname === '/evaluate-static' && request.method === 'GET') {
        // Convert static regex patterns to input format
        const staticPatterns: StaticPatternInput[] = TRANSIENT_ERROR_PATTERNS.map((p, i) => ({
          pattern: p.pattern.source, // Get regex source string
          category: p.category,
          index: i + 1,
        }));

        // Allow limiting which patterns to evaluate (for testing)
        const startParam = url.searchParams.get('start');
        const endParam = url.searchParams.get('end');
        const start = startParam ? parseInt(startParam, 10) - 1 : 0;
        const end = endParam ? parseInt(endParam, 10) : staticPatterns.length;

        const patternsToEvaluate = staticPatterns.slice(start, end);

        log.info('Evaluating static patterns', {
          total: staticPatterns.length,
          evaluating: patternsToEvaluate.length,
          range: `${start + 1}-${end}`,
        });

        const evaluation = await evaluateStaticPatterns(patternsToEvaluate, env, log);

        if (!evaluation) {
          return Response.json({ error: 'AI evaluation failed' }, { status: 500 });
        }

        // Add summary stats
        const stats = {
          totalPatterns: staticPatterns.length,
          evaluated: patternsToEvaluate.length,
          keepStatic: evaluation.evaluations.filter((e) => e.verdict === 'keep-static').length,
          migrateDynamic: evaluation.evaluations.filter((e) => e.verdict === 'migrate-dynamic')
            .length,
          merge: evaluation.evaluations.filter((e) => e.verdict === 'merge').length,
          deprecate: evaluation.evaluations.filter((e) => e.verdict === 'deprecate').length,
        };

        return Response.json({
          ...evaluation,
          stats,
          patterns: patternsToEvaluate, // Include input patterns for reference
        });
      }

      // API index
      return Response.json({
        service: 'pattern-discovery',
        endpoints: [
          'GET /health - Health check',
          'GET /discover - Run pattern discovery',
          'GET /suggestions - List pending suggestions',
          'POST /suggestions/:id?action=approve&by=name - Approve suggestion',
          'POST /suggestions/:id?action=reject&by=name&reason=text - Reject suggestion',
          'POST /suggestions/:id/shadow - Move pending suggestion to shadow mode',
          'POST /cache/refresh - Refresh KV cache',
          'GET /patterns - List approved patterns with match stats',
          'GET /patterns/stats - Pattern statistics summary',
          'GET /evaluate-static?start=N&end=M - Evaluate static patterns with AI for migration',
          'GET /evaluate-shadow - Run shadow evaluation cycle manually',
        ],
      });
    } catch (error) {
      if (error instanceof CircuitBreakerError) {
        log.warn('Circuit breaker tripped', error);
        return Response.json(
          { error: 'Service temporarily unavailable', code: 'CIRCUIT_BREAKER' },
          { status: 503, headers: { 'Retry-After': '60' } }
        );
      }

      log.error('Request failed', error);
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }
  },
};

// =============================================================================
// DISCOVERY LOGIC
// =============================================================================

/**
 * Run the full pattern discovery pipeline
 */
async function runDiscovery(
  env: Env,
  log: ReturnType<typeof createLogger>
): Promise<DiscoveryResult> {
  const runId = `discovery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const errors: string[] = [];

  log.info('Starting pattern discovery', { runId });

  // Step 1: Query unclassified errors
  const unclassifiedErrors = await queryUnclassifiedErrors(env.PLATFORM_DB, log);
  if (unclassifiedErrors.length === 0) {
    log.info('No unclassified errors to process');
    return {
      runId,
      runAt: Math.floor(Date.now() / 1000),
      clustersFound: 0,
      clustersProcessed: 0,
      suggestionsCreated: 0,
      errors: [],
    };
  }

  // Step 2: Cluster similar errors
  const clusteredErrors = clusterErrors(unclassifiedErrors);
  const clusters = buildClusterObjects(clusteredErrors);

  log.info('Clustered errors', {
    totalErrors: unclassifiedErrors.length,
    uniqueClusters: clusteredErrors.size,
    significantClusters: clusters.length,
  });

  // Step 3: Store clusters for tracking
  await storeClusters(env.PLATFORM_DB, clusters, log);

  // Step 4: Get sample messages for each cluster
  const sampleMessages = new Map<string, string[]>();
  for (const cluster of clusters) {
    // Find the errors that belong to this cluster
    const clusterHash = cluster.clusterHash;
    const clusterErrorsList: { normalizedMessage: string }[] = [];

    for (const [hash, errs] of clusteredErrors) {
      // Simple hash comparison (our clustering is based on this hash)
      const testHash = hashMessage(errs[0]?.normalizedMessage || '');
      if (testHash === clusterHash || hash === clusterHash) {
        clusterErrorsList.push(...errs.map((e) => ({ normalizedMessage: e.normalizedMessage })));
        break;
      }
    }

    const samples = getSampleMessages(
      clusterErrorsList.map((e) => ({
        fingerprint: '',
        scriptName: '',
        normalizedMessage: e.normalizedMessage,
        occurrenceCount: 1,
        lastSeenAt: 0,
      })),
      MAX_SAMPLES_PER_CLUSTER
    );
    sampleMessages.set(cluster.id, samples);
  }

  // Step 5: Call AI for pattern suggestions
  let suggestionsCreated = 0;

  if (clusters.length > 0 && env.PLATFORM_AI_GATEWAY_KEY) {
    const aiResponse = await suggestPatterns(clusters, sampleMessages, env, log);

    if (aiResponse && aiResponse.patterns.length > 0) {
      // Step 6: Store suggestions and validate
      for (let i = 0; i < Math.min(clusters.length, aiResponse.patterns.length); i++) {
        const cluster = clusters[i];
        const pattern = aiResponse.patterns[i];

        if (!pattern || pattern.confidence < 0.5) {
          await updateClusterStatus(env.PLATFORM_DB, cluster.id, 'ignored');
          continue;
        }

        // Validate pattern safety
        const safetyError = validatePatternSafety(pattern.patternType, pattern.patternValue);
        if (safetyError) {
          log.warn('Pattern failed safety check', {
            cluster: cluster.id,
            error: safetyError,
          });
          errors.push(`Cluster ${cluster.id}: ${safetyError}`);
          await updateClusterStatus(env.PLATFORM_DB, cluster.id, 'ignored');
          continue;
        }

        // Store the suggestion
        const suggestionIds = await storePatternSuggestions(
          env.PLATFORM_DB,
          cluster,
          { patterns: [pattern], summary: aiResponse.summary },
          log
        );

        if (suggestionIds.length > 0) {
          suggestionsCreated += suggestionIds.length;
          await updateClusterStatus(env.PLATFORM_DB, cluster.id, 'suggested', suggestionIds[0]);
        }
      }
    }
  } else if (!env.PLATFORM_AI_GATEWAY_KEY) {
    log.warn('AI Gateway key not configured, skipping AI analysis');
    errors.push('AI Gateway key not configured');
  }

  return {
    runId,
    runAt: Math.floor(Date.now() / 1000),
    clustersFound: clusters.length,
    clustersProcessed: clusters.length,
    suggestionsCreated,
    errors,
  };
}

/**
 * Simple hash function (duplicated from clustering.ts for local use)
 */
function hashMessage(message: string): string {
  const normalized = message
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\d+/g, 'N')
    .replace(/[a-f0-9]{8,}/gi, 'HASH')
    .trim();

  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}
