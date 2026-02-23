/// <reference types="@cloudflare/workers-types" />

/**
 * Platform SDK Telemetry
 *
 * Queue-based telemetry for reporting feature usage metrics.
 * Uses waitUntil for non-blocking telemetry submission.
 */

import type { FeatureId, FeatureMetrics, MetricsAccumulator, TelemetryMessage } from './types';
import { createLogger, type Logger } from './logging';

// =============================================================================
// MODULE LOGGER (lazy-initialized to avoid global scope crypto calls)
// =============================================================================

let _log: Logger | null = null;
function getLog(): Logger {
  if (!_log) {
    _log = createLogger({
      worker: 'platform-sdk',
      featureId: 'platform:sdk:telemetry',
    });
  }
  return _log;
}

// =============================================================================
// TYPES
// =============================================================================

/**
 * Telemetry context for a single request.
 */
export interface TelemetryContext {
  featureId: FeatureId;
  metrics: MetricsAccumulator;
  startTime: number;
  queue?: Queue<TelemetryMessage>;
  ctx?: ExecutionContext;
  correlationId?: string;
  /** W3C Trace ID for distributed tracing */
  traceId?: string;
  /** W3C Span ID for distributed tracing */
  spanId?: string;
  /** External API cost in USD (e.g., OpenAI, Apify) */
  externalCostUsd?: number;
}

// =============================================================================
// CONTEXT MANAGEMENT
// =============================================================================

/**
 * WeakMap to store telemetry context per proxied environment.
 * Using WeakMap allows garbage collection when env is no longer referenced.
 */
const telemetryContexts = new WeakMap<object, TelemetryContext>();

/**
 * Store telemetry context for a proxied environment.
 */
export function setTelemetryContext(env: object, context: TelemetryContext): void {
  telemetryContexts.set(env, context);
}

/**
 * Get telemetry context for a proxied environment.
 */
export function getTelemetryContext(env: object): TelemetryContext | undefined {
  return telemetryContexts.get(env);
}

/**
 * Remove telemetry context for a proxied environment.
 */
export function clearTelemetryContext(env: object): void {
  telemetryContexts.delete(env);
}

// =============================================================================
// TELEMETRY REPORTING
// =============================================================================

/**
 * Parse a feature ID into its component parts.
 */
function parseFeatureId(featureId: FeatureId): {
  project: string;
  category: string;
  feature: string;
} {
  const parts = featureId.split(':');
  if (parts.length !== 3) {
    throw new Error(
      `Invalid featureId format: "${featureId}". Expected "project:category:feature"`
    );
  }
  return {
    project: parts[0],
    category: parts[1],
    feature: parts[2],
  };
}

/**
 * Convert MetricsAccumulator to FeatureMetrics, excluding zero values.
 */
function accumulatorToMetrics(accumulator: MetricsAccumulator): FeatureMetrics {
  const metrics: FeatureMetrics = {};

  // Only include non-zero values
  if (accumulator.d1Writes > 0) metrics.d1Writes = accumulator.d1Writes;
  if (accumulator.d1Reads > 0) metrics.d1Reads = accumulator.d1Reads;
  if (accumulator.d1RowsRead > 0) metrics.d1RowsRead = accumulator.d1RowsRead;
  if (accumulator.d1RowsWritten > 0) metrics.d1RowsWritten = accumulator.d1RowsWritten;
  if (accumulator.kvReads > 0) metrics.kvReads = accumulator.kvReads;
  if (accumulator.kvWrites > 0) metrics.kvWrites = accumulator.kvWrites;
  if (accumulator.kvDeletes > 0) metrics.kvDeletes = accumulator.kvDeletes;
  if (accumulator.kvLists > 0) metrics.kvLists = accumulator.kvLists;
  if (accumulator.aiRequests > 0) metrics.aiRequests = accumulator.aiRequests;
  if (accumulator.aiNeurons > 0) metrics.aiNeurons = accumulator.aiNeurons;
  // Convert Map to object for JSON serialization
  if (accumulator.aiModelCounts.size > 0) {
    metrics.aiModelBreakdown = Object.fromEntries(accumulator.aiModelCounts);
  }
  if (accumulator.vectorizeQueries > 0) metrics.vectorizeQueries = accumulator.vectorizeQueries;
  if (accumulator.vectorizeInserts > 0) metrics.vectorizeInserts = accumulator.vectorizeInserts;
  // vectorizeDeletes removed - Analytics Engine 20 double limit

  // R2
  if (accumulator.r2ClassA > 0) metrics.r2ClassA = accumulator.r2ClassA;
  if (accumulator.r2ClassB > 0) metrics.r2ClassB = accumulator.r2ClassB;

  // Queue
  if (accumulator.queueMessages > 0) metrics.queueMessages = accumulator.queueMessages;

  // Durable Objects
  if (accumulator.doRequests > 0) metrics.doRequests = accumulator.doRequests;

  // DO latency stats (only if we have samples)
  if (accumulator.doRequests > 0 && accumulator.doLatencyMs.length > 0) {
    const sorted = [...accumulator.doLatencyMs].sort((a, b) => a - b);
    metrics.doAvgLatencyMs = accumulator.doTotalLatencyMs / accumulator.doLatencyMs.length;
    metrics.doMaxLatencyMs = sorted[sorted.length - 1];
    const p99Index = Math.ceil(sorted.length * 0.99) - 1;
    metrics.doP99LatencyMs = sorted[Math.max(0, p99Index)];
  }

  // Workflow
  if (accumulator.workflowInvocations > 0)
    metrics.workflowInvocations = accumulator.workflowInvocations;

  return metrics;
}

/**
 * Check if a telemetry message has any data worth reporting.
 */
function hasDataToReport(message: TelemetryMessage): boolean {
  const hasMetrics = Object.values(message.metrics).some((v) => typeof v === 'number' && v > 0);
  const hasErrors = (message.error_count ?? 0) > 0;
  return hasMetrics || hasErrors;
}

/**
 * Build telemetry message from context.
 */
function buildTelemetryMessage(context: TelemetryContext): TelemetryMessage {
  const { project, category, feature } = parseFeatureId(context.featureId);
  const metrics = accumulatorToMetrics(context.metrics);

  const message: TelemetryMessage = {
    feature_key: context.featureId,
    project,
    category,
    feature,
    metrics,
    timestamp: Date.now(),
  };

  // Include error information if present
  if (context.metrics.errorCount > 0) {
    message.error_count = context.metrics.errorCount;
  }
  if (context.metrics.lastErrorCategory) {
    message.error_category = context.metrics.lastErrorCategory;
  }
  if (context.metrics.errorCodes.length > 0) {
    message.error_codes = context.metrics.errorCodes;
  }
  if (context.correlationId) {
    message.correlation_id = context.correlationId;
  }

  // Include request duration (wall-clock time)
  const durationMs = Date.now() - context.startTime;
  if (durationMs > 0) {
    message.request_duration_ms = durationMs;
  }

  // Include distributed tracing context
  if (context.traceId) {
    message.trace_id = context.traceId;
  }
  if (context.spanId) {
    message.span_id = context.spanId;
  }

  // Include external cost if provided
  if (context.externalCostUsd && context.externalCostUsd > 0) {
    message.external_cost_usd = context.externalCostUsd;
  }

  return message;
}

/**
 * Flush metrics to the telemetry queue.
 *
 * This is called automatically when the request completes.
 * Uses waitUntil if ExecutionContext is available, otherwise awaits directly.
 *
 * @param env - The proxied environment object
 * @returns Promise that resolves when flush is scheduled (not completed)
 */
export async function flushMetrics(env: object): Promise<void> {
  const context = getTelemetryContext(env);
  if (!context) {
    getLog().warn('flushMetrics called without telemetry context');
    return;
  }

  // Build the message
  const message = buildTelemetryMessage(context);

  // Skip if nothing to report
  if (!hasDataToReport(message)) {
    clearTelemetryContext(env);
    return;
  }

  // Send to queue - always await to ensure send completes
  // Also use waitUntil if ctx is available as a safety net
  const sendPromise = sendToQueue(context.queue, message);
  if (context.ctx?.waitUntil) {
    context.ctx.waitUntil(sendPromise);
  }
  await sendPromise;

  // Clean up context
  clearTelemetryContext(env);
}

/**
 * Send telemetry message to queue with error handling.
 * Fails open - errors are logged but don't break the request.
 */
async function sendToQueue(
  queue: Queue<TelemetryMessage> | undefined,
  message: TelemetryMessage
): Promise<void> {
  if (!queue) {
    // No queue binding - log warning but don't fail
    getLog().warn('No PLATFORM_TELEMETRY queue binding, metrics not sent', undefined, {
      featureKey: message.feature_key,
    });
    return;
  }

  try {
    await queue.send(message);
    getLog().debug('Telemetry sent', {
      featureKey: message.feature_key,
      metrics: message.metrics,
    });
  } catch (error) {
    // Fail open - log error but don't throw
    getLog().error('Failed to send telemetry', error, { featureKey: message.feature_key });
  }
}

/**
 * Schedule telemetry flush using waitUntil.
 * This is the preferred method when ExecutionContext is available.
 *
 * @param ctx - ExecutionContext from the worker
 * @param env - The proxied environment object
 */
export function scheduleFlush(ctx: ExecutionContext, env: object): void {
  ctx.waitUntil(flushMetrics(env));
}

// =============================================================================
// DIRECT REPORTING (for use outside proxied context)
// =============================================================================

/**
 * Check if metrics have any non-zero values.
 */
function hasMetrics(metrics: FeatureMetrics): boolean {
  return Object.values(metrics).some((v) => typeof v === 'number' && v > 0);
}

/**
 * Report usage metrics directly without proxy tracking.
 * Use this for manual metric reporting in edge cases.
 *
 * @param featureId - Feature identifier (project:category:feature)
 * @param metrics - Metrics to report
 * @param queue - Telemetry queue binding
 * @param ctx - Optional ExecutionContext for waitUntil
 */
export async function reportUsage(
  featureId: FeatureId,
  metrics: FeatureMetrics,
  queue: Queue<TelemetryMessage>,
  ctx?: ExecutionContext
): Promise<void> {
  if (!hasMetrics(metrics)) {
    return;
  }

  const { project, category, feature } = parseFeatureId(featureId);

  const message: TelemetryMessage = {
    feature_key: featureId,
    project,
    category,
    feature,
    metrics,
    timestamp: Date.now(),
  };

  const sendPromise = sendToQueue(queue, message);

  if (ctx?.waitUntil) {
    ctx.waitUntil(sendPromise);
  } else {
    await sendPromise;
  }
}
