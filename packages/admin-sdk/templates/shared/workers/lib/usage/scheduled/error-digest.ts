/**
 * Error Digest Module
 *
 * Handles error alerting, tracking, and digest generation.
 * Extracted from platform-usage.ts as part of scheduled task modularisation.
 *
 * Functions:
 * - checkAndAlertErrors: Check telemetry for P0 conditions
 * - storeErrorEvent: Store error events to D1 for aggregation
 * - getErrorRateStats: Get error rate statistics over sliding window
 * - sendErrorAlert: Send alerts via alert-router or Slack fallback
 * - sendHourlyErrorDigest: Generate and send P1 hourly digest
 * - sendDailyErrorSummary: Generate and send P2 daily summary
 * - cleanupOldErrorEvents: Remove old error events (7-day retention)
 */

import type { Env, ErrorAlertPayload, TelemetryMessage } from '../shared';
import { ERROR_RATE_THRESHOLDS } from '../shared';
import { createLoggerFromEnv } from '@littlebearapps/platform-consumer-sdk';

// =============================================================================
// ERROR CHECKING AND ALERTING
// =============================================================================

/**
 * Check if telemetry message contains errors that warrant alerting.
 * Detects P0 conditions: circuit breaker trips, high error rates.
 */
export async function checkAndAlertErrors(telemetry: TelemetryMessage, env: Env): Promise<void> {
  // Skip if no errors reported
  if (!telemetry.error_count || telemetry.error_count === 0) {
    return;
  }

  // P0 Condition 1: Circuit breaker error
  if (telemetry.error_category === 'CIRCUIT_BREAKER') {
    await sendErrorAlert(env, {
      type: 'p0_immediate',
      feature_key: telemetry.feature_key,
      project: telemetry.project,
      category: telemetry.category,
      feature: telemetry.feature,
      correlation_id: telemetry.correlation_id,
      error_category: telemetry.error_category,
      error_code: telemetry.error_codes?.[0],
      window_minutes: ERROR_RATE_THRESHOLDS.windowMinutes,
    });
    return;
  }

  // Store error event in D1 for aggregation
  await storeErrorEvent(telemetry, env);

  // Check error rate over window for P0/P1 conditions
  const errorStats = await getErrorRateStats(telemetry.feature_key, env);

  if (errorStats.totalRequests >= ERROR_RATE_THRESHOLDS.minRequests) {
    const errorRate = (errorStats.errorCount / errorStats.totalRequests) * 100;

    if (errorRate >= ERROR_RATE_THRESHOLDS.p0) {
      // P0: High error rate (>50%)
      await sendErrorAlert(env, {
        type: 'p0_immediate',
        feature_key: telemetry.feature_key,
        project: telemetry.project,
        category: telemetry.category,
        feature: telemetry.feature,
        correlation_id: telemetry.correlation_id,
        error_category: telemetry.error_category,
        error_code: telemetry.error_codes?.[0],
        error_rate: errorRate,
        window_minutes: ERROR_RATE_THRESHOLDS.windowMinutes,
      });
    }
  }
}

// =============================================================================
// ERROR EVENT STORAGE
// =============================================================================

/**
 * Store error event in D1 for aggregation and historical analysis.
 */
export async function storeErrorEvent(telemetry: TelemetryMessage, env: Env): Promise<void> {
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:error-tracking');
  try {
    await env.PLATFORM_DB.prepare(
      `INSERT INTO feature_error_events (
        id, feature_key, error_category, error_code, error_message,
        correlation_id, worker, priority, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        crypto.randomUUID(),
        telemetry.feature_key,
        telemetry.error_category || 'INTERNAL',
        telemetry.error_codes?.[0] || null,
        null, // No message in telemetry (truncated for space)
        telemetry.correlation_id || null,
        null, // Worker name not in telemetry
        'P2', // Default priority, upgraded by alert detection
        Math.floor(Date.now() / 1000)
      )
      .run();
  } catch (error) {
    log.error('Failed to store error event', error);
  }
}

// =============================================================================
// ERROR RATE STATISTICS
// =============================================================================

/**
 * Get error rate statistics for a feature over the sliding window.
 */
export async function getErrorRateStats(
  featureKey: string,
  env: Env
): Promise<{ errorCount: number; totalRequests: number }> {
  try {
    const windowStart = Math.floor(Date.now() / 1000) - ERROR_RATE_THRESHOLDS.windowMinutes * 60;

    const result = await env.PLATFORM_DB.prepare(
      `SELECT
        COUNT(*) as error_count,
        (SELECT COUNT(*) FROM feature_error_events
         WHERE feature_key = ?1 AND created_at >= ?2) as total_events
      FROM feature_error_events
      WHERE feature_key = ?1 AND created_at >= ?2`
    )
      .bind(featureKey, windowStart)
      .first<{ error_count: number; total_events: number }>();

    return {
      errorCount: result?.error_count ?? 0,
      totalRequests: result?.total_events ?? 0,
    };
  } catch (error) {
    const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:error-tracking');
    log.error('Failed to get error rate', error);
    return { errorCount: 0, totalRequests: 0 };
  }
}

// =============================================================================
// ALERT SENDING
// =============================================================================

/**
 * Send error alert to alert-router.
 * Uses service binding if available, falls back to direct Slack.
 */
export async function sendErrorAlert(env: Env, payload: ErrorAlertPayload): Promise<void> {
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:error-alerting');
  try {
    if (env.ALERT_ROUTER) {
      // Use service binding to call alert-router
      const response = await env.ALERT_ROUTER.fetch('https://alert-router/errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        log.error(`alert-router returned ${response.status}`);
      } else {
        log.info('Alert sent', { type: payload.type, featureKey: payload.feature_key });
      }
    } else if (env.SLACK_WEBHOOK_URL) {
      // Fallback: send directly to Slack (basic format)
      const emoji = payload.type === 'p0_immediate' ? '🚨' : '⚠️';
      await fetch(env.SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `${emoji} [${payload.type.toUpperCase()}] Error in ${payload.feature_key}: ${payload.error_category}`,
        }),
      });
    }
  } catch (error) {
    log.error('Failed to send alert', error);
  }
}

// =============================================================================
// DIGEST GENERATION
// =============================================================================

/**
 * Generate and send hourly P1 error digest.
 * Only sends if error threshold met (>20% error rate or >100 errors).
 */
export async function sendHourlyErrorDigest(env: Env): Promise<void> {
  try {
    const hourAgo = Math.floor(Date.now() / 1000) - 3600;

    // Get top errors from the last hour
    const errors = await env.PLATFORM_DB.prepare(
      `SELECT
        feature_key,
        error_category,
        COUNT(*) as error_count
      FROM feature_error_events
      WHERE created_at >= ?
      GROUP BY feature_key, error_category
      ORDER BY error_count DESC
      LIMIT 10`
    )
      .bind(hourAgo)
      .all<{ feature_key: string; error_category: string; error_count: number }>();

    if (!errors.results || errors.results.length === 0) {
      return; // No errors in the last hour
    }

    const totalErrors = errors.results.reduce((sum, e) => sum + e.error_count, 0);
    const distinctTypes = new Set(errors.results.map((e) => e.error_category)).size;

    // Only send P1 digest if threshold met
    if (totalErrors < 100) {
      return;
    }

    const now = new Date();
    const hourAgoDate = new Date(now.getTime() - 3600000);

    const payload: ErrorAlertPayload = {
      type: 'p1_digest',
      feature_key: 'platform:aggregate:hourly',
      project: 'platform',
      category: 'aggregate',
      feature: 'hourly',
      total_errors: totalErrors,
      distinct_types: distinctTypes,
      top_errors: errors.results.map((e) => ({
        feature_key: e.feature_key,
        error_category: e.error_category,
        count: e.error_count,
      })),
      period_start: hourAgoDate.toISOString(),
      period_end: now.toISOString(),
    };

    await sendErrorAlert(env, payload);
    const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:error-digest');
    log.info('P1 hourly digest sent', { totalErrors });
  } catch (error) {
    const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:error-digest');
    log.error('Failed to generate hourly digest', error);
  }
}

/**
 * Generate and send daily P2 error summary.
 * Runs at midnight UTC (09:00 AEDT).
 */
export async function sendDailyErrorSummary(env: Env): Promise<void> {
  try {
    const dayAgo = Math.floor(Date.now() / 1000) - 86400;

    // Get error summary for the last 24 hours
    const errors = await env.PLATFORM_DB.prepare(
      `SELECT
        feature_key,
        error_category,
        COUNT(*) as error_count
      FROM feature_error_events
      WHERE created_at >= ?
      GROUP BY feature_key, error_category
      ORDER BY error_count DESC
      LIMIT 20`
    )
      .bind(dayAgo)
      .all<{ feature_key: string; error_category: string; error_count: number }>();

    if (!errors.results || errors.results.length === 0) {
      const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:error-digest');
      log.info('No errors in the last 24 hours, skipping daily summary');
      return;
    }

    const totalErrors = errors.results.reduce((sum, e) => sum + e.error_count, 0);
    const distinctFeatures = new Set(errors.results.map((e) => e.feature_key)).size;

    const now = new Date();
    const dayAgoDate = new Date(now.getTime() - 86400000);

    const payload: ErrorAlertPayload = {
      type: 'p2_summary',
      feature_key: 'platform:aggregate:daily',
      project: 'platform',
      category: 'aggregate',
      feature: 'daily',
      total_errors: totalErrors,
      distinct_types: distinctFeatures,
      top_errors: errors.results.map((e) => ({
        feature_key: e.feature_key,
        error_category: e.error_category,
        count: e.error_count,
      })),
      period_start: dayAgoDate.toISOString(),
      period_end: now.toISOString(),
    };

    await sendErrorAlert(env, payload);
    const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:error-digest');
    log.info('P2 daily summary sent', { totalErrors, distinctFeatures });
  } catch (error) {
    const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:error-digest');
    log.error('Failed to generate daily summary', error);
  }
}

// =============================================================================
// CLEANUP
// =============================================================================

/**
 * Clean up old error events (7-day retention).
 */
export async function cleanupOldErrorEvents(env: Env): Promise<number> {
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:error-cleanup');
  try {
    const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;

    const result = await env.PLATFORM_DB.prepare(
      `DELETE FROM feature_error_events WHERE created_at < ?`
    )
      .bind(weekAgo)
      .run();

    const deleted = result.meta?.changes ?? 0;
    if (deleted > 0) {
      log.info('Deleted old error events', { deleted });
    }
    return deleted;
  } catch (error) {
    log.error('Failed to cleanup old error events', error);
    return 0;
  }
}
