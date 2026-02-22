/**
 * Shadow Evaluation for Self-Tuning Pattern System
 *
 * Evaluates patterns in shadow mode for auto-promotion to approved,
 * and approved patterns for auto-demotion to stale.
 *
 * @module workers/lib/pattern-discovery/shadow-evaluation
 */

import type { D1Database, KVNamespace } from '@cloudflare/workers-types';
import type {
  PatternSuggestion,
  ShadowEvaluationResult,
  ShadowEvaluationConfig,
  PatternRule,
} from './types';
import { logAuditEvent, refreshDynamicPatternsCache, aggregatePatternEvidence } from './storage';
import { generateReviewContext } from './ai-prompt';
import { compilePattern, backtestPattern, storeBacktestResult } from './validation';
import type { Logger } from '@littlebearapps/platform-sdk';

/** Default evaluation configuration */
export const DEFAULT_EVALUATION_CONFIG: ShadowEvaluationConfig = {
  minMatchesForPromotion: 5,
  minSpreadDaysForPromotion: 3,
  maxMatchRateForPromotion: 0.8,
  shadowPeriodDays: 7,
  staleDaysThreshold: 30,
};

/** Confidence-based shadow period multipliers */
const CONFIDENCE_SHADOW_PERIODS: Record<string, number> = {
  high: 3,    // >=90% confidence: 3 days
  medium: 7,  // 70-89%: 7 days
  low: 14,    // 50-69%: 14 days
};

/**
 * Get shadow period based on confidence score
 */
export function getShadowPeriodDays(confidenceScore: number): number {
  if (confidenceScore >= 0.9) return CONFIDENCE_SHADOW_PERIODS.high;
  if (confidenceScore >= 0.7) return CONFIDENCE_SHADOW_PERIODS.medium;
  return CONFIDENCE_SHADOW_PERIODS.low;
}

/**
 * Move a pending pattern into shadow mode
 */
export async function enterShadowMode(
  db: D1Database,
  patternId: string,
  log: Logger
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);

  try {
    // Get the pattern to determine shadow period
    const pattern = await db
      .prepare('SELECT confidence_score FROM transient_pattern_suggestions WHERE id = ?')
      .bind(patternId)
      .first<{ confidence_score: number }>();

    if (!pattern) {
      log.warn('Pattern not found for shadow mode', { patternId });
      return false;
    }

    const shadowDays = getShadowPeriodDays(pattern.confidence_score || 0.5);
    const shadowEnd = now + shadowDays * 24 * 60 * 60;

    await db
      .prepare(
        `
        UPDATE transient_pattern_suggestions
        SET status = 'shadow',
            shadow_mode_start = ?,
            shadow_mode_end = ?,
            shadow_mode_matches = 0,
            shadow_match_days = '[]',
            updated_at = unixepoch()
        WHERE id = ? AND status = 'pending'
      `
      )
      .bind(now, shadowEnd, patternId)
      .run();

    await logAuditEvent(db, patternId, 'shadow-started', 'system:shadow-evaluator',
      `Entered shadow mode for ${shadowDays} days`, {
        shadowDays,
        confidenceScore: pattern.confidence_score,
      });

    log.info('Pattern entered shadow mode', { patternId, shadowDays });
    return true;
  } catch (error) {
    log.error('Failed to enter shadow mode', error, { patternId });
    return false;
  }
}

/**
 * Record a shadow match for a pattern
 */
export async function recordShadowMatch(
  db: D1Database,
  patternId: string
): Promise<void> {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  // Get current shadow_match_days
  const current = await db
    .prepare('SELECT shadow_match_days FROM transient_pattern_suggestions WHERE id = ?')
    .bind(patternId)
    .first<{ shadow_match_days: string | null }>();

  const existingDays: string[] = current?.shadow_match_days
    ? JSON.parse(current.shadow_match_days)
    : [];

  // Add today if not already present
  if (!existingDays.includes(today)) {
    existingDays.push(today);
  }

  await db
    .prepare(
      `
      UPDATE transient_pattern_suggestions
      SET shadow_mode_matches = shadow_mode_matches + 1,
          shadow_match_days = ?,
          last_matched_at = unixepoch(),
          updated_at = unixepoch()
      WHERE id = ?
    `
    )
    .bind(JSON.stringify(existingDays), patternId)
    .run();
}

/**
 * Evaluate a single shadow pattern for promotion
 */
export async function evaluateShadowPattern(
  db: D1Database,
  pattern: PatternSuggestion,
  config: ShadowEvaluationConfig,
  log: Logger
): Promise<ShadowEvaluationResult> {
  const now = Math.floor(Date.now() / 1000);

  // Check if shadow period has ended
  const shadowEnded = pattern.shadowModeEnd && now >= pattern.shadowModeEnd;
  const shadowDays = pattern.shadowModeStart
    ? Math.floor((now - pattern.shadowModeStart) / (24 * 60 * 60))
    : 0;

  const matchSpreadDays = pattern.shadowMatchDays?.length || 0;
  const shadowMatches = pattern.shadowModeMatches || 0;

  // Calculate current match rate via backtest
  const rule: PatternRule = {
    type: pattern.patternType,
    value: pattern.patternValue,
    category: pattern.category,
    scope: pattern.scope as PatternRule['scope'],
  };

  const backtestResult = await backtestPattern(pattern.id, rule, db, log, 7);

  // Decision logic
  let recommendation: 'promote' | 'demote' | 'continue' = 'continue';
  let reasoning = '';

  if (!shadowEnded) {
    reasoning = `Shadow period ongoing (${shadowDays}/${config.shadowPeriodDays} days)`;
  } else if (backtestResult.overMatching) {
    recommendation = 'demote';
    reasoning = `Over-matching: ${(backtestResult.matchRate * 100).toFixed(1)}% > ${config.maxMatchRateForPromotion * 100}%`;
  } else if (shadowMatches < config.minMatchesForPromotion) {
    recommendation = 'demote';
    reasoning = `Insufficient matches: ${shadowMatches} < ${config.minMatchesForPromotion}`;
  } else if (matchSpreadDays < config.minSpreadDaysForPromotion) {
    recommendation = 'demote';
    reasoning = `Insufficient spread: ${matchSpreadDays} days < ${config.minSpreadDaysForPromotion}`;
  } else {
    recommendation = 'promote';
    reasoning = `Met criteria: ${shadowMatches} matches across ${matchSpreadDays} days, ${(backtestResult.matchRate * 100).toFixed(1)}% match rate`;
  }

  log.info('Shadow evaluation result', {
    patternId: pattern.id,
    recommendation,
    shadowMatches,
    matchSpreadDays,
    matchRate: backtestResult.matchRate,
    reasoning,
  });

  return {
    patternId: pattern.id,
    shadowMatchCount: shadowMatches,
    shadowDays,
    matchSpreadDays,
    currentMatchRate: backtestResult.matchRate,
    recommendation,
    reasoning,
  };
}

/** Environment needed for AI context generation */
export interface AIContextEnv {
  CLOUDFLARE_ACCOUNT_ID: string;
  PLATFORM_AI_GATEWAY_KEY: string;
}

/**
 * Mark a shadow pattern as ready for human review (no auto-promotion)
 *
 * Instead of auto-promoting patterns, we aggregate evidence and store it
 * as review_context for human decision-making. Optionally generates AI explainer.
 */
export async function markReadyForReview(
  db: D1Database,
  patternId: string,
  evaluation: ShadowEvaluationResult,
  log: Logger,
  env?: AIContextEnv
): Promise<boolean> {
  try {
    // Get pattern details for AI context
    const patternDetails = await db
      .prepare(`
        SELECT pattern_type, pattern_value, category, confidence_score, ai_reasoning
        FROM transient_pattern_suggestions WHERE id = ?
      `)
      .bind(patternId)
      .first<{
        pattern_type: string;
        pattern_value: string;
        category: string;
        confidence_score: number;
        ai_reasoning: string | null;
      }>();

    if (!patternDetails) {
      log.warn('Pattern not found for review context', { patternId });
      return false;
    }

    // Aggregate evidence from pattern_match_evidence table
    const evidence = await aggregatePatternEvidence(db, patternId);

    // Try to generate AI explainer if env is provided
    let aiExplainer: Awaited<ReturnType<typeof generateReviewContext>> = null;
    if (env) {
      aiExplainer = await generateReviewContext(
        {
          patternType: patternDetails.pattern_type,
          patternValue: patternDetails.pattern_value,
          category: patternDetails.category,
          confidenceScore: patternDetails.confidence_score,
          aiReasoning: patternDetails.ai_reasoning ?? undefined,
        },
        evidence,
        env,
        log
      );
    }

    // Build review context JSON for human review
    const reviewContext = {
      ...evidence,
      evaluatedAt: Math.floor(Date.now() / 1000),
      recommendation: aiExplainer?.recommendation ?? ('likely-approve' as const),
      reasoning: evaluation.reasoning,
      shadowMatchCount: evaluation.shadowMatchCount,
      matchSpreadDays: evaluation.matchSpreadDays,
      matchRate: evaluation.currentMatchRate,
      // AI-generated explainer fields
      aiExplainer: aiExplainer?.summary ?? null,
      whatItCatches: aiExplainer?.whatItCatches ?? null,
      whyTransient: aiExplainer?.whyTransient ?? null,
      affectedAreas: aiExplainer?.affectedAreas ?? null,
      concerns: aiExplainer?.concerns ?? [],
    };

    // Keep status as 'shadow' but add review_context
    // This signals the pattern is ready for human review
    await db
      .prepare(
        `
        UPDATE transient_pattern_suggestions
        SET review_context = ?,
            updated_at = unixepoch()
        WHERE id = ? AND status = 'shadow'
      `
      )
      .bind(JSON.stringify(reviewContext), patternId)
      .run();

    await logAuditEvent(db, patternId, 'ready-for-review', 'system:shadow-evaluator',
      'Evidence collected, awaiting human review', {
        totalMatches: evidence.totalMatches,
        distinctDays: evidence.distinctDays,
        hasAiExplainer: !!aiExplainer,
      });

    log.info('Pattern marked ready for review', {
      patternId,
      totalMatches: evidence.totalMatches,
      distinctDays: evidence.distinctDays,
      projects: Object.keys(evidence.matchesByProject).length,
      hasAiExplainer: !!aiExplainer,
    });

    return true;
  } catch (error) {
    log.error('Failed to mark pattern ready for review', error, { patternId });
    return false;
  }
}

/**
 * @deprecated Use markReadyForReview instead - patterns should not auto-promote
 * Kept for reference during migration
 */
export async function autoPromotePattern(
  db: D1Database,
  kv: KVNamespace,
  patternId: string,
  evaluation: ShadowEvaluationResult,
  log: Logger
): Promise<boolean> {
  log.warn('autoPromotePattern is deprecated - use markReadyForReview instead', { patternId });
  // Redirect to markReadyForReview to preserve existing API
  return markReadyForReview(db, patternId, evaluation, log);
}

/**
 * Auto-demote a shadow pattern (failed evaluation)
 */
export async function autoDemoteShadowPattern(
  db: D1Database,
  patternId: string,
  evaluation: ShadowEvaluationResult,
  log: Logger
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);

  try {
    await db
      .prepare(
        `
        UPDATE transient_pattern_suggestions
        SET status = 'rejected',
            shadow_mode_end = ?,
            rejection_reason = ?,
            reviewed_by = 'system:auto-demote',
            reviewed_at = ?,
            updated_at = unixepoch()
        WHERE id = ? AND status = 'shadow'
      `
      )
      .bind(now, evaluation.reasoning, now, patternId)
      .run();

    await logAuditEvent(db, patternId, 'auto-demoted', 'system:shadow-evaluator',
      evaluation.reasoning, {
        shadowMatchCount: evaluation.shadowMatchCount,
        matchSpreadDays: evaluation.matchSpreadDays,
        matchRate: evaluation.currentMatchRate,
      });

    log.info('Shadow pattern auto-demoted', { patternId, reasoning: evaluation.reasoning });
    return true;
  } catch (error) {
    log.error('Failed to auto-demote shadow pattern', error, { patternId });
    return false;
  }
}

/**
 * Check approved patterns for staleness
 */
export async function checkForStalePatterns(
  db: D1Database,
  kv: KVNamespace,
  config: ShadowEvaluationConfig,
  log: Logger
): Promise<{ demoted: number; checked: number }> {
  const staleCutoff = Math.floor(Date.now() / 1000) - config.staleDaysThreshold * 24 * 60 * 60;

  // Find approved, non-protected patterns with no recent matches
  const result = await db
    .prepare(
      `
      SELECT id, pattern_value, category, last_matched_at, match_count
      FROM transient_pattern_suggestions
      WHERE status = 'approved'
        AND is_protected = 0
        AND (last_matched_at IS NULL OR last_matched_at < ?)
        AND match_count > 0
    `
    )
    .bind(staleCutoff)
    .all<{ id: string; pattern_value: string; category: string; last_matched_at: number | null; match_count: number }>();

  let demoted = 0;

  for (const pattern of result.results) {
    const now = Math.floor(Date.now() / 1000);

    await db
      .prepare(
        `
        UPDATE transient_pattern_suggestions
        SET status = 'stale',
            disabled_at = ?,
            updated_at = unixepoch()
        WHERE id = ?
      `
      )
      .bind(now, pattern.id)
      .run();

    const daysSinceMatch = pattern.last_matched_at
      ? Math.floor((now - pattern.last_matched_at) / (24 * 60 * 60))
      : 'never';

    await logAuditEvent(db, pattern.id, 'auto-demoted', 'system:stale-detector',
      `No matches in ${config.staleDaysThreshold} days`, {
        lastMatchedAt: pattern.last_matched_at,
        daysSinceMatch,
        totalMatches: pattern.match_count,
      });

    log.info('Pattern marked stale', {
      patternId: pattern.id,
      category: pattern.category,
      daysSinceMatch,
    });

    demoted++;
  }

  // Refresh KV if any patterns were demoted
  if (demoted > 0) {
    await refreshDynamicPatternsCache(db, kv, log);
  }

  return { demoted, checked: result.results.length };
}

/**
 * Get patterns in shadow mode that need evaluation
 */
export async function getShadowPatternsForEvaluation(
  db: D1Database
): Promise<PatternSuggestion[]> {
  const now = Math.floor(Date.now() / 1000);

  const result = await db
    .prepare(
      `
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
        created_at as createdAt, updated_at as updatedAt
      FROM transient_pattern_suggestions
      WHERE status = 'shadow'
        AND shadow_mode_end <= ?
      ORDER BY created_at ASC
    `
    )
    .bind(now)
    .all<PatternSuggestion & { sampleMessages: string; shadowMatchDays: string }>();

  return result.results.map((r) => ({
    ...r,
    sampleMessages: JSON.parse(r.sampleMessages || '[]'),
    shadowMatchDays: r.shadowMatchDays ? JSON.parse(r.shadowMatchDays) : [],
    isProtected: Boolean(r.isProtected),
  }));
}

/**
 * Auto-enter shadow mode for pending patterns older than 24 hours
 */
export async function autoEnterShadowForOldPending(
  db: D1Database,
  log: Logger
): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - 24 * 60 * 60; // 24 hours ago

  const result = await db
    .prepare(
      `
      SELECT id FROM transient_pattern_suggestions
      WHERE status = 'pending'
        AND created_at < ?
        AND confidence_score >= 0.5
    `
    )
    .bind(cutoff)
    .all<{ id: string }>();

  let entered = 0;

  for (const pattern of result.results) {
    const success = await enterShadowMode(db, pattern.id, log);
    if (success) entered++;
  }

  if (entered > 0) {
    log.info('Auto-entered shadow mode for pending patterns', { count: entered });
  }

  return entered;
}

/**
 * Run full shadow evaluation cycle
 *
 * Note: Patterns that meet promotion criteria are marked as "ready for review"
 * rather than auto-promoted. Human approval is required.
 *
 * @param env - Optional env for AI context generation. If provided, generates AI explainers.
 */
export async function runShadowEvaluationCycle(
  db: D1Database,
  kv: KVNamespace,
  log: Logger,
  config: ShadowEvaluationConfig = DEFAULT_EVALUATION_CONFIG,
  env?: AIContextEnv
): Promise<{
  evaluated: number;
  readyForReview: number;
  demoted: number;
  enteredShadow: number;
  staleDetected: number;
  /** @deprecated Use readyForReview instead */
  promoted?: number;
}> {
  log.info('Starting shadow evaluation cycle', { hasAIEnv: !!env });

  // Step 1: Auto-enter shadow for old pending patterns
  const enteredShadow = await autoEnterShadowForOldPending(db, log);

  // Step 2: Evaluate shadow patterns ready for decision
  const shadowPatterns = await getShadowPatternsForEvaluation(db);
  let readyForReview = 0;
  let demoted = 0;

  for (const pattern of shadowPatterns) {
    const evaluation = await evaluateShadowPattern(db, pattern, config, log);

    if (evaluation.recommendation === 'promote') {
      // Mark as ready for human review instead of auto-promoting
      // Pass env to enable AI explainer generation
      const success = await markReadyForReview(db, pattern.id, evaluation, log, env);
      if (success) readyForReview++;
    } else if (evaluation.recommendation === 'demote') {
      const success = await autoDemoteShadowPattern(db, pattern.id, evaluation, log);
      if (success) demoted++;
    }
  }

  // Step 3: Check for stale patterns (weekly - only run on Sundays)
  let staleDetected = 0;
  const dayOfWeek = new Date().getDay();
  if (dayOfWeek === 0) { // Sunday
    const staleResult = await checkForStalePatterns(db, kv, config, log);
    staleDetected = staleResult.demoted;
  }

  const result = {
    evaluated: shadowPatterns.length,
    readyForReview,
    demoted,
    enteredShadow,
    staleDetected,
    // Backwards compatibility
    promoted: readyForReview,
  };

  log.info('Shadow evaluation cycle complete', result);
  return result;
}
