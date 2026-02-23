/**
 * Telemetry Processor
 *
 * Queue consumer for platform telemetry messages.
 * Handles:
 * - Main queue processing (handleQueue)
 * - Heartbeat messages (handleHeartbeat)
 * - Intelligent degradation (processIntelligentDegradation)
 * - Error alerting (checkAndAlertErrors)
 * - AI model usage persistence (persistFeatureAIModelUsage)
 *
 * Budget enforcement (checkAndUpdateBudgetStatus) is imported from ./budget-enforcement.
 *
 * Extracted from platform-usage.ts as part of Phase D modularization.
 */

import type { MessageBatch } from '@cloudflare/workers-types';
import type { Env, TelemetryMessage, FeatureBatchState, ErrorAlertPayload } from '../shared';
import { ERROR_RATE_THRESHOLDS } from '../shared';
import { generateId } from '../shared';
import { createLoggerFromEnv } from '@littlebearapps/platform-consumer-sdk';
import { checkAndUpdateBudgetStatus } from './budget-enforcement';
import { calculateCFCostFromMetrics } from './cost-calculator';
import { checkAndUpdateCostBudgetStatus } from './cost-budget-enforcement';
import {
  getPIDState,
  savePIDState,
  computePID,
  calculateUtilisation,
  shouldUpdatePID,
  formatThrottleRate,
} from '../../control';
import {
  getReservoirState,
  saveReservoirState,
  addSample,
  getPercentiles,
  formatPercentiles,
} from '../../telemetry-sampling';
import { calculateBCU, formatBCUResult, type BCUResult } from '../../economics';
import { categoriseError, extractErrorCode } from '@littlebearapps/platform-consumer-sdk';

// =============================================================================
// ERROR LOGGING HELPERS
// =============================================================================

/**
 * Create a safe partial payload for logging (truncates to maxLength chars).
 * Redacts correlation_id to keep logs shorter while preserving debugging context.
 */
function createPartialPayload(telemetry: TelemetryMessage, maxLength = 500): string {
  const summary = {
    feature_key: telemetry.feature_key,
    project: telemetry.project,
    category: telemetry.category,
    feature: telemetry.feature,
    timestamp: telemetry.timestamp,
    is_heartbeat: telemetry.is_heartbeat,
    error_category: telemetry.error_category,
    error_count: telemetry.error_count,
    metrics_keys: Object.keys(telemetry.metrics).filter(
      (k) => (telemetry.metrics as Record<string, number>)[k] > 0
    ),
  };
  const json = JSON.stringify(summary);
  return json.length > maxLength ? json.slice(0, maxLength) + '...' : json;
}

/**
 * Generate an error fingerprint for deduplication in logs.
 * Combines error name, category, and first line of stack trace.
 */
function generateErrorFingerprint(error: unknown): string {
  if (!(error instanceof Error)) {
    return `unknown:${String(error).slice(0, 50)}`;
  }

  const category = categoriseError(error);
  const code = extractErrorCode(error) || 'no_code';
  const stackLine = error.stack?.split('\n')[1]?.trim().slice(0, 80) || 'no_stack';

  return `${category}:${code}:${error.name}:${stackLine}`;
}

// =============================================================================
// ERROR SAMPLING
// =============================================================================

/**
 * Error sampling configuration.
 * Reduces D1 writes during high error rate periods.
 */
interface ErrorSamplingConfig {
  /** Error rate threshold to trigger sampling (e.g., 0.1 = 10%) */
  triggerThreshold: number;
  /** Sample rate when triggered (e.g., 0.1 = keep 10%) */
  sampleRate: number;
  /** Error categories that are never sampled (always stored) */
  neverSampleCategories: string[];
}

const ERROR_SAMPLING_CONFIG: ErrorSamplingConfig = {
  triggerThreshold: 0.1, // 10% error rate
  sampleRate: 0.1, // Keep 10% of errors when sampling
  neverSampleCategories: ['CIRCUIT_BREAKER', 'AUTH', 'INTERNAL'],
};

/**
 * Per-batch error sampling state.
 * Tracks error counts across the batch for adaptive sampling.
 */
interface ErrorSamplingState {
  totalErrors: number;
  sampledErrors: number;
  totalMessages: number;
  samplingActive: boolean;
}

/**
 * Determine if an error should be sampled (stored in D1).
 * Returns true if the error should be stored, false to skip.
 *
 * @param telemetry - The telemetry message with error
 * @param state - Current batch sampling state
 * @returns Whether to store this error in D1
 */
function shouldStoreError(telemetry: TelemetryMessage, state: ErrorSamplingState): boolean {
  // Never sample critical error categories
  if (
    telemetry.error_category &&
    ERROR_SAMPLING_CONFIG.neverSampleCategories.includes(telemetry.error_category)
  ) {
    return true;
  }

  // Calculate error rate for the batch
  const errorRate = state.totalMessages > 0 ? state.totalErrors / state.totalMessages : 0;

  // If error rate below threshold, store all errors
  if (errorRate < ERROR_SAMPLING_CONFIG.triggerThreshold) {
    return true;
  }

  // Sampling is active - use probabilistic sampling
  state.samplingActive = true;
  return Math.random() < ERROR_SAMPLING_CONFIG.sampleRate;
}

/**
 * Create initial sampling state for a batch.
 */
function createSamplingState(): ErrorSamplingState {
  return {
    totalErrors: 0,
    sampledErrors: 0,
    totalMessages: 0,
    samplingActive: false,
  };
}

// =============================================================================
// HEARTBEAT HANDLING
// =============================================================================

/**
 * Handle a heartbeat message from health checks.
 * Writes to Analytics Engine (zeros) and upserts to D1 health_checks table.
 */
async function handleHeartbeat(telemetry: TelemetryMessage, env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  // Write to Analytics Engine with zeros (for consistency, shows heartbeat was processed)
  env.PLATFORM_ANALYTICS.writeDataPoint({
    blobs: [telemetry.project, telemetry.category, telemetry.feature],
    doubles: new Array(20).fill(0),
    indexes: [telemetry.feature_key],
  });

  // Upsert to D1 system_health_checks table
  await env.PLATFORM_DB.prepare(
    `
    INSERT INTO system_health_checks (id, project_id, feature_id, last_heartbeat, status, updated_at)
    VALUES (?1, ?2, ?3, ?4, 'healthy', ?4)
    ON CONFLICT (project_id, feature_id) DO UPDATE SET
      last_heartbeat = excluded.last_heartbeat,
      status = 'healthy',
      consecutive_failures = 0,
      updated_at = excluded.updated_at
  `
  )
    .bind(crypto.randomUUID(), telemetry.project, telemetry.feature_key, now)
    .run();

  // Note: logger not created per call - this is a hot path
  // Using inline log to avoid overhead
}

// =============================================================================
// ERROR ALERTING
// =============================================================================

/**
 * Check if telemetry message contains errors that warrant alerting.
 * Detects P0 conditions: circuit breaker trips, high error rates.
 * Uses adaptive sampling to reduce D1 writes during high error rate periods.
 */
async function checkAndAlertErrors(
  telemetry: TelemetryMessage,
  env: Env,
  samplingState: ErrorSamplingState
): Promise<void> {
  // Skip if no errors reported
  if (!telemetry.error_count || telemetry.error_count === 0) {
    return;
  }

  // P0 Condition 1: Circuit breaker error (always alert, always store)
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
    // Always store P0 errors
    await storeErrorEvent(telemetry, env);
    samplingState.sampledErrors++;
    return;
  }

  // Apply adaptive sampling for error storage
  if (shouldStoreError(telemetry, samplingState)) {
    await storeErrorEvent(telemetry, env);
    samplingState.sampledErrors++;
  }

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

/**
 * Store error event in D1 for aggregation and historical analysis.
 */
async function storeErrorEvent(telemetry: TelemetryMessage, env: Env): Promise<void> {
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

/**
 * Update error budget window for SLA tracking.
 * Aggregates success/error counts in 5-minute windows.
 */
async function updateErrorBudgetWindow(telemetry: TelemetryMessage, env: Env): Promise<void> {
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:sla-tracking');

  try {
    // Calculate 5-minute window boundaries
    const WINDOW_SIZE_SECONDS = 5 * 60; // 5 minutes
    const now = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(now / WINDOW_SIZE_SECONDS) * WINDOW_SIZE_SECONDS;
    const windowEnd = windowStart + WINDOW_SIZE_SECONDS;

    const hasError = (telemetry.error_count ?? 0) > 0;
    const errorCategory = telemetry.error_category;

    // Determine error category counts
    const timeoutIncrement = errorCategory === 'TIMEOUT' ? 1 : 0;
    const validationIncrement = errorCategory === 'VALIDATION' ? 1 : 0;
    const internalIncrement = errorCategory === 'INTERNAL' ? 1 : 0;
    const externalIncrement = errorCategory === 'EXTERNAL_API' ? 1 : 0;
    const otherIncrement =
      hasError &&
      !['TIMEOUT', 'VALIDATION', 'INTERNAL', 'EXTERNAL_API'].includes(errorCategory || '')
        ? 1
        : 0;

    // Upsert window record
    await env.PLATFORM_DB.prepare(
      `INSERT INTO error_budget_windows (
        id, feature_key, project, window_start, window_end,
        success_count, error_count, total_count,
        timeout_count, validation_count, internal_count, external_count, other_count,
        created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5,
        ?6, ?7, 1,
        ?8, ?9, ?10, ?11, ?12,
        unixepoch(), unixepoch()
      )
      ON CONFLICT(feature_key, window_start) DO UPDATE SET
        success_count = success_count + excluded.success_count,
        error_count = error_count + excluded.error_count,
        total_count = total_count + 1,
        timeout_count = timeout_count + excluded.timeout_count,
        validation_count = validation_count + excluded.validation_count,
        internal_count = internal_count + excluded.internal_count,
        external_count = external_count + excluded.external_count,
        other_count = other_count + excluded.other_count,
        updated_at = unixepoch()`
    )
      .bind(
        `${telemetry.feature_key}:${windowStart}`,
        telemetry.feature_key,
        telemetry.project,
        windowStart,
        windowEnd,
        hasError ? 0 : 1, // success_count
        hasError ? 1 : 0, // error_count
        timeoutIncrement,
        validationIncrement,
        internalIncrement,
        externalIncrement,
        otherIncrement
      )
      .run();
  } catch (error) {
    log.error('Failed to update error budget window', error);
  }
}

/**
 * Get error rate statistics for a feature over the sliding window.
 */
async function getErrorRateStats(
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

/**
 * Send error alert to alert-router.
 * Uses service binding if available, falls back to direct Slack.
 */
async function sendErrorAlert(env: Env, payload: ErrorAlertPayload): Promise<void> {
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
// AI MODEL USAGE PERSISTENCE
// =============================================================================

/**
 * Persist feature-level AI model usage to D1.
 * Called from queue consumer when telemetry includes aiModelBreakdown.
 * Uses upsert to aggregate invocations for the same feature/model/date.
 */
async function persistFeatureAIModelUsage(
  env: Env,
  featureKey: string,
  modelBreakdown: Record<string, number>,
  timestamp: Date
): Promise<number> {
  const usageDate = timestamp.toISOString().split('T')[0]; // YYYY-MM-DD
  let writes = 0;

  for (const [model, invocations] of Object.entries(modelBreakdown)) {
    if (invocations <= 0) continue;

    await env.PLATFORM_DB.prepare(
      `
      INSERT INTO feature_ai_model_usage (
        id, feature_key, model, usage_date, invocations, updated_at
      ) VALUES (?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT (feature_key, model, usage_date) DO UPDATE SET
        invocations = invocations + excluded.invocations,
        updated_at = unixepoch()
    `
    )
      .bind(generateId(), featureKey, model, usageDate, invocations)
      .run();
    writes++;
  }

  return writes;
}

// =============================================================================
// INTELLIGENT DEGRADATION
// =============================================================================

/**
 * Process intelligent degradation updates for features seen in a batch.
 * Updates reservoir sampling and PID controller state in KV.
 *
 * Shadow mode: Currently logs throttle rates without applying them.
 * Set ENABLE_THROTTLE_WRITES=true in env to write throttle rates to KV.
 */
async function processIntelligentDegradation(
  featureStates: Map<string, FeatureBatchState>,
  env: Env
): Promise<void> {
  if (featureStates.size === 0) return;

  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:intelligent-degradation');

  // Cast KV to work around type version mismatch between workers and lib modules
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const kv = env.PLATFORM_CACHE as any;
  const shadowMode = true; // TODO: Make configurable via env.ENABLE_THROTTLE_WRITES

  for (const [featureKey, batchState] of featureStates) {
    try {
      // 1. Update reservoir sampling with cpuMs samples
      if (batchState.cpuMsSamples.length > 0) {
        const reservoirState = await getReservoirState(featureKey, kv);
        for (const sample of batchState.cpuMsSamples) {
          addSample(reservoirState, sample);
        }
        await saveReservoirState(featureKey, reservoirState, kv);

        // Log percentiles periodically (every 100 samples)
        if (reservoirState.totalSeen % 100 === 0) {
          const percentiles = getPercentiles(reservoirState);
          if (percentiles) {
            log.info('Feature latency', {
              featureKey,
              latency: formatPercentiles(percentiles),
            });
          }
        }
      }

      // 2. Update PID controller if enough time has passed (60s interval)
      const pidState = await getPIDState(featureKey, kv);
      if (shouldUpdatePID(pidState.lastUpdate, 60_000)) {
        // Get current budget utilisation from KV
        // For now, use BCU as a proxy for utilisation
        // TODO: Get actual budget limit from CONFIG:FEATURE:{id}:BUDGET
        const budgetLimit = 10000; // Default BCU budget per 60s interval
        const currentUsage = calculateUtilisation(batchState.bcuTotal, budgetLimit);
        const deltaTimeMs = Date.now() - pidState.lastUpdate;

        const pidOutput = computePID(pidState, { currentUsage, deltaTimeMs });

        if (shadowMode) {
          // Shadow mode: log but don't write throttle rate to KV
          if (pidOutput.throttleRate > 0.01) {
            log.info('SHADOW throttle', {
              featureKey,
              throttle: formatThrottleRate(pidOutput.throttleRate),
              usagePct: (currentUsage * 100).toFixed(1),
              bcu: batchState.bcuTotal,
            });
          }
          // Still save PID state to maintain continuity
          pidOutput.newState.throttleRate = 0; // Don't persist throttle in shadow mode
          await kv.put(`STATE:PID:${featureKey}`, JSON.stringify(pidOutput.newState), {
            expirationTtl: 86400,
          });
        } else {
          // Active mode: save state and write throttle rate to KV
          await savePIDState(featureKey, pidOutput.newState, kv);
          if (pidOutput.throttleRate > 0.01) {
            log.info('Throttle applied', {
              featureKey,
              throttle: formatThrottleRate(pidOutput.throttleRate),
              usagePct: (currentUsage * 100).toFixed(1),
            });
          }
        }
      }

      // 3. Log BCU summary for monitoring
      if (batchState.bcuTotal > 1000) {
        // Only log significant BCU usage
        const bcuResult = { total: batchState.bcuTotal } as BCUResult;
        log.info('BCU summary', {
          featureKey,
          bcu: formatBCUResult(bcuResult),
          messages: batchState.messageCount,
        });
      }
    } catch (error) {
      // Don't fail the batch for intelligent degradation errors
      log.error(`Error processing ${featureKey}`, error);
    }
  }
}

// =============================================================================
// MAIN QUEUE HANDLER
// =============================================================================

/**
 * Main queue consumer handler for telemetry messages.
 * Processes batches of TelemetryMessage from the platform-telemetry queue.
 *
 * Processing steps per message:
 * 1. Handle heartbeat messages (write zeros, update health check)
 * 2. Write metrics to Analytics Engine
 * 3. Accumulate intelligent degradation data
 * 4. Check budget and update status if exceeded
 * 5. Check for errors and send alerts if needed
 * 6. Persist AI model breakdown to D1 if present
 *
 * After batch processing:
 * - Process intelligent degradation updates for all features seen
 */
async function handleQueue(batch: MessageBatch<TelemetryMessage>, env: Env): Promise<void> {
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:telemetry');
  log.info('Processing batch', { messages: batch.messages.length });

  let successCount = 0;
  let errorCount = 0;
  let heartbeatCount = 0;

  // Accumulate state per feature for intelligent degradation
  // This allows batch-level KV operations instead of per-message
  const featureStates = new Map<string, FeatureBatchState>();

  // Error sampling state for adaptive D1 write reduction during incidents
  const samplingState = createSamplingState();
  samplingState.totalMessages = batch.messages.length;

  for (const message of batch.messages) {
    try {
      const telemetry = message.body;

      // Handle heartbeat messages differently (skip budget check)
      if (telemetry.is_heartbeat) {
        await handleHeartbeat(telemetry, env);
        message.ack();
        heartbeatCount++;
        successCount++;
        continue;
      }

      // Calculate total cost (CF resources + external APIs)
      const cfCost = calculateCFCostFromMetrics(telemetry.metrics);
      const externalCost = telemetry.external_cost_usd ?? 0;
      const totalCost = cfCost + externalCost;

      // Write to Analytics Engine
      // Schema must match METRIC_FIELDS order from constants.ts:
      // - blobs: [project, category, feature] (feature_key is in indexes)
      // - doubles: ordered per METRIC_FIELDS (d1Writes, d1Reads, kvReads, ...)
      // Note: AE has a hard limit of 20 doubles
      env.PLATFORM_ANALYTICS.writeDataPoint({
        blobs: [
          telemetry.project, // blob1: project
          telemetry.category, // blob2: category
          telemetry.feature, // blob3: feature
        ],
        doubles: [
          // Legacy fields (positions 1-12) - DO NOT REORDER
          telemetry.metrics.d1Writes ?? 0, // double1
          telemetry.metrics.d1Reads ?? 0, // double2
          telemetry.metrics.kvReads ?? 0, // double3
          telemetry.metrics.kvWrites ?? 0, // double4
          telemetry.metrics.doRequests ?? 0, // double5
          telemetry.metrics.doGbSeconds ?? 0, // double6
          telemetry.metrics.r2ClassA ?? 0, // double7
          telemetry.metrics.r2ClassB ?? 0, // double8
          telemetry.metrics.aiNeurons ?? 0, // double9
          telemetry.metrics.queueMessages ?? 0, // double10
          telemetry.metrics.requests ?? 0, // double11
          telemetry.metrics.cpuMs ?? 0, // double12
          // Extended fields (positions 13-20) - APPEND ONLY (20 field limit)
          telemetry.metrics.d1RowsRead ?? 0, // double13
          telemetry.metrics.d1RowsWritten ?? 0, // double14
          telemetry.metrics.kvDeletes ?? 0, // double15
          telemetry.metrics.kvLists ?? 0, // double16
          telemetry.metrics.aiRequests ?? 0, // double17
          telemetry.metrics.vectorizeQueries ?? 0, // double18
          telemetry.metrics.vectorizeInserts ?? 0, // double19
          // 2026-01-27: Repurposed from workflowInvocations (free in beta) for external API cost tracking
          externalCost, // double20: external_cost_usd (OpenAI, Apify, etc.)
        ],
        indexes: [telemetry.feature_key],
      });

      // Accumulate intelligent degradation data for this feature
      const featureKey = telemetry.feature_key;
      let state = featureStates.get(featureKey);
      if (!state) {
        state = { cpuMsSamples: [], bcuTotal: 0, messageCount: 0, lastTimestamp: 0 };
        featureStates.set(featureKey, state);
      }

      // Collect cpuMs sample for reservoir
      const cpuMs = telemetry.metrics.cpuMs ?? 0;
      if (cpuMs > 0) {
        state.cpuMsSamples.push(cpuMs);
      }

      // Calculate BCU for this message
      const bcuResult = calculateBCU(telemetry.metrics);
      state.bcuTotal += bcuResult.total;
      state.messageCount++;
      state.lastTimestamp = Math.max(state.lastTimestamp, telemetry.timestamp);

      // Check budget and update status if exceeded
      await checkAndUpdateBudgetStatus(telemetry.feature_key, telemetry.metrics, env);

      // Check cost budget if there's a cost to track
      if (totalCost > 0) {
        await checkAndUpdateCostBudgetStatus(telemetry.feature_key, totalCost, env);
      }

      // Track total errors for sampling calculation
      if (telemetry.error_count && telemetry.error_count > 0) {
        samplingState.totalErrors++;
      }

      // Check for errors and send alerts if needed (with adaptive sampling)
      await checkAndAlertErrors(telemetry, env, samplingState);

      // Update error budget window for SLA tracking
      await updateErrorBudgetWindow(telemetry, env);

      // Persist AI model breakdown to D1 if present
      if (telemetry.metrics.aiModelBreakdown) {
        await persistFeatureAIModelUsage(
          env,
          telemetry.feature_key,
          telemetry.metrics.aiModelBreakdown,
          new Date(telemetry.timestamp)
        );
      }

      message.ack();
      successCount++;
    } catch (error) {
      // Enhanced error logging with full context for debugging
      const telemetry = message.body;
      const errorCategory = categoriseError(error);
      const errorCode = extractErrorCode(error);
      const fingerprint = generateErrorFingerprint(error);

      log.error('Error processing telemetry message', error, {
        feature_key: telemetry.feature_key,
        project: telemetry.project,
        category: telemetry.category,
        error_category: errorCategory,
        error_code: errorCode,
        fingerprint,
        partial_payload: createPartialPayload(telemetry),
        correlation_id: telemetry.correlation_id,
      });

      message.retry();
      errorCount++;
    }
  }

  // Process intelligent degradation updates for each feature seen in batch
  // This is done after message processing to not block the main loop
  await processIntelligentDegradation(featureStates, env);

  // Log batch summary with error rate and sampling info for monitoring
  if (errorCount > 0) {
    const errorRate = ((errorCount / batch.messages.length) * 100).toFixed(1);
    log.warn('Batch complete with errors', {
      success: successCount,
      heartbeats: heartbeatCount,
      errors: errorCount,
      total: batch.messages.length,
      error_rate_pct: errorRate,
      sampling_active: samplingState.samplingActive,
      errors_sampled: samplingState.sampledErrors,
      errors_total: samplingState.totalErrors,
    });
  } else {
    log.info('Batch complete', {
      success: successCount,
      heartbeats: heartbeatCount,
      errors: errorCount,
    });
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

export {
  // Main queue handler
  handleQueue,
  // Heartbeat handling
  handleHeartbeat,
  // Intelligent degradation
  processIntelligentDegradation,
  // Error alerting
  checkAndAlertErrors,
  storeErrorEvent,
  getErrorRateStats,
  sendErrorAlert,
  // AI model usage
  persistFeatureAIModelUsage,
};

// Re-export checkAndUpdateBudgetStatus from budget-enforcement for backward compatibility
export { checkAndUpdateBudgetStatus } from './budget-enforcement';
