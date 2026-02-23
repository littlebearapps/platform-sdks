/**
 * Storage Operations for Pattern Discovery
 *
 * D1 and KV operations for pattern suggestions and audit logs.
 *
 * @module workers/lib/pattern-discovery/storage
 */

import type { D1Database, KVNamespace } from '@cloudflare/workers-types';
import type {
  PatternSuggestion,
  PatternRule,
  AISuggestionResponse,
  AuditAction,
  ErrorCluster,
} from './types';
import type { Logger } from '@littlebearapps/platform-consumer-sdk';

/** KV key prefix for approved dynamic patterns */
export const DYNAMIC_PATTERNS_KEY = 'PATTERNS:DYNAMIC:APPROVED';

/**
 * Generate a unique ID
 */
function generateId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${timestamp}-${random}`;
}

/**
 * Store pattern suggestions from AI response
 */
export async function storePatternSuggestions(
  db: D1Database,
  cluster: ErrorCluster,
  aiResponse: AISuggestionResponse,
  log: Logger
): Promise<string[]> {
  const suggestionIds: string[] = [];

  for (const pattern of aiResponse.patterns) {
    // Skip low-confidence suggestions
    if (pattern.confidence < 0.5) {
      log.debug('Skipping low-confidence pattern', {
        category: pattern.category,
        confidence: pattern.confidence,
      });
      continue;
    }

    // Skip if an active pattern with the same type+value already exists.
    // Prevents duplicate suggestions when the same error cluster appears in
    // consecutive cron runs (e.g. duplicate "Slow workflow step" shadow suggestions).
    try {
      const existing = await db
        .prepare(
          `SELECT id, status FROM transient_pattern_suggestions
           WHERE pattern_type = ? AND pattern_value = ?
           AND status IN ('approved', 'shadow', 'pending')
           LIMIT 1`
        )
        .bind(pattern.patternType, pattern.patternValue)
        .first<{ id: string; status: string }>();

      if (existing) {
        log.info('Skipping duplicate pattern suggestion', {
          existingId: existing.id,
          existingStatus: existing.status,
          patternValue: pattern.patternValue,
          category: pattern.category,
        });
        continue;
      }
    } catch (error) {
      // Non-blocking — proceed with insertion if dedup check fails
      log.warn('Dedup check failed, proceeding with insertion', { error });
    }

    const id = generateId('suggestion');

    try {
      await db
        .prepare(
          `
        INSERT INTO transient_pattern_suggestions (
          id, pattern_type, pattern_value, category, scope,
          confidence_score, sample_messages, ai_reasoning, cluster_id,
          status
        ) VALUES (?, ?, ?, ?, 'global', ?, ?, ?, ?, 'pending')
      `
        )
        .bind(
          id,
          pattern.patternType,
          pattern.patternValue,
          pattern.category,
          pattern.confidence,
          JSON.stringify(pattern.positiveExamples),
          pattern.reasoning,
          cluster.id
        )
        .run();

      // Log audit event
      await logAuditEvent(db, id, 'created', 'ai:deepseek', 'Pattern suggested by AI analysis', {
        confidence: pattern.confidence,
        clusterId: cluster.id,
        clusterOccurrences: cluster.occurrenceCount,
      });

      suggestionIds.push(id);

      log.info('Stored pattern suggestion', {
        id,
        patternType: pattern.patternType,
        category: pattern.category,
        confidence: pattern.confidence,
      });
    } catch (error) {
      log.error('Failed to store pattern suggestion', error, {
        category: pattern.category,
      });
    }
  }

  return suggestionIds;
}

/**
 * Log an audit event
 */
export async function logAuditEvent(
  db: D1Database,
  patternId: string,
  action: AuditAction,
  actor: string,
  reason: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  const id = generateId('audit');

  await db
    .prepare(
      `
    INSERT INTO pattern_audit_log (id, pattern_id, action, actor, reason, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `
    )
    .bind(id, patternId, action, actor, reason, metadata ? JSON.stringify(metadata) : null)
    .run();
}

/**
 * Get pending suggestions for review
 */
export async function getPendingSuggestions(
  db: D1Database,
  limit: number = 20
): Promise<PatternSuggestion[]> {
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
    WHERE status = 'pending'
    ORDER BY confidence_score DESC, created_at ASC
    LIMIT ?
  `
    )
    .bind(limit)
    .all<PatternSuggestion & { sampleMessages: string; shadowMatchDays: string; isProtected: number }>();

  return result.results.map((r) => ({
    ...r,
    sampleMessages: JSON.parse(r.sampleMessages || '[]'),
    shadowMatchDays: r.shadowMatchDays ? JSON.parse(r.shadowMatchDays) : [],
    isProtected: Boolean(r.isProtected),
  }));
}

/**
 * Approve a pattern suggestion
 */
export async function approveSuggestion(
  db: D1Database,
  kv: KVNamespace,
  suggestionId: string,
  reviewedBy: string,
  log: Logger
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);

  try {
    // Update suggestion status
    await db
      .prepare(
        `
      UPDATE transient_pattern_suggestions
      SET status = 'approved', reviewed_by = ?, reviewed_at = ?,
          enabled_at = ?, updated_at = unixepoch()
      WHERE id = ? AND status = 'pending'
    `
      )
      .bind(reviewedBy, now, now, suggestionId)
      .run();

    // Log audit event
    await logAuditEvent(db, suggestionId, 'approved', `human:${reviewedBy}`, 'Pattern approved');

    // Refresh KV cache
    await refreshDynamicPatternsCache(db, kv, log);

    log.info('Approved pattern suggestion', { suggestionId, reviewedBy });
    return true;
  } catch (error) {
    log.error('Failed to approve suggestion', error, { suggestionId });
    return false;
  }
}

/**
 * Reject a pattern suggestion
 */
export async function rejectSuggestion(
  db: D1Database,
  suggestionId: string,
  reviewedBy: string,
  reason: string,
  log: Logger
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);

  try {
    await db
      .prepare(
        `
      UPDATE transient_pattern_suggestions
      SET status = 'rejected', reviewed_by = ?, reviewed_at = ?,
          rejection_reason = ?, updated_at = unixepoch()
      WHERE id = ? AND status = 'pending'
    `
      )
      .bind(reviewedBy, now, reason, suggestionId)
      .run();

    await logAuditEvent(db, suggestionId, 'rejected', `human:${reviewedBy}`, reason);

    log.info('Rejected pattern suggestion', { suggestionId, reviewedBy, reason });
    return true;
  } catch (error) {
    log.error('Failed to reject suggestion', error, { suggestionId });
    return false;
  }
}

/**
 * Disable an approved pattern
 */
export async function disableSuggestion(
  db: D1Database,
  kv: KVNamespace,
  suggestionId: string,
  actor: string,
  reason: string,
  isAutomatic: boolean,
  log: Logger
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);

  try {
    await db
      .prepare(
        `
      UPDATE transient_pattern_suggestions
      SET status = 'disabled', disabled_at = ?, updated_at = unixepoch()
      WHERE id = ? AND status = 'approved'
    `
      )
      .bind(now, suggestionId)
      .run();

    const action: AuditAction = isAutomatic ? 'auto-disabled' : 'disabled';
    await logAuditEvent(db, suggestionId, action, actor, reason);

    // Refresh KV cache
    await refreshDynamicPatternsCache(db, kv, log);

    log.info('Disabled pattern', { suggestionId, actor, reason, isAutomatic });
    return true;
  } catch (error) {
    log.error('Failed to disable pattern', error, { suggestionId });
    return false;
  }
}

/**
 * Refresh the KV cache of approved dynamic patterns
 */
export async function refreshDynamicPatternsCache(
  db: D1Database,
  kv: KVNamespace,
  log: Logger
): Promise<void> {
  try {
    const result = await db
      .prepare(
        `
      SELECT
        id, pattern_type as type, pattern_value as value,
        category, scope
      FROM transient_pattern_suggestions
      WHERE status = 'approved'
      ORDER BY created_at ASC
    `
      )
      .all<PatternRule & { id: string }>();

    const patterns = result.results;

    // 7-day TTL as safety net — if refreshDynamicPatternsCache() fails
    // silently, stale patterns will auto-expire rather than persist forever.
    // Daily crons refresh this well within the 7-day window.
    // (Previously had no TTL; before that, 1h TTL caused vanishing between cron runs.)
    await kv.put(DYNAMIC_PATTERNS_KEY, JSON.stringify(patterns), { expirationTtl: 604800 });

    log.info('Refreshed dynamic patterns cache', { count: patterns.length });
  } catch (error) {
    log.error('Failed to refresh patterns cache', error);
  }
}

/**
 * Get approved dynamic patterns from KV (with D1 fallback)
 */
export async function getDynamicPatterns(
  kv: KVNamespace,
  db: D1Database,
  log: Logger
): Promise<PatternRule[]> {
  try {
    // Try KV first
    const cached = await kv.get(DYNAMIC_PATTERNS_KEY);
    if (cached) {
      const patterns = JSON.parse(cached) as PatternRule[];
      log.debug('Loaded dynamic patterns from KV', { count: patterns.length });
      return patterns;
    }

    // Fallback to D1
    const result = await db
      .prepare(
        `
      SELECT
        pattern_type as type, pattern_value as value,
        category, scope
      FROM transient_pattern_suggestions
      WHERE status = 'approved'
      ORDER BY created_at ASC
    `
      )
      .all<PatternRule>();

    const patterns = result.results;

    // Cache in KV for next time (7-day safety TTL, refreshed daily by cron)
    await kv.put(DYNAMIC_PATTERNS_KEY, JSON.stringify(patterns), { expirationTtl: 604800 });

    log.debug('Loaded dynamic patterns from D1', { count: patterns.length });
    return patterns;
  } catch (error) {
    log.error('Failed to get dynamic patterns', error);
    return [];
  }
}

/**
 * Update match statistics for a pattern
 */
export async function recordPatternMatch(
  db: D1Database,
  patternId: string
): Promise<void> {
  await db
    .prepare(
      `
    UPDATE transient_pattern_suggestions
    SET match_count = match_count + 1,
        last_matched_at = unixepoch(),
        updated_at = unixepoch()
    WHERE id = ?
  `
    )
    .bind(patternId)
    .run();
}

/**
 * Evidence for a pattern match - used for human review context
 */
export interface PatternMatchEvidence {
  patternId: string;
  scriptName: string;
  project?: string;
  errorFingerprint?: string;
  normalizedMessage?: string;
  errorType?: string;
  priority?: string;
}

/**
 * Record detailed match evidence for a pattern
 * Used by error-collector when dynamic patterns match
 */
export async function recordPatternMatchEvidence(
  db: D1Database,
  evidence: PatternMatchEvidence
): Promise<void> {
  const id = generateId('evidence');

  try {
    await db
      .prepare(
        `
      INSERT INTO pattern_match_evidence
      (id, pattern_id, script_name, project, error_fingerprint, normalized_message, error_type, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .bind(
        id,
        evidence.patternId,
        evidence.scriptName,
        evidence.project ?? null,
        evidence.errorFingerprint ?? null,
        evidence.normalizedMessage ?? null,
        evidence.errorType ?? null,
        evidence.priority ?? null
      )
      .run();

    // Also increment the simple match_count on the pattern
    await recordPatternMatch(db, evidence.patternId);
  } catch (error) {
    // Log but don't throw - evidence tracking is non-critical
    console.error('Failed to record pattern match evidence:', error);
  }
}

/**
 * Aggregated evidence for pattern review
 */
export interface AggregatedPatternEvidence {
  totalMatches: number;
  matchesByProject: Record<string, number>;
  matchesByScript: Record<string, number>;
  sampleMessages: string[];
  distinctDays: number;
  firstMatchAt: number | null;
  lastMatchAt: number | null;
}

/**
 * Aggregate match evidence for a pattern
 * Used by shadow evaluation to build review context
 */
export async function aggregatePatternEvidence(
  db: D1Database,
  patternId: string
): Promise<AggregatedPatternEvidence> {
  // Get total matches
  const totalResult = await db
    .prepare(`SELECT COUNT(*) as count FROM pattern_match_evidence WHERE pattern_id = ?`)
    .bind(patternId)
    .first<{ count: number }>();

  // Get matches grouped by project
  const projectsResult = await db
    .prepare(
      `
      SELECT COALESCE(project, 'unknown') as project, COUNT(*) as count
      FROM pattern_match_evidence
      WHERE pattern_id = ?
      GROUP BY project
      ORDER BY count DESC
    `
    )
    .bind(patternId)
    .all<{ project: string; count: number }>();

  // Get matches grouped by script
  const scriptsResult = await db
    .prepare(
      `
      SELECT script_name, COUNT(*) as count
      FROM pattern_match_evidence
      WHERE pattern_id = ?
      GROUP BY script_name
      ORDER BY count DESC
      LIMIT 10
    `
    )
    .bind(patternId)
    .all<{ script_name: string; count: number }>();

  // Get distinct days (count unique dates)
  const daysResult = await db
    .prepare(
      `
      SELECT COUNT(DISTINCT date(matched_at, 'unixepoch')) as days
      FROM pattern_match_evidence
      WHERE pattern_id = ?
    `
    )
    .bind(patternId)
    .first<{ days: number }>();

  // Get sample messages (distinct, up to 5)
  const messagesResult = await db
    .prepare(
      `
      SELECT DISTINCT normalized_message
      FROM pattern_match_evidence
      WHERE pattern_id = ? AND normalized_message IS NOT NULL
      LIMIT 5
    `
    )
    .bind(patternId)
    .all<{ normalized_message: string }>();

  // Get first and last match times
  const timesResult = await db
    .prepare(
      `
      SELECT MIN(matched_at) as first_match, MAX(matched_at) as last_match
      FROM pattern_match_evidence
      WHERE pattern_id = ?
    `
    )
    .bind(patternId)
    .first<{ first_match: number | null; last_match: number | null }>();

  // Build result
  const matchesByProject: Record<string, number> = {};
  for (const row of projectsResult.results) {
    matchesByProject[row.project] = row.count;
  }

  const matchesByScript: Record<string, number> = {};
  for (const row of scriptsResult.results) {
    matchesByScript[row.script_name] = row.count;
  }

  return {
    totalMatches: totalResult?.count ?? 0,
    matchesByProject,
    matchesByScript,
    sampleMessages: messagesResult.results.map((r) => r.normalized_message),
    distinctDays: daysResult?.days ?? 0,
    firstMatchAt: timesResult?.first_match ?? null,
    lastMatchAt: timesResult?.last_match ?? null,
  };
}

/**
 * Get approved patterns with match statistics
 */
export async function getApprovedPatterns(
  db: D1Database,
  limit: number = 50,
  offset: number = 0
): Promise<PatternSuggestion[]> {
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
    WHERE status = 'approved'
    ORDER BY match_count DESC, created_at DESC
    LIMIT ? OFFSET ?
  `
    )
    .bind(limit, offset)
    .all<PatternSuggestion & { sampleMessages: string; shadowMatchDays: string; isProtected: number }>();

  return result.results.map((r) => ({
    ...r,
    sampleMessages: JSON.parse(r.sampleMessages || '[]'),
    shadowMatchDays: r.shadowMatchDays ? JSON.parse(r.shadowMatchDays) : [],
    isProtected: Boolean(r.isProtected),
  }));
}

/**
 * Get patterns in shadow mode
 */
export async function getShadowPatterns(
  db: D1Database,
  limit: number = 50
): Promise<PatternSuggestion[]> {
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
    ORDER BY shadow_mode_end ASC, created_at ASC
    LIMIT ?
  `
    )
    .bind(limit)
    .all<PatternSuggestion & { sampleMessages: string; shadowMatchDays: string; isProtected: number }>();

  return result.results.map((r) => ({
    ...r,
    sampleMessages: JSON.parse(r.sampleMessages || '[]'),
    shadowMatchDays: r.shadowMatchDays ? JSON.parse(r.shadowMatchDays) : [],
    isProtected: Boolean(r.isProtected),
  }));
}

/**
 * Get stale patterns
 */
export async function getStalePatterns(
  db: D1Database,
  limit: number = 50
): Promise<PatternSuggestion[]> {
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
    WHERE status = 'stale'
    ORDER BY disabled_at DESC, created_at DESC
    LIMIT ?
  `
    )
    .bind(limit)
    .all<PatternSuggestion & { sampleMessages: string; shadowMatchDays: string; isProtected: number }>();

  return result.results.map((r) => ({
    ...r,
    sampleMessages: JSON.parse(r.sampleMessages || '[]'),
    shadowMatchDays: r.shadowMatchDays ? JSON.parse(r.shadowMatchDays) : [],
    isProtected: Boolean(r.isProtected),
  }));
}

/**
 * Get pattern statistics summary
 */
export async function getPatternStats(db: D1Database): Promise<{
  pendingCount: number;
  shadowCount: number;
  approvedCount: number;
  staleCount: number;
  rejectedCount: number;
  disabledCount: number;
  protectedCount: number;
  staticCount: number;
  totalMatches: number;
  lastDiscoveryRun: number | null;
  activeCategories: string[];
}> {
  // Get counts by status
  const countsResult = await db
    .prepare(
      `
    SELECT
      status,
      COUNT(*) as count,
      SUM(match_count) as totalMatches
    FROM transient_pattern_suggestions
    GROUP BY status
  `
    )
    .all<{ status: string; count: number; totalMatches: number | null }>();

  const counts = countsResult.results.reduce(
    (acc, row) => {
      acc[row.status] = row.count;
      if (row.status === 'approved') {
        acc.totalMatches = row.totalMatches || 0;
      }
      return acc;
    },
    { pending: 0, shadow: 0, approved: 0, stale: 0, rejected: 0, disabled: 0, totalMatches: 0 } as Record<string, number>
  );

  // Get protected and static counts
  const protectedResult = await db
    .prepare(
      `
    SELECT
      SUM(CASE WHEN is_protected = 1 THEN 1 ELSE 0 END) as protectedCount,
      SUM(CASE WHEN source = 'static-import' THEN 1 ELSE 0 END) as staticCount
    FROM transient_pattern_suggestions
  `
    )
    .first<{ protectedCount: number; staticCount: number }>();

  // Get unique active categories
  const categoriesResult = await db
    .prepare(
      `
    SELECT DISTINCT category
    FROM transient_pattern_suggestions
    WHERE status = 'approved'
    ORDER BY category
  `
    )
    .all<{ category: string }>();

  // Get last discovery run from clusters table
  const lastRunResult = await db
    .prepare(
      `
    SELECT MAX(created_at) as lastRun
    FROM error_clusters
  `
    )
    .first<{ lastRun: number | null }>();

  return {
    pendingCount: counts.pending || 0,
    shadowCount: counts.shadow || 0,
    approvedCount: counts.approved || 0,
    staleCount: counts.stale || 0,
    rejectedCount: counts.rejected || 0,
    disabledCount: counts.disabled || 0,
    protectedCount: protectedResult?.protectedCount || 0,
    staticCount: protectedResult?.staticCount || 0,
    totalMatches: counts.totalMatches || 0,
    lastDiscoveryRun: lastRunResult?.lastRun || null,
    activeCategories: categoriesResult.results.map((r) => r.category),
  };
}
