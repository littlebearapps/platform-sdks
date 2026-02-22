/**
 * Platform Sentinel Worker
 *
 * Monitors Cloudflare resource costs and sends alerts via Slack and Email
 * when costs exceed configured thresholds or spike significantly.
 *
 * Runs on a cron schedule (every 15 minutes) and uses KV for rate limiting
 * to prevent alert fatigue.
 *
 * @module workers/platform-sentinel
 * @created 2026-01-05
 * @renamed 2026-01-23 (from cost-spike-alerter)
 * @task task-17.20 - Slack webhook alerts for cost spikes
 * @task task-17.21 - Email alerts via Resend
 */

import type {
  KVNamespace,
  ExecutionContext,
  ScheduledEvent,
  D1Database,
  Fetcher,
} from '@cloudflare/workers-types';
import {
  withFeatureBudget,
  withCronBudget,
  CircuitBreakerError,
  completeTracking,
  MONITOR_COST_SPIKE,
  HEARTBEAT_HEALTH,
  createLogger,
  createLoggerFromRequest,
  createTraceContext,
  health,
  type Logger,
} from '@littlebearapps/platform-sdk';
import {
  detectGaps,
  storeGapReport,
  alertGaps,
  alertGapsEmail,
  detectProjectGaps,
  type ProjectGap,
} from './lib/sentinel/gap-detection';
import { pingHeartbeat } from '@littlebearapps/platform-sdk';
import { PAID_ALLOWANCES, PRICING_TIERS } from '@littlebearapps/platform-sdk';

interface Env {
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  SLACK_WEBHOOK_URL: string;
  RESEND_API_KEY: string;
  ALERT_EMAIL_TO: string;
  PLATFORM_DB: D1Database; // For system health checks
  PLATFORM_CACHE: KVNamespace;
  PLATFORM_ALERTS: KVNamespace; // For rate limiting
  PLATFORM_TELEMETRY: Queue; // For SDK telemetry
  GATUS_HEARTBEAT_URL?: string; // Gatus heartbeat ping URL for cron monitoring
  GATUS_TOKEN?: string; // Bearer token for Gatus external endpoints
  NOTIFICATIONS_API?: Fetcher; // For creating dashboard notifications
  ERROR_COLLECTOR?: Fetcher; // For creating gap alert GitHub issues
}

// TODO: Set your dashboard URL and alert email address
const DASHBOARD_URL = 'https://your-dashboard.example.com';
const ALERT_FROM_EMAIL = 'Usage Alerts <alerts@mail.your-domain.com>';

// Module-scope raw Fetcher references — set in scheduled() BEFORE SDK wrapping.
// The SDK proxy wraps .fetch() causing "Illegal invocation" on native Fetcher bindings.
let _rawNotificationsApi: Fetcher | undefined;
let _rawErrorCollector: Fetcher | undefined;

/**
 * Threshold configuration stored in KV
 */
interface ServiceThreshold {
  warningPct: number;
  highPct: number;
  criticalPct: number;
  absoluteMax: number;
  enabled: boolean;
}

interface AlertThresholds {
  [key: string]: ServiceThreshold;
}

/**
 * Cost breakdown by service
 */
interface CostBreakdown {
  workers: number;
  d1: number;
  kv: number;
  r2: number;
  durableObjects: number;
  vectorize: number;
  aiGateway: number;
  workersAI: number;
  pages: number;
  queues: number;
  workflows: number;
  total: number;
}

/**
 * Alert data structure
 */
interface CostSpikeAlert {
  id: string;
  serviceType: string;
  resourceName: string;
  currentCost: number;
  previousCost: number;
  costDeltaPct: number;
  costPercentOfMax: number;
  thresholdLevel: 'normal' | 'warning' | 'high' | 'critical';
  absoluteMax: number;
  timestamp: string;
  /** Billing period context */
  billingPeriodStart: string;
  billingPeriodEnd: string;
  billingDaysElapsed: number;
  billingDaysTotal: number;
  /** Workers Paid plan allowance context */
  monthlyAllowance: string;
  isWithinAllowance: boolean;
  overageCost: number;
  /** Per-project cost breakdown (top contributors) */
  topProjects: Array<{ project: string; cost: number; pctOfTotal: number }>;
  /** Per-feature usage breakdown (top contributors) */
  topFeatures: Array<{ featureKey: string; usage: number; pctOfTotal: number }>;
  /** Per-metric usage vs plan allowance breakdown */
  usageBreakdown: UsageMetricBreakdown[];
}

/**
 * Workers Paid plan allowance descriptions for alert context.
 * These describe what's included free each month.
 */
const SERVICE_ALLOWANCE_DESCRIPTIONS: Record<string, string> = {
  workers: '10M requests + 30M CPU-ms/mo (Workers Paid)',
  d1: '25B reads + 50M writes/mo (Workers Paid)',
  kv: '10M reads + 1M writes + 1M deletes + 1M lists/mo',
  r2: '10GB storage + 1M Class A + 10M Class B ops/mo',
  durableObjects: '1M requests + 400K GB-s/mo',
  vectorize: '10M stored + 50M queried dimensions/mo',
  aiGateway: 'Free (pass-through)',
  pages: '500 builds/mo + 100GB bandwidth',
  queues: '1M operations/mo',
  workflows: 'Beta (free)',
  workersAI: 'Usage-based (10K neurons/day free)',
};

/**
 * Default thresholds (fallback if KV not configured)
 */
const DEFAULT_THRESHOLDS: AlertThresholds = {
  workers: { warningPct: 50, highPct: 75, criticalPct: 90, absoluteMax: 5, enabled: true },
  d1: { warningPct: 40, highPct: 60, criticalPct: 80, absoluteMax: 20, enabled: true },
  kv: { warningPct: 50, highPct: 75, criticalPct: 90, absoluteMax: 5, enabled: true },
  r2: { warningPct: 50, highPct: 75, criticalPct: 90, absoluteMax: 20, enabled: true },
  durableObjects: { warningPct: 50, highPct: 75, criticalPct: 90, absoluteMax: 10, enabled: true },
  vectorize: { warningPct: 50, highPct: 75, criticalPct: 90, absoluteMax: 5, enabled: true },
  aiGateway: { warningPct: 50, highPct: 75, criticalPct: 90, absoluteMax: 0, enabled: false },
  pages: { warningPct: 50, highPct: 75, criticalPct: 90, absoluteMax: 5, enabled: true },
  queues: { warningPct: 50, highPct: 75, criticalPct: 90, absoluteMax: 5, enabled: true },
  workflows: { warningPct: 50, highPct: 75, criticalPct: 90, absoluteMax: 0, enabled: false },
};

/**
 * Slack rate limit: 1 alert per resource per hour
 */
const SLACK_RATE_LIMIT_TTL = 3600;

/**
 * Email rate limit: 1 alert per resource per 4 hours
 */
const EMAIL_RATE_LIMIT_TTL = 14400;

export default {
  /**
   * Cron trigger handler
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const log = createLogger({ worker: 'platform-sentinel', featureId: MONITOR_COST_SPIKE });
    log.info('Cron triggered', { scheduled_time: new Date(event.scheduledTime).toISOString() });

    // Gatus heartbeat is pinged on success/fail only (no /start support)

    // CRITICAL: Capture raw Fetcher bindings BEFORE SDK wrapping.
    // The SDK triple-proxy wraps .fetch() in async wrapper causing "Illegal invocation"
    // on native Cloudflare Fetcher bindings. See platform-alert-router.ts for same pattern.
    _rawNotificationsApi = env.NOTIFICATIONS_API;
    _rawErrorCollector = env.ERROR_COLLECTOR;

    try {
      // Wrap with Platform SDK for usage tracking and circuit breaker protection
      const trackedEnv = withCronBudget(env, MONITOR_COST_SPIKE, {
        ctx,
        cronExpression: '*/15 * * * *', // Every 15 minutes
      });

      // 1. Gap detection - check for missing hourly snapshots (ALWAYS runs, independent of cost data)
      // This was previously step 8, but must run regardless of cache state (fix for task-312)
      const gaps = await detectGaps(trackedEnv, log);
      if (gaps.severity !== 'ok') {
        // Store gap report for aggregation by platform-auditor
        await storeGapReport(trackedEnv, gaps, log);
        // Send alerts
        await alertGaps(trackedEnv, gaps, log);
        await alertGapsEmail(trackedEnv, gaps, log);
      }

      // 1b. Per-project gap detection - check resource_usage_snapshots coverage
      // Creates GitHub issues in correct repo when coverage drops below 90%
      const projectGaps = await detectProjectGaps(trackedEnv, log);
      if (projectGaps.length > 0 && _rawErrorCollector) {
        log.info('Detected per-project gaps, sending to error-collector', {
          projectCount: projectGaps.length,
        });
        for (const gap of projectGaps) {
          try {
            const response = await _rawErrorCollector.fetch(
              'https://error-collector.internal/gap-alerts',
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  project: gap.project,
                  hoursWithData: gap.hoursWithData,
                  expectedHours: gap.expectedHours,
                  coveragePct: gap.coveragePct,
                  missingHours: gap.missingHours,
                  repository: gap.repository,
                }),
              }
            );
            const result = await response.json();
            log.debug('Gap alert result', { project: gap.project, result });
          } catch (e) {
            log.error('Failed to send gap alert to error-collector', e, {
              project: gap.project,
            });
          }
        }
      }

      // 2. Check for stale heartbeats (DO health monitoring) - also runs always
      await checkStaleHeartbeats(trackedEnv, log);

      // 3. Load thresholds from KV (or use defaults)
      const thresholds = await loadThresholds(trackedEnv, log);

      // 4. Fetch current costs from Usage API (optional - may be cache cold)
      const currentCosts = await fetchCurrentCosts(trackedEnv, log);
      if (currentCosts) {
        // 5. Load previous costs from KV (for delta comparison)
        const previousCosts = await loadPreviousCosts(trackedEnv, log);

        // 6. Evaluate alerts (async — queries D1 for per-project/feature attribution)
        const alerts = await evaluateAlerts(currentCosts, previousCosts, thresholds, trackedEnv, log);
        log.info('Evaluated potential alerts', { alert_count: alerts.length });

        // 7. Send alerts (with rate limiting)
        for (const alert of alerts) {
          await sendAlerts(alert, trackedEnv, log);
        }

        // 8. Store current costs for next comparison
        await storeCosts(currentCosts, trackedEnv, log);
      } else {
        // Not an error - cache may be cold (expected during cold starts or low traffic)
        log.debug('No cost data available (cache cold), skipping cost alerting', {
          hint: 'Call GET /usage on platform-usage to populate cache',
        });
      }

      // 9. Send Platform SDK heartbeat
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await health(HEARTBEAT_HEALTH, env.PLATFORM_CACHE as any, env.PLATFORM_TELEMETRY, ctx);
      log.debug('Heartbeat sent');

      // Complete SDK tracking
      await completeTracking(trackedEnv);

      // Signal success to Gatus heartbeat
      pingHeartbeat(ctx, env.GATUS_HEARTBEAT_URL, env.GATUS_TOKEN, true);

      log.info('Completed successfully');
    } catch (error) {
      // Handle circuit breaker gracefully - skip execution
      if (error instanceof CircuitBreakerError) {
        log.warn('Circuit breaker STOP', error, { reason: error.reason });
        return;
      }

      // Signal failure to Gatus heartbeat
      pingHeartbeat(ctx, env.GATUS_HEARTBEAT_URL, env.GATUS_TOKEN, false);

      log.error('Error', error);
    }
  },

  /**
   * HTTP handler (for manual trigger / health check)
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check bypasses SDK for lightweight responses
    if (url.pathname === '/health') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          service: 'platform-sentinel',
          timestamp: new Date().toISOString(),
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Create logger with trace context from request
    const traceContext = createTraceContext(request, env);
    const log = createLoggerFromRequest(request, env, 'platform-sentinel', MONITOR_COST_SPIKE);

    log.info('Request received', {
      method: request.method,
      path: url.pathname,
      traceId: traceContext.traceId,
    });

    try {
      // Wrap with Platform SDK for usage tracking
      const trackedEnv = withFeatureBudget(env, MONITOR_COST_SPIKE, { ctx });

      if (url.pathname === '/trigger' && request.method === 'POST') {
        // Manual trigger (for testing)
        log.info('Manual trigger requested');
        const event = {
          scheduledTime: Date.now(),
          cron: '*/15 * * * *',
          noRetry: () => {},
        } as unknown as ScheduledEvent;
        await this.scheduled(event, env, ctx);
        await completeTracking(trackedEnv);
        log.info('Manual trigger completed');
        return new Response(
          JSON.stringify({ status: 'triggered', traceId: traceContext.traceId }),
          {
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      await completeTracking(trackedEnv);
      return new Response(
        JSON.stringify({
          service: 'platform-sentinel',
          endpoints: ['/health', '/trigger (POST)'],
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    } catch (error) {
      if (error instanceof CircuitBreakerError) {
        log.warn('Circuit breaker tripped', error, {
          path: url.pathname,
          reason: error.reason,
        });
        return new Response(
          JSON.stringify({
            error: 'Service temporarily unavailable',
            code: 'CIRCUIT_BREAKER',
            traceId: traceContext.traceId,
          }),
          {
            status: 503,
            headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
          }
        );
      }

      // Log full error with stack trace for debugging
      log.error('Request failed', error, {
        path: url.pathname,
        method: request.method,
        traceId: traceContext.traceId,
      });

      return new Response(
        JSON.stringify({
          error: 'Internal server error',
          traceId: traceContext.traceId,
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
  },
};

/**
 * Load thresholds from KV
 */
async function loadThresholds(env: Env, log: Logger): Promise<AlertThresholds> {
  try {
    const stored = await env.PLATFORM_CACHE.get('alert-thresholds:config');
    if (stored) {
      const parsed = JSON.parse(stored);
      // Merge with defaults to ensure all services have thresholds
      return { ...DEFAULT_THRESHOLDS, ...parsed };
    }
  } catch (error) {
    log.error('Failed to load thresholds from KV', error);
  }
  return DEFAULT_THRESHOLDS;
}

/**
 * Get cache key with hourly timestamp (must match usage-api.ts)
 * Format: usage:{period}:{project}:{hourTimestamp}
 */
function getUsageCacheKey(period: string, project: string, hourOffset = 0): string {
  const hourTimestamp = Math.floor(Date.now() / (60 * 60 * 1000)) + hourOffset;
  return `usage:${period}:${project}:${hourTimestamp}`;
}

/**
 * Fetch current costs from Usage API
 *
 * Tries current hour's cache first, then falls back to previous hour's cache.
 * Cache is populated by platform-usage /usage endpoint calls (30-min TTL).
 */
async function fetchCurrentCosts(env: Env, log: Logger): Promise<CostBreakdown | null> {
  const currentCacheKey = getUsageCacheKey('30d', 'all', 0);
  const prevCacheKey = getUsageCacheKey('30d', 'all', -1);

  try {
    // Try current hour's cache first
    let usageData = await env.PLATFORM_CACHE.get(currentCacheKey);
    let cacheKeyUsed = currentCacheKey;

    if (!usageData) {
      // Fall back to previous hour's cache (covers cache cold starts)
      usageData = await env.PLATFORM_CACHE.get(prevCacheKey);
      cacheKeyUsed = prevCacheKey;

      if (!usageData) {
        // KV cache is cold — fall back to computing costs from D1
        log.info('KV cache cold, falling back to D1 cost computation', {
          current_key: currentCacheKey,
          prev_key: prevCacheKey,
        });
        return fetchCostsFromD1(env, log);
      }

      log.debug('Using previous hour cache', { cache_key: prevCacheKey });
    }

    // Validate the data before parsing
    if (typeof usageData !== 'string' || usageData.trim() === '') {
      log.warn('Invalid cache data (empty or non-string)', {
        cache_key: cacheKeyUsed,
        data_type: typeof usageData,
        data_length: usageData?.length ?? 0,
      });
      return fetchCostsFromD1(env, log);
    }

    // Parse JSON with specific error handling
    let usage: { costs?: CostBreakdown };
    try {
      usage = JSON.parse(usageData);
    } catch (parseError) {
      log.warn('Cache data is not valid JSON', {
        cache_key: cacheKeyUsed,
        data_preview: usageData.slice(0, 100),
        error: parseError instanceof Error ? parseError.message : String(parseError),
      });
      return fetchCostsFromD1(env, log);
    }

    // Validate the costs property exists
    if (!usage.costs) {
      log.warn('Cache data missing costs property', {
        cache_key: cacheKeyUsed,
        available_keys: Object.keys(usage),
      });
      return fetchCostsFromD1(env, log);
    }

    return usage.costs;
  } catch (error) {
    // This catch is for unexpected errors (KV failures, etc.)
    log.error('Failed to fetch costs from KV', error, {
      current_key: currentCacheKey,
      prev_key: prevCacheKey,
    });
    return fetchCostsFromD1(env, log);
  }
}

/**
 * Compute MTD cost breakdown directly from D1 hourly_usage_snapshots.
 * Used as fallback when KV cache is cold (no recent dashboard API calls).
 * Sums the per-service cost columns already stored in each hourly row.
 */
async function fetchCostsFromD1(env: Env, log: Logger): Promise<CostBreakdown | null> {
  try {
    const billing = getBillingPeriod();
    const result = await env.PLATFORM_DB.prepare(`
      SELECT
        SUM(COALESCE(workers_cost_usd, 0)) as workers,
        SUM(COALESCE(d1_cost_usd, 0)) as d1,
        SUM(COALESCE(kv_cost_usd, 0)) as kv,
        SUM(COALESCE(r2_cost_usd, 0)) as r2,
        SUM(COALESCE(do_cost_usd, 0)) as durableObjects,
        SUM(COALESCE(vectorize_cost_usd, 0)) as vectorize,
        SUM(COALESCE(aigateway_cost_usd, 0)) as aiGateway,
        SUM(COALESCE(workersai_cost_usd, 0)) as workersAI,
        SUM(COALESCE(pages_cost_usd, 0)) as pages,
        SUM(COALESCE(queues_cost_usd, 0)) as queues,
        SUM(COALESCE(workflows_cost_usd, 0)) as workflows,
        SUM(COALESCE(total_cost_usd, 0)) as total
      FROM hourly_usage_snapshots
      WHERE project = 'all' AND DATE(snapshot_hour) >= ?
    `).bind(billing.start).first<CostBreakdown>();

    if (!result) {
      log.warn('D1 fallback returned no data');
      return null;
    }

    log.info('Computed costs from D1 fallback', {
      total: result.total,
      billing_start: billing.start,
      source: 'd1-fallback',
    });

    return result;
  } catch (error) {
    log.error('D1 fallback cost computation failed', error);
    return null;
  }
}

/**
 * Load previous costs from KV
 */
async function loadPreviousCosts(env: Env, log: Logger): Promise<CostBreakdown | null> {
  try {
    const stored = await env.PLATFORM_CACHE.get('platform-sentinel:previous-costs');
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (error) {
    log.error('Failed to load previous costs', error);
  }
  return null;
}

/**
 * Store current costs for next comparison
 */
async function storeCosts(costs: CostBreakdown, env: Env, log: Logger): Promise<void> {
  try {
    await env.PLATFORM_CACHE.put('platform-sentinel:previous-costs', JSON.stringify(costs), {
      expirationTtl: 86400 * 7, // Keep for 7 days
    });
  } catch (error) {
    log.error('Failed to store costs', error);
  }
}

// =============================================================================
// PER-PROJECT / PER-FEATURE ATTRIBUTION
// =============================================================================

/**
 * Map service names to resource_usage_snapshots config for per-project cost attribution.
 * Cost expressions use the same pricing as PRICING_TIERS in workers/lib/costs.ts.
 * Note: allowances are account-level so NOT subtracted here — this shows proportional attribution.
 */
const SERVICE_RESOURCE_CONFIG: Record<string, { resourceType: string; costExpr: string }> = {
  workers: {
    resourceType: 'worker',
    costExpr: `SUM(COALESCE(requests, 0)) / 1000000.0 * 0.30 + SUM(COALESCE(cpu_time_ms, 0)) / 1000000.0 * 0.02`,
  },
  d1: {
    resourceType: 'd1',
    costExpr: `SUM(COALESCE(rows_read, 0)) / 1000000000.0 * 0.001 + SUM(COALESCE(rows_written, 0)) / 1000000.0 * 1.00`,
  },
  kv: {
    resourceType: 'kv',
    costExpr: `SUM(COALESCE(reads, 0)) / 1000000.0 * 0.50 + SUM(COALESCE(writes, 0)) / 1000000.0 * 5.00 + SUM(COALESCE(deletes, 0)) / 1000000.0 * 5.00`,
  },
  r2: {
    resourceType: 'r2',
    costExpr: `SUM(COALESCE(class_a_ops, 0)) / 1000000.0 * 4.50 + SUM(COALESCE(class_b_ops, 0)) / 1000000.0 * 0.36`,
  },
  durableObjects: {
    resourceType: 'do',
    costExpr: `SUM(COALESCE(requests, 0)) / 1000000.0 * 0.15 + SUM(COALESCE(gb_seconds, 0)) / 1000000.0 * 12.50`,
  },
  queues: {
    resourceType: 'queues',
    costExpr: `(SUM(COALESCE(reads, 0)) + SUM(COALESCE(writes, 0))) / 1000000.0 * 0.04`,
  },
  // vectorize: excluded — resource_usage_snapshots only stores vector storage, not queried dimensions
  // pages: excluded — no meaningful per-project cost metrics
  // aiGateway: excluded — free service
  // workersAI: excluded — neurons tracked but not per-project in resource_usage_snapshots
};

/**
 * Map service resource names to the feature_usage_daily metric column(s).
 * These represent the primary usage metric for each service.
 */
const SERVICE_FEATURE_COLUMN: Record<string, string> = {
  workers: 'requests',
  d1: 'd1_writes',
  kv: 'kv_writes',
  r2: 'r2_class_a',
  durableObjects: 'do_requests',
  pages: 'requests',
  queues: 'queue_messages',
  workersAI: 'ai_neurons',
};

/**
 * Query per-project cost breakdown for a specific service.
 * Uses resource_usage_snapshots (which has real per-project, per-resource data)
 * and calculates costs on-the-fly using pricing constants.
 */
async function queryTopProjects(
  env: Env,
  serviceName: string,
  billingStart: string,
  log: Logger
): Promise<Array<{ project: string; cost: number; pctOfTotal: number }>> {
  const config = SERVICE_RESOURCE_CONFIG[serviceName];
  if (!config) return []; // Vectorize, Pages, AI Gateway — no per-project data available

  try {
    const result = await env.PLATFORM_DB.prepare(
      `SELECT project, (${config.costExpr}) as cost
       FROM resource_usage_snapshots
       WHERE resource_type = ?
         AND snapshot_hour >= ?
         AND project NOT IN ('_unattributed', 'unknown')
       GROUP BY project
       HAVING cost > 0.001
       ORDER BY cost DESC
       LIMIT 5`
    )
      .bind(config.resourceType, billingStart)
      .all<{ project: string; cost: number }>();

    if (!result.results || result.results.length === 0) return [];

    const totalCost = result.results.reduce((sum, r) => sum + r.cost, 0);
    return result.results.map((r) => ({
      project: r.project,
      cost: r.cost,
      pctOfTotal: totalCost > 0 ? Math.round((r.cost / totalCost) * 100) : 0,
    }));
  } catch (error) {
    log.error('Failed to query top projects', error, { service: serviceName });
    return [];
  }
}

/**
 * Query per-feature usage breakdown for a specific service.
 * Returns top features by usage metric from feature_usage_daily.
 */
async function queryTopFeatures(
  env: Env,
  serviceName: string,
  log: Logger
): Promise<Array<{ featureKey: string; usage: number; pctOfTotal: number }>> {
  const usageCol = SERVICE_FEATURE_COLUMN[serviceName];
  if (!usageCol) return [];

  try {
    const result = await env.PLATFORM_DB.prepare(
      `SELECT feature_key, SUM(${usageCol}) as usage
       FROM feature_usage_daily
       WHERE usage_date >= date('now', '-7 days')
         AND ${usageCol} > 0
       GROUP BY feature_key
       ORDER BY usage DESC
       LIMIT 5`
    )
      .all<{ feature_key: string; usage: number }>();

    if (!result.results || result.results.length === 0) return [];

    const totalUsage = result.results.reduce((sum, r) => sum + r.usage, 0);
    return result.results.map((r) => ({
      featureKey: r.feature_key,
      usage: r.usage,
      pctOfTotal: totalUsage > 0 ? Math.round((r.usage / totalUsage) * 100) : 0,
    }));
  } catch (error) {
    log.error('Failed to query top features', error, { service: serviceName });
    return [];
  }
}

// =============================================================================
// ALLOWANCE STATUS (Direct D1 query for accurate usage-vs-allowance)
// =============================================================================

/**
 * Per-metric usage breakdown with allowance comparison.
 */
interface UsageMetricBreakdown {
  metric: string;
  label: string;
  used: number;
  allowance: number;
  pctOfAllowance: number;
  overageUnits: number;
  overageCost: number;
}

/**
 * Allowance status for a service — determines whether alerts should fire.
 */
interface AllowanceStatus {
  /** True if ALL metrics for this service are within their plan allowance */
  withinAllowance: boolean;
  /** Per-metric breakdown */
  metrics: UsageMetricBreakdown[];
  /** Total overage cost (sum of all metric overages) */
  totalOverageCost: number;
}

/**
 * Service-to-metric definitions for allowance checking.
 * Maps each service to its D1 columns, plan allowances, and pricing.
 */
const SERVICE_ALLOWANCE_METRICS: Record<string, Array<{
  metric: string;
  label: string;
  sqlExpr: string;
  allowance: number;
  pricePerUnit: number;
  unitDivisor: number;
}>> = {
  d1: [
    { metric: 'rows_read', label: 'Rows Read', sqlExpr: 'SUM(COALESCE(d1_rows_read, 0))', allowance: PAID_ALLOWANCES.d1.rowsRead, pricePerUnit: PRICING_TIERS.d1.rowsReadPerBillion, unitDivisor: 1_000_000_000 },
    { metric: 'rows_written', label: 'Rows Written', sqlExpr: 'SUM(COALESCE(d1_rows_written, 0))', allowance: PAID_ALLOWANCES.d1.rowsWritten, pricePerUnit: PRICING_TIERS.d1.rowsWrittenPerMillion, unitDivisor: 1_000_000 },
  ],
  kv: [
    { metric: 'reads', label: 'Reads', sqlExpr: 'SUM(COALESCE(kv_reads, 0))', allowance: PAID_ALLOWANCES.kv.reads, pricePerUnit: PRICING_TIERS.kv.readsPerMillion, unitDivisor: 1_000_000 },
    { metric: 'writes', label: 'Writes', sqlExpr: 'SUM(COALESCE(kv_writes, 0))', allowance: PAID_ALLOWANCES.kv.writes, pricePerUnit: PRICING_TIERS.kv.writesPerMillion, unitDivisor: 1_000_000 },
    { metric: 'deletes', label: 'Deletes', sqlExpr: 'SUM(COALESCE(kv_deletes, 0))', allowance: PAID_ALLOWANCES.kv.deletes, pricePerUnit: PRICING_TIERS.kv.deletesPerMillion, unitDivisor: 1_000_000 },
    { metric: 'list_ops', label: 'List Ops', sqlExpr: 'SUM(COALESCE(kv_list_ops, 0))', allowance: PAID_ALLOWANCES.kv.lists, pricePerUnit: PRICING_TIERS.kv.listsPerMillion, unitDivisor: 1_000_000 },
  ],
  r2: [
    { metric: 'class_a', label: 'Class A Ops', sqlExpr: 'SUM(COALESCE(r2_class_a_ops, 0))', allowance: PAID_ALLOWANCES.r2.classA, pricePerUnit: PRICING_TIERS.r2.classAPerMillion, unitDivisor: 1_000_000 },
    { metric: 'class_b', label: 'Class B Ops', sqlExpr: 'SUM(COALESCE(r2_class_b_ops, 0))', allowance: PAID_ALLOWANCES.r2.classB, pricePerUnit: PRICING_TIERS.r2.classBPerMillion, unitDivisor: 1_000_000 },
    { metric: 'storage', label: 'Storage', sqlExpr: 'MAX(COALESCE(r2_storage_bytes, 0))', allowance: PAID_ALLOWANCES.r2.storage, pricePerUnit: PRICING_TIERS.r2.storagePerGbMonth, unitDivisor: 1_000_000_000 },
  ],
  durableObjects: [
    { metric: 'requests', label: 'Requests', sqlExpr: 'SUM(COALESCE(do_requests, 0))', allowance: PAID_ALLOWANCES.durableObjects.requests, pricePerUnit: PRICING_TIERS.durableObjects.requestsPerMillion, unitDivisor: 1_000_000 },
    { metric: 'gb_seconds', label: 'GB-seconds', sqlExpr: 'MAX(COALESCE(do_gb_seconds, 0))', allowance: PAID_ALLOWANCES.durableObjects.gbSeconds, pricePerUnit: PRICING_TIERS.durableObjects.gbSecondsPerMillion, unitDivisor: 1_000_000 },
  ],
  vectorize: [
    { metric: 'queried_dimensions', label: 'Queried Dimensions', sqlExpr: 'SUM(COALESCE(vectorize_queries, 0))', allowance: PAID_ALLOWANCES.vectorize.queriedDimensions, pricePerUnit: PRICING_TIERS.vectorize.queriedDimensionsPerMillion, unitDivisor: 1_000_000 },
    { metric: 'stored_dimensions', label: 'Stored Dimensions', sqlExpr: 'MAX(COALESCE(vectorize_vectors_stored, 0))', allowance: PAID_ALLOWANCES.vectorize.storedDimensions, pricePerUnit: PRICING_TIERS.vectorize.storedDimensionsPerMillion, unitDivisor: 1_000_000 },
  ],
  workers: [
    { metric: 'requests', label: 'Requests', sqlExpr: 'SUM(COALESCE(workers_requests, 0))', allowance: 10_000_000, pricePerUnit: PRICING_TIERS.workers.requestsPerMillion, unitDivisor: 1_000_000 },
    { metric: 'cpu_ms', label: 'CPU Time (ms)', sqlExpr: 'SUM(COALESCE(workers_cpu_time_ms, 0))', allowance: 30_000_000, pricePerUnit: PRICING_TIERS.workers.cpuMsPerMillion, unitDivisor: 1_000_000 },
  ],
  queues: [
    { metric: 'operations', label: 'Operations', sqlExpr: 'SUM(COALESCE(queues_messages_produced, 0)) + SUM(COALESCE(queues_messages_consumed, 0))', allowance: PAID_ALLOWANCES.queues.operations, pricePerUnit: PRICING_TIERS.queues.operationsPerMillion, unitDivisor: 1_000_000 },
  ],
  // pages, workflows — no meaningful allowance thresholds for alerting
  // workersAI — 10K neurons/day free (daily reset, not monthly; too complex for MTD SUM check)
};

/**
 * Query D1 for actual MTD usage per service and compare against plan allowances.
 * Returns definitive allowance status — this is the ONLY source of truth for
 * whether a service has exceeded its Workers Paid plan allowance.
 */
async function queryAllowanceStatus(
  env: Env,
  serviceName: string,
  billingStart: string,
  log: Logger
): Promise<AllowanceStatus> {
  const metricDefs = SERVICE_ALLOWANCE_METRICS[serviceName];
  if (!metricDefs || metricDefs.length === 0) {
    // Services without defined allowances (pages, queues) — always "within"
    return { withinAllowance: true, metrics: [], totalOverageCost: 0 };
  }

  try {
    // Build a single query for all metrics of this service
    const selectExprs = metricDefs.map((m, i) => `${m.sqlExpr} as metric_${i}`).join(', ');
    const sql = `SELECT ${selectExprs} FROM hourly_usage_snapshots WHERE project = 'all' AND DATE(snapshot_hour) >= ?`;

    const result = await env.PLATFORM_DB.prepare(sql)
      .bind(billingStart)
      .first<Record<string, number>>();

    if (!result) {
      return { withinAllowance: true, metrics: [], totalOverageCost: 0 };
    }

    const metrics: UsageMetricBreakdown[] = metricDefs.map((def, i) => {
      const used = result[`metric_${i}`] ?? 0;
      const pctOfAllowance = def.allowance > 0 ? (used / def.allowance) * 100 : 0;
      const overageUnits = Math.max(0, used - def.allowance);
      const overageCost = (overageUnits / def.unitDivisor) * def.pricePerUnit;
      return {
        metric: def.metric,
        label: def.label,
        used,
        allowance: def.allowance,
        pctOfAllowance: Math.round(pctOfAllowance * 10) / 10,
        overageUnits,
        overageCost: Math.round(overageCost * 100) / 100,
      };
    });

    const withinAllowance = metrics.every((m) => m.used <= m.allowance);
    const totalOverageCost = metrics.reduce((sum, m) => sum + m.overageCost, 0);

    return {
      withinAllowance,
      metrics,
      totalOverageCost: Math.round(totalOverageCost * 100) / 100,
    };
  } catch (error) {
    log.error('Failed to query allowance status', error, { service: serviceName });
    return { withinAllowance: true, metrics: [], totalOverageCost: 0 };
  }
}

/**
 * Compute billing period for the current month.
 * Cloudflare bills from the 1st to the last day of each calendar month.
 */
function getBillingPeriod(): {
  start: string;
  end: string;
  daysElapsed: number;
  daysTotal: number;
} {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 0)); // last day of current month
  const daysTotal = end.getUTCDate();
  const daysElapsed = now.getUTCDate();
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
    daysElapsed,
    daysTotal,
  };
}

/**
 * Evaluate alerts based on thresholds.
 *
 * Only fires high/critical email alerts when a service EXCEEDS its Workers Paid
 * plan allowance (i.e. has real overage cost). Usage spikes within the free
 * allowance are downgraded to warning-level (Slack only, no email).
 */
async function evaluateAlerts(
  current: CostBreakdown,
  previous: CostBreakdown | null,
  thresholds: AlertThresholds,
  env: Env,
  log: Logger
): Promise<CostSpikeAlert[]> {
  const alerts: CostSpikeAlert[] = [];
  const billing = getBillingPeriod();

  const services: (keyof CostBreakdown)[] = [
    'workers',
    'd1',
    'kv',
    'r2',
    'durableObjects',
    'vectorize',
    'pages',
    'queues',
    'workersAI',
  ];

  for (const service of services) {
    if (service === 'total') continue;

    const threshold = thresholds[service];
    if (!threshold || !threshold.enabled) continue;

    // STEP 1: Check actual usage against plan allowance via D1 query.
    // This is the single source of truth — NOT the cached cost data.
    const allowanceStatus = await queryAllowanceStatus(env, service, billing.start, log);

    // STEP 2: If ALL metrics for this service are within plan allowance, SKIP entirely.
    // No alert should fire for services covered by the Workers Paid plan inclusion.
    if (allowanceStatus.withinAllowance) {
      log.debug('Service within plan allowance, skipping alert', {
        service,
        metrics: allowanceStatus.metrics.map((m) => `${m.label}: ${m.pctOfAllowance}%`),
      });
      continue;
    }

    // STEP 3: We have a real overage — use the D1-derived overage cost, not cached cost.
    const overageCost = allowanceStatus.totalOverageCost;
    const previousCost = previous ? previous[service] : 0;
    const costDeltaPct = previousCost > 0 ? ((overageCost - previousCost) / previousCost) * 100 : 0;

    // Determine threshold level based on actual overage cost vs absoluteMax
    let level: CostSpikeAlert['thresholdLevel'] = 'normal';
    const costPercentOfMax =
      threshold.absoluteMax > 0 ? (overageCost / threshold.absoluteMax) * 100 : 0;

    if (costPercentOfMax >= threshold.criticalPct) {
      level = 'critical';
    } else if (costPercentOfMax >= threshold.highPct) {
      level = 'high';
    } else if (costPercentOfMax >= threshold.warningPct) {
      level = 'warning';
    }

    // Alert conditions:
    // 1. Overage cost > $0.10 AND threshold level is 'warning' or higher
    // 2. Overage cost exceeds absolute max
    const shouldAlert =
      (overageCost > 0.10 && level !== 'normal') ||
      (threshold.absoluteMax > 0 && overageCost > threshold.absoluteMax);

    if (shouldAlert) {
      // Upgrade to critical if overage cost exceeds max
      if (threshold.absoluteMax > 0 && overageCost > threshold.absoluteMax) {
        level = 'critical';
      }

      // Query per-project and per-feature attribution (non-blocking)
      const [topProjects, topFeatures] = await Promise.all([
        queryTopProjects(env, service, billing.start, log),
        queryTopFeatures(env, service, log),
      ]);

      alerts.push({
        id: crypto.randomUUID(),
        serviceType: formatServiceName(service),
        resourceName: service,
        currentCost: overageCost,
        previousCost,
        costDeltaPct,
        costPercentOfMax,
        thresholdLevel: level,
        absoluteMax: threshold.absoluteMax,
        timestamp: new Date().toISOString(),
        billingPeriodStart: billing.start,
        billingPeriodEnd: billing.end,
        billingDaysElapsed: billing.daysElapsed,
        billingDaysTotal: billing.daysTotal,
        monthlyAllowance: SERVICE_ALLOWANCE_DESCRIPTIONS[service] ?? 'N/A',
        isWithinAllowance: false,
        overageCost,
        topProjects,
        topFeatures,
        usageBreakdown: allowanceStatus.metrics,
      });
    }
  }

  return alerts;
}

/**
 * Send alerts via Slack, Email, and Dashboard notifications (with rate limiting)
 */
async function sendAlerts(alert: CostSpikeAlert, env: Env, log: Logger): Promise<void> {
  const alertKey = `cost-spike:${alert.resourceName}`;

  // Check Slack rate limit
  const slackKey = `slack:${alertKey}`;
  const slackSent = await env.PLATFORM_ALERTS.get(slackKey);

  if (!slackSent && env.SLACK_WEBHOOK_URL) {
    const slackResult = await sendSlackAlert(alert, env);
    if (slackResult.success) {
      await env.PLATFORM_ALERTS.put(slackKey, new Date().toISOString(), {
        expirationTtl: SLACK_RATE_LIMIT_TTL,
      });
      log.info('Sent Slack alert', { resource: alert.resourceName });
    } else {
      log.error('Slack alert failed', { resource: alert.resourceName, error: slackResult.error });
    }
  } else if (slackSent) {
    log.debug('Slack rate limited', { resource: alert.resourceName });
  }

  // Check Email rate limit (only for high/critical that EXCEED plan allowance)
  // Within-allowance alerts are capped at 'warning' by evaluateAlerts(), but guard explicitly
  if ((alert.thresholdLevel === 'high' || alert.thresholdLevel === 'critical') && !alert.isWithinAllowance) {
    const emailKey = `email:${alertKey}`;
    const emailSent = await env.PLATFORM_ALERTS.get(emailKey);

    if (!emailSent && env.RESEND_API_KEY && env.ALERT_EMAIL_TO) {
      const emailResult = await sendEmailAlert(alert, env);
      if (emailResult.success) {
        await env.PLATFORM_ALERTS.put(emailKey, new Date().toISOString(), {
          expirationTtl: EMAIL_RATE_LIMIT_TTL,
        });
        log.info('Sent email alert', { resource: alert.resourceName });
      } else {
        log.error('Email alert failed', { resource: alert.resourceName, error: emailResult.error });
      }
    } else if (emailSent) {
      log.debug('Email rate limited', { resource: alert.resourceName });
    }
  }

  // Create dashboard notification (using same rate limit as Slack)
  if (!slackSent && _rawNotificationsApi) {
    await createCostNotification(alert, env, log);
  }
}

/**
 * Create dashboard notification for cost alert
 */
async function createCostNotification(
  alert: CostSpikeAlert,
  env: Env,
  log: Logger
): Promise<void> {
  if (!_rawNotificationsApi) return;

  // Map threshold level to notification priority
  const priorityMap: Record<CostSpikeAlert['thresholdLevel'], string> = {
    critical: 'critical',
    high: 'high',
    warning: 'medium',
    normal: 'low',
  };

  // Map threshold level to category
  const categoryMap: Record<CostSpikeAlert['thresholdLevel'], string> = {
    critical: 'error',
    high: 'error',
    warning: 'warning',
    normal: 'info',
  };

  try {
    const resp = await _rawNotificationsApi!.fetch(
      'https://platform-notifications.internal/notifications',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: categoryMap[alert.thresholdLevel],
          source: 'sentinel',
          source_id: alert.id,
          title: `${alert.serviceType}: ${formatCurrency(alert.overageCost)} overage`,
          description: `${alert.serviceType} has exceeded plan allowance. Overage cost: ${formatCurrency(alert.overageCost)} (threshold: ${formatCurrency(alert.absoluteMax)})`,
          priority: priorityMap[alert.thresholdLevel],
          action_url: '/costs',
          action_label: 'View Costs',
          project: 'platform',
        }),
      }
    );
    const body = await resp.text();
    if (resp.ok) {
      log.debug('Created cost notification', { resource: alert.resourceName });
    } else {
      log.warn('Cost notification failed', { status: resp.status, body });
    }
  } catch (error) {
    // Non-blocking - log and continue
    log.error('Failed to create cost notification', error);
  }
}

/**
 * Send Slack alert
 *
 * Includes rich context for Claude Code follow-up:
 * - Service breakdown with operation types
 * - Investigation commands (D1, KV queries)
 * - Direct links to usage dashboard
 * - Historical context (percent of monthly max)
 */
async function sendSlackAlert(
  alert: CostSpikeAlert,
  env: Env
): Promise<{ success: boolean; error?: string }> {
  const emoji = getEmoji(alert.thresholdLevel);
  const colour = getColour(alert.thresholdLevel);
  const deltaText = formatPercentage(alert.costDeltaPct);

  // Build investigation commands based on service type
  const investigationCommands = getInvestigationCommands(alert.serviceType);

  // Build usage breakdown text for Slack
  const usageBreakdownText = alert.usageBreakdown.length > 0
    ? alert.usageBreakdown.map(m => {
        const status = m.pctOfAllowance > 100 ? ':red_circle:' : ':white_check_mark:';
        const overageText = m.overageCost > 0 ? ` \u2014 ${formatCurrency(m.overageCost)} overage` : '';
        return `${status} *${m.label}:* ${formatLargeNumber(m.used)} / ${formatLargeNumber(m.allowance)} (${m.pctOfAllowance}%)${overageText}`;
      }).join('\n')
    : '';

  const message = {
    text: `[${alert.thresholdLevel.toUpperCase()}] ${alert.serviceType}: ${formatCurrency(alert.overageCost)} overage`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${emoji} ${alert.serviceType}: ${formatCurrency(alert.overageCost)} overage`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Service:*\n${alert.serviceType}` },
          { type: 'mrkdwn', text: `*Billing Period:*\n${formatBillingPeriod(alert)}` },
          { type: 'mrkdwn', text: `*Overage Cost:*\n${formatCurrency(alert.overageCost)}` },
          { type: 'mrkdwn', text: `*Alert Threshold:*\n${formatCurrency(alert.absoluteMax)}` },
        ],
      },
      ...(usageBreakdownText ? [{
        type: 'section' as const,
        text: {
          type: 'mrkdwn' as const,
          text: `*Usage vs Plan Allowance:*\n${usageBreakdownText}`,
        },
      }] : []),
      ...(alert.topProjects.length > 0 ? [{
        type: 'section' as const,
        text: {
          type: 'mrkdwn' as const,
          text: `*Top Projects:*\n${alert.topProjects.map(p =>
            `\u2022 *${p.project}*: ${formatCurrency(p.cost)} (${p.pctOfTotal}%)`
          ).join('\n')}`,
        },
      }] : []),
      ...(alert.topFeatures.length > 0 ? [{
        type: 'section' as const,
        text: {
          type: 'mrkdwn' as const,
          text: `*Top Features:*\n${alert.topFeatures.map(f =>
            `\u2022 \`${f.featureKey}\` \u2014 ${f.usage.toLocaleString()} ops (${f.pctOfTotal}%)`
          ).join('\n')}`,
        },
      }] : []),
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Investigation Commands:*\n\`\`\`${investigationCommands}\`\`\``,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Alert ID: ${alert.id} | ${new Date(alert.timestamp).toLocaleString('en-AU')}`,
          },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Usage Dashboard',
              emoji: true,
            },
            url: `${DASHBOARD_URL}/usage`,
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Usage Monitor',
              emoji: true,
            },
            url: `${DASHBOARD_URL}/usage/monitor`,
          },
        ],
      },
    ],
    attachments: [
      {
        color: colour,
        fields: [
          {
            title: 'Action Required',
            value: getActionText(alert.thresholdLevel),
            short: false,
          },
        ],
      },
    ],
  };

  try {
    const response = await fetch(env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      const text = await response.text();
      return { success: false, error: `Slack error: ${response.status} ${text}` };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: `Slack error: ${error instanceof Error ? error.message : 'Unknown'}`,
    };
  }
}

/**
 * Send Email alert via Resend
 */
async function sendEmailAlert(
  alert: CostSpikeAlert,
  env: Env
): Promise<{ success: boolean; error?: string }> {
  const colour = getColour(alert.thresholdLevel);
  const billingPeriodText = formatBillingPeriod(alert);

  // Build usage breakdown HTML rows
  const usageBreakdownHtml = alert.usageBreakdown.length > 0 ? `
      <div style="margin-top: 15px;">
        <strong style="font-size: 14px;">Usage vs Plan Allowance</strong>
        <table style="width: 100%; border-collapse: collapse; margin-top: 8px;">
          <tr style="background: #f8f9fa;">
            <th style="padding: 8px; text-align: left; font-size: 12px;">Metric</th>
            <th style="padding: 8px; text-align: right; font-size: 12px;">Used</th>
            <th style="padding: 8px; text-align: right; font-size: 12px;">Allowance</th>
            <th style="padding: 8px; text-align: right; font-size: 12px;">%</th>
            <th style="padding: 8px; text-align: right; font-size: 12px;">Overage Cost</th>
          </tr>
          ${alert.usageBreakdown.map(m => {
            const pctColour = m.pctOfAllowance > 100 ? '#dc3545' : m.pctOfAllowance > 75 ? '#ffc107' : '#28a745';
            return `<tr style="border-bottom: 1px solid #eee;">
            <td style="padding: 8px; font-size: 13px;">${m.label}</td>
            <td style="padding: 8px; text-align: right; font-size: 13px;">${formatLargeNumber(m.used)}</td>
            <td style="padding: 8px; text-align: right; font-size: 13px; color: #666;">${formatLargeNumber(m.allowance)}</td>
            <td style="padding: 8px; text-align: right; font-size: 13px; font-weight: bold; color: ${pctColour};">${m.pctOfAllowance}%</td>
            <td style="padding: 8px; text-align: right; font-size: 13px;">${m.overageCost > 0 ? formatCurrency(m.overageCost) : '-'}</td>
          </tr>`;
          }).join('')}
        </table>
      </div>` : '';

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Usage Alert: ${alert.serviceType}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background-color: #f5f5f5;">
  <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
    <div style="background-color: ${colour}; color: white; padding: 20px;">
      <h1 style="margin: 0; font-size: 20px;">[${alert.thresholdLevel.toUpperCase()}] ${alert.serviceType}: ${formatCurrency(alert.overageCost)} overage</h1>
    </div>
    <div style="padding: 20px;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 10px 0; border-bottom: 1px solid #eee;"><strong>Service</strong></td><td style="padding: 10px 0; border-bottom: 1px solid #eee;">${alert.serviceType}</td></tr>
        <tr><td style="padding: 10px 0; border-bottom: 1px solid #eee;"><strong>Billing Period</strong></td><td style="padding: 10px 0; border-bottom: 1px solid #eee;">${billingPeriodText}</td></tr>
        <tr><td style="padding: 10px 0; border-bottom: 1px solid #eee;"><strong>Overage Cost</strong></td><td style="padding: 10px 0; border-bottom: 1px solid #eee; color: #dc3545; font-weight: bold;">${formatCurrency(alert.overageCost)}</td></tr>
        <tr><td style="padding: 10px 0; border-bottom: 1px solid #eee;"><strong>Alert Threshold</strong></td><td style="padding: 10px 0; border-bottom: 1px solid #eee;">${formatCurrency(alert.absoluteMax)}</td></tr>
        <tr><td style="padding: 10px 0;"><strong>Plan Allowance</strong></td><td style="padding: 10px 0;">${alert.monthlyAllowance}</td></tr>
      </table>
      <div style="margin-top: 15px; padding: 15px; background: #f8d7da; border-radius: 4px; border-left: 4px solid #dc3545;">
        <strong>&#9888; Plan Allowance Exceeded</strong>
        <p style="margin: 8px 0 0 0; color: #555; font-size: 14px;">You have exceeded your monthly plan allowance. Overage cost: ${formatCurrency(alert.overageCost)}</p>
      </div>
      ${usageBreakdownHtml}
      ${alert.topProjects.length > 0 ? `
      <div style="margin-top: 15px;">
        <strong style="font-size: 14px;">Top Projects by Cost</strong>
        <table style="width: 100%; border-collapse: collapse; margin-top: 8px;">
          ${alert.topProjects.map(p => `
          <tr>
            <td style="padding: 6px 0; width: 40%;"><strong>${p.project}</strong></td>
            <td style="padding: 6px 0; width: 25%; text-align: right;">${formatCurrency(p.cost)}</td>
            <td style="padding: 6px 8px; width: 35%;">
              <div style="background: #e9ecef; border-radius: 3px; height: 16px; position: relative;">
                <div style="background: #0d6efd; border-radius: 3px; height: 16px; width: ${Math.min(p.pctOfTotal, 100)}%; display: flex; align-items: center; justify-content: flex-end; padding-right: 4px;">
                  <span style="color: white; font-size: 10px; font-weight: bold;">${p.pctOfTotal}%</span>
                </div>
              </div>
            </td>
          </tr>`).join('')}
        </table>
      </div>` : ''}
      ${alert.topFeatures.length > 0 ? `
      <div style="margin-top: 15px;">
        <strong style="font-size: 14px;">Top Features by Usage</strong>
        <table style="width: 100%; border-collapse: collapse; margin-top: 8px;">
          ${alert.topFeatures.map(f => `
          <tr>
            <td style="padding: 6px 0; width: 40%; font-family: monospace; font-size: 12px;">${f.featureKey}</td>
            <td style="padding: 6px 0; width: 25%; text-align: right;">${f.usage.toLocaleString()} ops</td>
            <td style="padding: 6px 8px; width: 35%;">
              <div style="background: #e9ecef; border-radius: 3px; height: 16px; position: relative;">
                <div style="background: #6f42c1; border-radius: 3px; height: 16px; width: ${Math.min(f.pctOfTotal, 100)}%; display: flex; align-items: center; justify-content: flex-end; padding-right: 4px;">
                  <span style="color: white; font-size: 10px; font-weight: bold;">${f.pctOfTotal}%</span>
                </div>
              </div>
            </td>
          </tr>`).join('')}
        </table>
      </div>` : ''}
      <div style="margin-top: 15px; padding: 15px; background: #f8f9fa; border-radius: 4px;">
        <strong>Recommended Action:</strong>
        <p style="margin: 10px 0 0 0; color: #666;">${getActionText(alert.thresholdLevel)}</p>
      </div>
    </div>
    <div style="background: #f8f9fa; padding: 15px 20px; font-size: 12px; color: #666;">
      <p style="margin: 0;">Alert ID: ${alert.id}</p>
      <p style="margin: 5px 0 0 0;">Generated: ${new Date(alert.timestamp).toLocaleString('en-AU')}</p>
    </div>
  </div>
</body>
</html>`;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: ALERT_FROM_EMAIL,
        to: env.ALERT_EMAIL_TO,
        subject: `[${alert.thresholdLevel.toUpperCase()}] ${alert.serviceType}: ${formatCurrency(alert.overageCost)} overage (threshold: ${formatCurrency(alert.absoluteMax)})`,
        html,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return { success: false, error: `Resend error: ${response.status} ${text}` };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: `Resend error: ${error instanceof Error ? error.message : 'Unknown'}`,
    };
  }
}

/**
 * Format service name for display
 */
function formatServiceName(service: string): string {
  const names: Record<string, string> = {
    workers: 'Workers',
    d1: 'D1 Database',
    kv: 'KV Storage',
    r2: 'R2 Storage',
    durableObjects: 'Durable Objects',
    vectorize: 'Vectorize',
    aiGateway: 'AI Gateway',
    pages: 'Pages',
    queues: 'Queues',
    workflows: 'Workflows',
  };
  return names[service] || service;
}

/**
 * Get emoji for threshold level
 */
function getEmoji(level: CostSpikeAlert['thresholdLevel']): string {
  const emojis: Record<string, string> = {
    critical: ':rotating_light:',
    high: ':warning:',
    warning: ':yellow_circle:',
    normal: ':white_check_mark:',
  };
  return emojis[level] || ':bell:';
}

/**
 * Get colour for threshold level
 */
function getColour(level: CostSpikeAlert['thresholdLevel']): string {
  const colours: Record<string, string> = {
    critical: '#dc3545', // Red
    high: '#dc3545', // Red (same as critical)
    warning: '#ffc107', // Yellow
    normal: '#28a745', // Light green
  };
  return colours[level] || '#17a2b8';
}

/**
 * Get investigation commands based on service type
 * Provides Claude Code with actionable commands for follow-up
 */
function getInvestigationCommands(serviceType: string): string {
  const base = `# Query daily usage rollups
npx wrangler d1 execute platform-metrics --remote --command "SELECT snapshot_date, SUM(${serviceType}_cost_usd) as cost FROM daily_usage_rollups WHERE snapshot_date >= date('now', '-7 days') GROUP BY snapshot_date ORDER BY snapshot_date DESC"`;

  const serviceSpecific: Record<string, string> = {
    d1: `
# Check D1 per-feature usage
npx wrangler d1 execute platform-metrics --remote --command "SELECT feature_key, SUM(d1_writes) as writes, SUM(d1_reads) as reads FROM feature_usage_daily WHERE snapshot_date = date('now', '-1 day') GROUP BY feature_key ORDER BY writes DESC LIMIT 10"`,
    kv: `
# Check KV per-feature usage
npx wrangler d1 execute platform-metrics --remote --command "SELECT feature_key, SUM(kv_writes) as writes, SUM(kv_reads) as reads FROM feature_usage_daily WHERE snapshot_date = date('now', '-1 day') GROUP BY feature_key ORDER BY writes DESC LIMIT 10"`,
    workers: `
# Check Workers per-project usage
npx wrangler d1 execute platform-metrics --remote --command "SELECT project, SUM(workers_requests) as requests, SUM(workers_cpu_time) as cpu_ms FROM daily_usage_rollups WHERE snapshot_date = date('now', '-1 day') GROUP BY project ORDER BY requests DESC"`,
    vectorize: `
# Check Vectorize per-feature usage
npx wrangler d1 execute platform-metrics --remote --command "SELECT feature_key, SUM(vectorize_queries) as queries FROM feature_usage_daily WHERE snapshot_date = date('now', '-1 day') AND vectorize_queries > 0 GROUP BY feature_key ORDER BY queries DESC LIMIT 10"`,
  };

  return base + (serviceSpecific[serviceType] || '');
}

/**
 * Get action text for threshold level
 */
function getActionText(level: CostSpikeAlert['thresholdLevel']): string {
  switch (level) {
    case 'critical':
      return 'Investigate immediately - usage significantly exceeds budget';
    case 'high':
      return 'Review usage patterns and consider optimisation';
    case 'warning':
      return 'Monitor closely - approaching threshold';
    default:
      return 'No action required';
  }
}

/**
 * Format currency
 */
function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * Format percentage
 */
function formatPercentage(pct: number): string {
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

/**
 * Format large numbers with K/M/B suffixes for readability.
 */
function formatLargeNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

/**
 * Format billing period for display.
 * Example: "1 Feb - 28 Feb 2026 (Day 6 of 28)"
 */
function formatBillingPeriod(alert: CostSpikeAlert): string {
  const start = new Date(alert.billingPeriodStart + 'T00:00:00Z');
  const end = new Date(alert.billingPeriodEnd + 'T00:00:00Z');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const startStr = `${start.getUTCDate()} ${months[start.getUTCMonth()]}`;
  const endStr = `${end.getUTCDate()} ${months[end.getUTCMonth()]} ${end.getUTCFullYear()}`;
  return `${startStr} - ${endStr} (Day ${alert.billingDaysElapsed} of ${alert.billingDaysTotal})`;
}

// =============================================================================
// STALE HEARTBEAT DETECTION
// =============================================================================

/**
 * Stale threshold: 2x the default heartbeat interval (5 minutes).
 * Features that haven't sent a heartbeat in 15 minutes are considered stale.
 */
const STALE_THRESHOLD_SECONDS = 15 * 60;

/**
 * Stale heartbeat alert rate limit: 1 alert per feature per hour
 */
const STALE_HEARTBEAT_RATE_LIMIT_TTL = 3600;

/**
 * Row type for stale heartbeat query results.
 */
interface StaleHeartbeatRow {
  project_id: string;
  feature_id: string;
  last_heartbeat: number;
  age_seconds: number;
  status: string;
}

/**
 * Check for Durable Objects that have stopped sending heartbeats.
 *
 * Queries the system_health_checks table for features that:
 * 1. Have status = 'healthy'
 * 2. Haven't sent a heartbeat in STALE_THRESHOLD_SECONDS
 *
 * Updates status to 'stale' and fires Slack alerts.
 */
async function checkStaleHeartbeats(env: Env, log: Logger): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  try {
    // Find healthy features that haven't sent heartbeats recently
    const staleResult = await env.PLATFORM_DB.prepare(
      `
      SELECT
        project_id,
        feature_id,
        last_heartbeat,
        ? - last_heartbeat as age_seconds,
        status
      FROM system_health_checks
      WHERE status = 'healthy' AND ? - last_heartbeat > ?
    `
    )
      .bind(now, now, STALE_THRESHOLD_SECONDS)
      .all<StaleHeartbeatRow>();

    if (!staleResult.results || staleResult.results.length === 0) {
      log.debug('No stale heartbeats detected');
      return;
    }

    log.warn('Stale heartbeats detected', { count: staleResult.results.length });

    for (const stale of staleResult.results) {
      // Update status to 'stale'
      await env.PLATFORM_DB.prepare(
        `
        UPDATE system_health_checks
        SET status = 'stale',
            consecutive_failures = consecutive_failures + 1,
            updated_at = ?
        WHERE feature_id = ?
      `
      )
        .bind(now, stale.feature_id)
        .run();

      log.info('Marked feature as stale', {
        feature_id: stale.feature_id,
        project_id: stale.project_id,
        age_seconds: stale.age_seconds,
      });

      // Fire Slack alert (with rate limiting)
      await fireStaleHeartbeatAlert(stale, env, log);
    }
  } catch (error) {
    log.error('Failed to check stale heartbeats', error);
  }
}

/**
 * Send Slack alert for stale heartbeat.
 */
async function fireStaleHeartbeatAlert(
  stale: StaleHeartbeatRow,
  env: Env,
  log: Logger
): Promise<void> {
  // Check rate limit
  const alertKey = `stale-heartbeat:${stale.feature_id}`;
  const alreadySent = await env.PLATFORM_ALERTS.get(alertKey);

  if (alreadySent) {
    log.debug('Stale heartbeat alert rate limited', { feature_id: stale.feature_id });
    return;
  }

  if (!env.SLACK_WEBHOOK_URL) {
    log.debug('No SLACK_WEBHOOK_URL configured, skipping stale heartbeat alert');
    return;
  }

  const ageMinutes = Math.round(stale.age_seconds / 60);
  const lastHeartbeatTime = new Date(stale.last_heartbeat * 1000).toISOString();

  const message = {
    text: `[STALE] Durable Object ${stale.feature_id} has not sent a heartbeat in ${ageMinutes} minutes`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: ':broken_heart: Stale Heartbeat Detected',
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Feature:*\n${stale.feature_id}` },
          { type: 'mrkdwn', text: `*Project:*\n${stale.project_id}` },
          { type: 'mrkdwn', text: `*Last Heartbeat:*\n${lastHeartbeatTime}` },
          { type: 'mrkdwn', text: `*Age:*\n${ageMinutes} minutes` },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Investigation Commands:*\n\`\`\`# Check DO status in D1
npx wrangler d1 execute platform-metrics --remote --command "SELECT * FROM system_health_checks WHERE feature_id = '${stale.feature_id}'"

# Check recent telemetry for this feature
npx wrangler d1 execute platform-metrics --remote --command "SELECT * FROM feature_usage_daily WHERE feature_key = '${stale.feature_id}' ORDER BY snapshot_date DESC LIMIT 5"\`\`\``,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Expected heartbeat interval: 5 minutes | Stale threshold: 15 minutes`,
          },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Features Dashboard',
              emoji: true,
            },
            url: `${DASHBOARD_URL}/usage/features`,
          },
        ],
      },
    ],
    attachments: [
      {
        color: '#dc3545', // Red
        fields: [
          {
            title: 'Action Required',
            value:
              'Durable Object may be unhealthy or stopped. Check DO logs in Cloudflare dashboard and verify the worker is deployed correctly.',
            short: false,
          },
        ],
      },
    ],
  };

  try {
    const response = await fetch(env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    if (response.ok) {
      // Set rate limit
      await env.PLATFORM_ALERTS.put(alertKey, new Date().toISOString(), {
        expirationTtl: STALE_HEARTBEAT_RATE_LIMIT_TTL,
      });
      log.info('Sent stale heartbeat Slack alert', { feature_id: stale.feature_id });

      // Create dashboard notification
      if (_rawNotificationsApi) {
        try {
          const notifResp = await _rawNotificationsApi.fetch(
            'https://platform-notifications.internal/notifications',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                category: 'warning',
                source: 'sentinel',
                source_id: stale.feature_id,
                title: `Stale Heartbeat: ${stale.feature_id}`,
                description: `Durable Object has not sent a heartbeat in ${ageMinutes} minutes. Last seen: ${lastHeartbeatTime}`,
                priority: 'high',
                action_url: '/usage/features',
                action_label: 'View Features',
                project: stale.project_id,
              }),
            }
          );
          const notifBody = await notifResp.text();
          if (!notifResp.ok) {
            log.warn('Stale heartbeat notification failed', { status: notifResp.status, body: notifBody });
          }
        } catch (notifError) {
          log.error('Failed to create stale heartbeat notification', notifError);
        }
      }
    } else {
      const text = await response.text();
      log.error('Failed to send stale heartbeat Slack alert', {
        feature_id: stale.feature_id,
        status: response.status,
        error: text,
      });
    }
  } catch (error) {
    log.error('Error sending stale heartbeat Slack alert', error);
  }
}
