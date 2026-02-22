/// <reference types="@cloudflare/workers-types" />

/**
 * Platform SDK Types
 *
 * Shared type definitions for the Platform SDK.
 */

// =============================================================================
// FEATURE IDENTIFICATION
// =============================================================================

/**
 * Feature identifier string in format 'project:category:feature'
 * Example: 'scout:ocr:process', 'brand-copilot:scanner:github'
 */
export type FeatureId = string;

/**
 * Parsed feature configuration from a FeatureId.
 */
export interface FeatureConfig {
  project: string;
  category: string;
  feature: string;
}

// =============================================================================
// METRICS
// =============================================================================

/**
 * Resource metrics tracked per feature invocation.
 * All fields are optional - only tracked resources are included.
 */
export interface FeatureMetrics {
  // D1 Database
  d1Writes?: number;
  d1Reads?: number;
  d1RowsRead?: number;
  d1RowsWritten?: number;

  // KV Namespace
  kvReads?: number;
  kvWrites?: number;
  kvDeletes?: number;
  kvLists?: number;

  // Workers AI
  aiRequests?: number;
  aiNeurons?: number;
  aiModelBreakdown?: Record<string, number>; // model name → invocation count

  // Vectorize (vectorizeDeletes removed - Analytics Engine 20 double limit)
  vectorizeQueries?: number;
  vectorizeInserts?: number;

  // Durable Objects
  doRequests?: number;
  doGbSeconds?: number;
  doAvgLatencyMs?: number;
  doMaxLatencyMs?: number;
  doP99LatencyMs?: number;

  // R2
  r2ClassA?: number;
  r2ClassB?: number;

  // Queue
  queueMessages?: number;

  // Workflow
  workflowInvocations?: number;

  // General
  requests?: number;
  cpuMs?: number;
}

/**
 * Error category for classification in telemetry.
 * Used for alerting priority and deduplication.
 */
export type ErrorCategory =
  | 'VALIDATION'
  | 'NETWORK'
  | 'CIRCUIT_BREAKER'
  | 'INTERNAL'
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'D1_ERROR'
  | 'KV_ERROR'
  | 'QUEUE_ERROR'
  | 'EXTERNAL_API'
  | 'TIMEOUT';

/**
 * Internal metrics accumulator used during request processing.
 * Mutable version of FeatureMetrics for tracking.
 */
export interface MetricsAccumulator {
  d1Writes: number;
  d1Reads: number;
  d1RowsRead: number;
  d1RowsWritten: number;
  kvReads: number;
  kvWrites: number;
  kvDeletes: number;
  kvLists: number;
  aiRequests: number;
  aiNeurons: number;
  aiModelCounts: Map<string, number>; // mutable map for model name accumulation
  vectorizeQueries: number;
  vectorizeInserts: number;
  // R2
  r2ClassA: number;
  r2ClassB: number;
  // Queue
  queueMessages: number;
  // Durable Objects
  doRequests: number;
  doLatencyMs: number[]; // Array for percentile calculation
  doTotalLatencyMs: number; // Sum for average
  // Workflow
  workflowInvocations: number;
  // Error tracking
  errorCount: number;
  lastErrorCategory: ErrorCategory | null;
  errorCodes: string[];
}

/**
 * Create a fresh metrics accumulator with all values at zero.
 */
export function createMetricsAccumulator(): MetricsAccumulator {
  return {
    d1Writes: 0,
    d1Reads: 0,
    d1RowsRead: 0,
    d1RowsWritten: 0,
    kvReads: 0,
    kvWrites: 0,
    kvDeletes: 0,
    kvLists: 0,
    aiRequests: 0,
    aiNeurons: 0,
    aiModelCounts: new Map<string, number>(),
    vectorizeQueries: 0,
    vectorizeInserts: 0,
    // R2
    r2ClassA: 0,
    r2ClassB: 0,
    // Queue
    queueMessages: 0,
    // Durable Objects
    doRequests: 0,
    doLatencyMs: [],
    doTotalLatencyMs: 0,
    // Workflow
    workflowInvocations: 0,
    // Error tracking
    errorCount: 0,
    lastErrorCategory: null,
    errorCodes: [],
  };
}

// =============================================================================
// TELEMETRY
// =============================================================================

/**
 * Queue message format for telemetry.
 * Sent to PLATFORM_TELEMETRY queue for processing by consumer.
 */
export interface TelemetryMessage {
  /** Feature key in format 'project:category:feature' */
  feature_key: string;
  /** Project name */
  project: string;
  /** Category within project */
  category: string;
  /** Specific feature */
  feature: string;
  /** Usage metrics for this invocation */
  metrics: FeatureMetrics;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** True for health check probes (skips budget check, records in D1) */
  is_heartbeat?: boolean;
  /** Error count for this invocation */
  error_count?: number;
  /** Most recent error category */
  error_category?: ErrorCategory;
  /** Error codes encountered */
  error_codes?: string[];
  /** Correlation ID for request tracing */
  correlation_id?: string;
  /** Request wall-clock duration in milliseconds */
  request_duration_ms?: number;
  /** W3C Trace ID for distributed tracing */
  trace_id?: string;
  /** W3C Span ID for distributed tracing */
  span_id?: string;
  /** External API cost in USD (e.g., OpenAI, Apify) */
  external_cost_usd?: number;
}

// =============================================================================
// CIRCUIT BREAKER
// =============================================================================

/**
 * Circuit breaker status values.
 */
export type CircuitStatus = 'GO' | 'STOP';

/**
 * Circuit breaker check result.
 */
export interface CircuitBreakerResult {
  status: CircuitStatus;
  reason?: string;
  level: 'feature' | 'project' | 'global';
}

/**
 * Error thrown when a circuit breaker is open (STOP).
 * Workers should catch this and return 503 Service Unavailable.
 */
export class CircuitBreakerError extends Error {
  public readonly featureId: FeatureId;
  public readonly level: 'feature' | 'project' | 'global';
  public readonly reason?: string;

  constructor(featureId: FeatureId, level: 'feature' | 'project' | 'global', reason?: string) {
    const message = reason
      ? `Circuit breaker STOP for ${featureId} at ${level} level: ${reason}`
      : `Circuit breaker STOP for ${featureId} at ${level} level`;
    super(message);
    this.name = 'CircuitBreakerError';
    this.featureId = featureId;
    this.level = level;
    this.reason = reason;

    // Maintain proper stack trace in V8 (optional - not available in all environments)
    const ErrorWithCapture = Error as typeof Error & {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
      captureStackTrace?: (target: object, constructor?: Function) => void;
    };
    if (ErrorWithCapture.captureStackTrace) {
      ErrorWithCapture.captureStackTrace(this, CircuitBreakerError);
    }
  }
}

// =============================================================================
// SDK OPTIONS
// =============================================================================

/**
 * Options for withFeatureBudget wrapper.
 */
export interface SDKOptions {
  /**
   * ExecutionContext for waitUntil support.
   * Required for proper telemetry flushing.
   */
  ctx?: ExecutionContext;

  /**
   * Whether to check circuit breaker before processing.
   * Default: true
   */
  checkCircuitBreaker?: boolean;

  /**
   * Whether to report telemetry after processing.
   * Default: true
   */
  reportTelemetry?: boolean;

  /**
   * Custom KV namespace for circuit breaker state.
   * Default: env.PLATFORM_CACHE
   */
  cacheKv?: KVNamespace;

  /**
   * Custom queue for telemetry.
   * Default: env.PLATFORM_TELEMETRY
   */
  telemetryQueue?: Queue<TelemetryMessage>;

  /**
   * Correlation ID for request tracing.
   * If not provided, one will be generated automatically.
   */
  correlationId?: string;

  /**
   * External API cost in USD (e.g., OpenAI, Apify).
   * Added to auto-calculated CF resource costs.
   * @default 0
   */
  externalCostUsd?: number;
}

// =============================================================================
// CRON/QUEUE HELPER OPTIONS
// =============================================================================

/**
 * Options for withCronBudget wrapper.
 * Extends SDKOptions with cron-specific fields.
 *
 * @example
 * ```typescript
 * withCronBudget(env, 'platform:cron:cleanup', {
 *   ctx,
 *   cronExpression: '0 0 * * *',
 * });
 * ```
 */
export interface CronBudgetOptions {
  /**
   * ExecutionContext - REQUIRED for cron handlers.
   * Used for waitUntil support and proper telemetry flushing.
   */
  ctx: ExecutionContext;

  /**
   * Cron expression for this scheduled task.
   * Used to generate deterministic correlation IDs for tracing.
   * @example '0 0 * * *' (daily at midnight)
   * @example '0 * * * *' (hourly)
   */
  cronExpression?: string;

  /**
   * External API cost in USD (e.g., OpenAI, Apify).
   * Added to auto-calculated CF resource costs.
   * @default 0
   */
  externalCostUsd?: number;
}

/**
 * Options for withQueueBudget wrapper.
 * Extends SDKOptions with queue-specific fields.
 *
 * @example
 * ```typescript
 * withQueueBudget(env, 'platform:queue:process', {
 *   message: message.body,
 *   batchSize: batch.messages.length,
 * });
 * ```
 */
export interface QueueBudgetOptions<M = unknown> {
  /**
   * Queue message body for correlation ID extraction.
   * If the message has a `correlation_id` field, it will be propagated.
   */
  message?: M;

  /**
   * Number of messages in the current batch.
   * Logged for observability but not used for billing.
   */
  batchSize?: number;

  /**
   * Queue name for correlation ID generation.
   * @example 'platform-telemetry'
   */
  queueName?: string;

  /**
   * External API cost in USD (e.g., OpenAI, Apify).
   * Added to auto-calculated CF resource costs.
   * @default 0
   */
  externalCostUsd?: number;
}

// =============================================================================
// ENVIRONMENT BINDINGS
// =============================================================================

/**
 * Required environment bindings for Platform SDK.
 */
export interface PlatformBindings {
  /** KV namespace for circuit breaker state and config */
  PLATFORM_CACHE: KVNamespace;
  /** Queue for telemetry messages */
  PLATFORM_TELEMETRY: Queue<TelemetryMessage>;
}

/**
 * Type helper for environments that include Platform bindings.
 */
export type WithPlatformBindings<T> = T & PlatformBindings;

// =============================================================================
// HEALTH CHECK
// =============================================================================

/**
 * Result of a control plane health check (KV connectivity).
 */
export interface ControlPlaneHealth {
  /** Whether KV is accessible */
  healthy: boolean;
  /** Circuit breaker status if KV is accessible */
  status: CircuitStatus | 'UNKNOWN';
  /** Error message if unhealthy */
  error?: string;
}

/**
 * Result of a data plane health check (queue delivery).
 */
export interface DataPlaneHealth {
  /** Whether the queue accepted the heartbeat message */
  healthy: boolean;
  /** True if the queue send succeeded */
  queueSent: boolean;
  /** Error message if unhealthy */
  error?: string;
}

/**
 * Combined health check result for a feature.
 */
export interface HealthResult {
  /** Overall health (both planes must be healthy) */
  healthy: boolean;
  /** Control plane status (KV connectivity) */
  controlPlane: ControlPlaneHealth;
  /** Data plane status (queue delivery) */
  dataPlane: DataPlaneHealth;
  /** Project name from featureId */
  project: string;
  /** Feature key in format 'project:category:feature' */
  feature: string;
  /** Unix timestamp when check was performed */
  timestamp: number;
}

/**
 * Extended environment type returned by withFeatureBudget().
 * Includes health() method for dual-plane connectivity checks
 * and fetch() for tracked HTTP calls (auto-detects AI Gateway URLs).
 */
export type TrackedEnv<T> = T & {
  health(): Promise<HealthResult>;
  /**
   * Tracked fetch that auto-detects AI Gateway URLs.
   * AI Gateway calls are automatically tracked with provider/model extraction.
   * Non-AI Gateway calls pass through unchanged.
   */
  fetch: typeof fetch;
};
