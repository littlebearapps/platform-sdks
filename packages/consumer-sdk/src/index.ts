/// <reference types="@cloudflare/workers-types" />

/**
 * Platform SDK
 *
 * Automatic metric collection and circuit breaking for Cloudflare Workers.
 *
 * @example
 * ```typescript
 * import { withFeatureBudget, CircuitBreakerError } from '../lib/platform-sdk';
 *
 * export default {
 *   async fetch(request: Request, env: Env, ctx: ExecutionContext) {
 *     try {
 *       const trackedEnv = withFeatureBudget(env, 'scout:ocr:process', { ctx });
 *       const result = await trackedEnv.DB.prepare('SELECT...').all();
 *       return Response.json(result);
 *     } catch (e) {
 *       if (e instanceof CircuitBreakerError) {
 *         return Response.json({ error: 'Feature disabled' }, { status: 503 });
 *       }
 *       throw e;
 *     }
 *   }
 * };
 * ```
 */

// Re-export types
export {
  CircuitBreakerError,
  type CircuitBreakerResult,
  type CircuitStatus,
  type ControlPlaneHealth,
  type CronBudgetOptions,
  type DataPlaneHealth,
  type ErrorCategory,
  type FeatureConfig,
  type FeatureId,
  type FeatureMetrics,
  type HealthResult,
  type MetricsAccumulator,
  type PlatformBindings,
  type QueueBudgetOptions,
  type SDKOptions,
  type TelemetryMessage,
  type TrackedEnv,
  type WithPlatformBindings,
  createMetricsAccumulator,
} from './types';

// Re-export constants
export { BINDING_NAMES, CIRCUIT_STATUS, KV_KEYS, METRIC_FIELDS } from './constants';

// Re-export Platform feature IDs
export {
  // Ingest features
  INGEST_GITHUB,
  INGEST_STRIPE,
  INGEST_LOGGER,
  // Connector features
  CONNECTOR_STRIPE,
  CONNECTOR_ADS,
  CONNECTOR_GA4,
  CONNECTOR_PLAUSIBLE,
  // Monitor features
  MONITOR_ALERT_ROUTER,
  MONITOR_COST_SPIKE,
  MONITOR_OBSERVER,
  MONITOR_GITHUB,
  MONITOR_AUDITOR,
  MONITOR_PATTERN_DISCOVERY,
  // Discovery features
  DISCOVERY_TOPOLOGY,
  // Test features
  TEST_INGEST,
  TEST_QUERY,
  TEST_HEALTHCHECK,
  // Heartbeat
  HEARTBEAT_HEALTH,
  // Email
  EMAIL_HEALTHCHECK,
  // All features
  PLATFORM_FEATURES,
  getAllPlatformFeatures,
} from './features';

// Re-export telemetry utilities
export {
  flushMetrics,
  reportUsage,
  scheduleFlush,
  getTelemetryContext,
  setTelemetryContext,
  clearTelemetryContext,
  type TelemetryContext,
} from './telemetry';

// Re-export AI Gateway utilities
export {
  createAIGatewayFetch,
  createAIGatewayFetchWithBodyParsing,
  parseAIGatewayUrl,
  reportAIGatewayUsage,
  type AIGatewayProvider,
  type AIGatewayUrlInfo,
} from './ai-gateway';

// Re-export logging utilities
export {
  createLogger,
  createLoggerFromEnv,
  createLoggerFromRequest,
  extractCorrelationIdFromRequest,
  generateCorrelationId,
  getCorrelationId,
  setCorrelationId,
  type LogLevel,
  type Logger,
  type LoggerOptions,
  type StructuredLog,
  // Also export categoriseError from logging (same implementation)
  categoriseError as categoriseErrorFromLog,
} from './logging';

// Re-export error utilities
export {
  categoriseError,
  extractErrorCode,
  getErrorCount,
  hasErrors,
  reportError,
  reportErrorExplicit,
  trackError,
  withErrorTracking,
} from './errors';

// Re-export distributed tracing utilities
export {
  // Trace context management
  createTraceContext,
  extractTraceContext,
  getTraceContext,
  setTraceContext,
  createNewTraceContext,
  // ID generation
  generateTraceId,
  generateSpanId,
  // Parsing and serialization
  parseTraceparent,
  formatTraceparent,
  // Propagation
  propagateTraceContext,
  addTraceHeaders,
  createTracedFetch,
  // Span management
  startSpan,
  endSpan,
  failSpan,
  setSpanAttribute,
  // Utilities
  isSampled,
  shortTraceId,
  shortSpanId,
  formatTraceForLog,
  // Types
  type TraceContext,
  type Span,
} from './tracing';

// Re-export timeout utilities
export {
  withTimeout,
  withTrackedTimeout,
  withRequestTimeout,
  timeoutResponse,
  isTimeoutError,
  TimeoutError,
  DEFAULT_TIMEOUTS,
} from './timeout';

// Re-export service client utilities for cross-feature correlation
export {
  createServiceClient,
  createServiceBindingHeaders,
  wrapServiceBinding,
  extractCorrelationChain,
  CORRELATION_ID_HEADER,
  SOURCE_SERVICE_HEADER,
  TARGET_SERVICE_HEADER,
  FEATURE_ID_HEADER,
  type ServiceClient,
  type ServiceClientOptions,
  type CorrelationChain,
} from './service-client';

// Re-export DO heartbeat utilities
export {
  withHeartbeat,
  type DOClass,
  type HeartbeatConfig,
  type HeartbeatEnv,
} from './do-heartbeat';

// Re-export proxy utilities
export {
  // Proxy creators
  createAIProxy,
  createD1Proxy,
  createDOProxy,
  createEnvProxy,
  createKVProxy,
  createQueueProxy,
  createR2Proxy,
  createVectorizeProxy,
  createWorkflowProxy,
  // Utilities
  getMetrics,
  // Type guards
  isAIBinding,
  isD1Database,
  isDurableObjectNamespace,
  isKVNamespace,
  isQueue,
  isR2Bucket,
  isVectorizeIndex,
  isWorkflow,
} from './proxy';

// Internal imports
import {
  CircuitBreakerError,
  createMetricsAccumulator,
  type CircuitStatus,
  type ControlPlaneHealth,
  type CronBudgetOptions,
  type DataPlaneHealth,
  type FeatureId,
  type HealthResult,
  type QueueBudgetOptions,
  type SDKOptions,
  type TelemetryMessage,
  type TrackedEnv,
} from './types';
import { KV_KEYS, CIRCUIT_STATUS } from './constants';
import { setTelemetryContext, flushMetrics, type TelemetryContext } from './telemetry';
import { createEnvProxy } from './proxy';
import { setCorrelationId, getCorrelationId } from './logging';
import { getTraceContext } from './tracing';
import { parseAIGatewayUrl, reportAIGatewayUsage } from './ai-gateway';

// =============================================================================
// CIRCUIT BREAKER PROXY CONSTANTS (hoisted from get trap for performance)
// =============================================================================

/**
 * Properties that bypass circuit breaker checks entirely.
 * Platform bindings + Promise-related properties.
 */
const CB_SKIP_PROPS = new Set([
  'PLATFORM_CACHE',
  'PLATFORM_TELEMETRY',
  'then', // For Promise detection
  'catch',
  'finally',
]);

/**
 * Synchronous methods that must NOT be wrapped in async circuit breaker check.
 * These return immediately and wrapping would break their return value chain.
 * IMPORTANT: Must bind to innerTarget to preserve `this` context
 * for native Cloudflare binding methods (DO stubs, KV, R2, Fetcher, etc.)
 * Without binding: "Illegal invocation: function called with incorrect `this` reference"
 */
const CB_SYNC_METHODS = new Set([
  // D1Database: prepare() returns D1PreparedStatement synchronously
  'prepare',
  // D1PreparedStatement: bind() returns new D1PreparedStatement synchronously
  'bind',
  // DurableObjectNamespace: ALL methods are synchronous
  'get', // Returns DurableObjectStub
  'idFromName', // Returns DurableObjectId
  'idFromString', // Returns DurableObjectId
  'newUniqueId', // Returns DurableObjectId
  // R2Bucket: resumeMultipartUpload() returns R2MultipartUpload synchronously
  'resumeMultipartUpload',
  // Fetcher (service bindings): fetch/connect need correct `this` binding
  'fetch',
  'connect',
]);

// =============================================================================
// CIRCUIT BREAKER CHECK
// =============================================================================

/**
 * Cache for circuit breaker checks within a single request.
 * Keyed by feature ID to avoid redundant KV reads.
 */
const circuitBreakerCache = new Map<string, Promise<void>>();

/**
 * Clear the circuit breaker cache.
 * Primarily used for testing to ensure clean state between tests.
 */
export function clearCircuitBreakerCache(): void {
  circuitBreakerCache.clear();
}

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
 * Check circuit breaker status for a feature.
 * Checks in order: feature -> project -> global.
 * Throws CircuitBreakerError if any level is STOP.
 *
 * Uses per-request caching to avoid redundant KV reads.
 */
async function checkCircuitBreaker(featureId: FeatureId, kv: KVNamespace): Promise<void> {
  // Check cache first
  const cached = circuitBreakerCache.get(featureId);
  if (cached) {
    return cached;
  }

  // Create and cache the check promise
  const checkPromise = performCircuitBreakerCheck(featureId, kv);
  circuitBreakerCache.set(featureId, checkPromise);

  return checkPromise;
}

/**
 * Perform the actual circuit breaker check against KV.
 */
async function performCircuitBreakerCheck(featureId: FeatureId, kv: KVNamespace): Promise<void> {
  const { project } = parseFeatureId(featureId);

  // Check all levels in parallel for efficiency
  const [featureStatus, projectStatus, globalStatus, featureReason] = await Promise.all([
    kv.get(KV_KEYS.featureStatus(featureId)),
    kv.get(KV_KEYS.projectStatus(project)),
    kv.get(KV_KEYS.globalStatus()),
    kv.get(KV_KEYS.featureReason(featureId)),
  ]);

  // Check global first (highest priority)
  if (globalStatus === CIRCUIT_STATUS.STOP) {
    throw new CircuitBreakerError(featureId, 'global', 'Global circuit breaker is STOP');
  }

  // Check project level
  if (projectStatus === CIRCUIT_STATUS.STOP) {
    throw new CircuitBreakerError(
      featureId,
      'project',
      `Project ${project} circuit breaker is STOP`
    );
  }

  // Check feature level
  if (featureStatus === CIRCUIT_STATUS.STOP) {
    throw new CircuitBreakerError(featureId, 'feature', featureReason ?? undefined);
  }

  // Also check legacy format for backwards compatibility
  const legacyEnabled = await kv.get(KV_KEYS.legacy.enabled(featureId));
  if (legacyEnabled === 'false') {
    const legacyReason = await kv.get(KV_KEYS.legacy.disabledReason(featureId));
    throw new CircuitBreakerError(featureId, 'feature', legacyReason ?? undefined);
  }
}

// =============================================================================
// MAIN ENTRY POINT
// =============================================================================

/**
 * Wrap an environment with feature budget tracking.
 *
 * This is the main entry point for the Platform SDK.
 * Returns a proxied environment that:
 * 1. Checks circuit breaker status (throws CircuitBreakerError if STOP)
 * 2. Tracks all D1, KV, AI, and Vectorize operations
 * 3. Reports metrics to the telemetry queue on completion
 *
 * @param env - Worker environment with bindings
 * @param featureId - Feature identifier in format 'project:category:feature'
 * @param options - Optional configuration
 * @returns Proxied environment with tracked bindings
 * @throws CircuitBreakerError if the feature is disabled
 *
 * @example
 * ```typescript
 * const trackedEnv = withFeatureBudget(env, 'scout:ocr:process', { ctx });
 * const result = await trackedEnv.DB.prepare('SELECT...').all();
 * ```
 */
export function withFeatureBudget<T extends object>(
  env: T,
  featureId: FeatureId,
  options: SDKOptions = {}
): TrackedEnv<T> {
  const {
    ctx,
    checkCircuitBreaker: shouldCheck = true,
    reportTelemetry = true,
    cacheKv,
    telemetryQueue,
    correlationId: providedCorrelationId,
    externalCostUsd,
  } = options;

  // Set up correlation ID
  const correlationId = providedCorrelationId ?? getCorrelationId(env);
  if (providedCorrelationId) {
    setCorrelationId(env, providedCorrelationId);
  }

  // Validate feature ID format
  parseFeatureId(featureId);

  // Get KV and queue bindings
  const kv = cacheKv ?? (env as unknown as { PLATFORM_CACHE?: KVNamespace }).PLATFORM_CACHE;
  const queue =
    telemetryQueue ??
    (env as unknown as { PLATFORM_TELEMETRY?: Queue<TelemetryMessage> }).PLATFORM_TELEMETRY;

  // Create metrics accumulator
  const metrics = createMetricsAccumulator();

  // Create proxied environment
  const proxiedEnv = createEnvProxy(env, metrics);

  // Check circuit breaker synchronously by throwing on first binding access
  // This is the lazy/JIT approach - we only check when bindings are used
  let finalEnv: T;
  if (shouldCheck && kv) {
    // Wrap the proxy to check circuit breaker on first real binding access
    let circuitBreakerChecked = false;
    let circuitBreakerPromise: Promise<void> | null = null;
    // Cache for CB-wrapped bindings to avoid creating new Proxy on every access
    const cbWrappedBindings = new Map<string | symbol, unknown>();

    finalEnv = new Proxy(proxiedEnv, {
      get(target, prop) {
        if (!CB_SKIP_PROPS.has(String(prop)) && !circuitBreakerChecked) {
          // Trigger circuit breaker check on first non-platform binding access
          // The check is async but we don't block - errors propagate through proxy
          if (!circuitBreakerPromise) {
            circuitBreakerPromise = checkCircuitBreaker(featureId, kv).then(() => {
              circuitBreakerChecked = true;
            });
          }
        }

        // Return cached CB-wrapped binding if available
        if (cbWrappedBindings.has(prop)) {
          return cbWrappedBindings.get(prop);
        }

        const value = Reflect.get(target, prop);

        // If the value is a function or has async methods, wrap to check CB first
        if (typeof value === 'object' && value !== null && circuitBreakerPromise) {
          const wrapped = new Proxy(value, {
            get(innerTarget, innerProp) {
              const innerValue = Reflect.get(innerTarget, innerProp);

              if (typeof innerValue === 'function') {
                // Don't wrap synchronous builder methods, but MUST bind to preserve `this`
                if (CB_SYNC_METHODS.has(String(innerProp))) {
                  return innerValue.bind(innerTarget);
                }

                return async (...args: unknown[]) => {
                  // Ensure circuit breaker check completes before operation
                  await circuitBreakerPromise;
                  return (innerValue as (...args: unknown[]) => unknown).apply(innerTarget, args);
                };
              }

              return innerValue;
            },
          });

          cbWrappedBindings.set(prop, wrapped);
          return wrapped;
        }

        return value;
      },
    }) as T;
  } else {
    finalEnv = proxiedEnv;
  }

  // Add health() and fetch() methods to the tracked environment
  const envWithHealth = new Proxy(finalEnv, {
    get(target, prop) {
      if (prop === 'health') {
        return () => health(featureId, kv!, queue, ctx);
      }
      if (prop === 'fetch') {
        // Return a tracked fetch that auto-detects AI Gateway URLs
        return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

          const response = await fetch(input, init);

          // Track AI Gateway calls
          const parsed = parseAIGatewayUrl(url);
          if (parsed) {
            // Try to extract model from body for OpenAI/Anthropic
            let model = parsed.model;
            if (init?.body && typeof init.body === 'string') {
              try {
                const body = JSON.parse(init.body) as { model?: string };
                if (body.model && typeof body.model === 'string') {
                  model = body.model;
                }
              } catch {
                // Not JSON or no model field - use URL-derived model
              }
            }
            reportAIGatewayUsage(envWithHealth, parsed.provider, model);
          }

          return response;
        };
      }
      return Reflect.get(target, prop);
    },
  }) as TrackedEnv<T>;

  // Store telemetry context on the FINAL returned object
  // IMPORTANT: Must be set on envWithHealth (not finalEnv) so completeTracking can find it
  // IMPORTANT: User MUST call completeTracking(env) after operations are done.
  if (reportTelemetry) {
    // Get trace context if available (set by createLoggerFromRequest)
    const traceContext = getTraceContext(env);

    const telemetryContext: TelemetryContext = {
      featureId,
      metrics,
      startTime: Date.now(),
      queue,
      ctx,
      correlationId,
      traceId: traceContext?.traceId,
      spanId: traceContext?.spanId,
      externalCostUsd,
    };
    setTelemetryContext(envWithHealth, telemetryContext);
  }

  return envWithHealth;
}

/**
 * Complete tracking and flush metrics for a proxied environment.
 * REQUIRED: Must be called after all tracked operations are complete.
 *
 * If you provided `ctx` to withFeatureBudget, the flush will use ctx.waitUntil
 * for non-blocking submission. Otherwise it awaits the queue send directly.
 *
 * @param env - The proxied environment from withFeatureBudget
 *
 * @example
 * ```typescript
 * const trackedEnv = withFeatureBudget(env, 'my-app:api:users', { ctx });
 * await trackedEnv.DB.prepare('SELECT...').all();
 * await trackedEnv.KV.put('key', 'value');
 * await completeTracking(trackedEnv); // Flush metrics to queue
 * ```
 */
export async function completeTracking(env: object): Promise<void> {
  await flushMetrics(env);
}

// =============================================================================
// CIRCUIT BREAKER MANAGEMENT
// =============================================================================

/**
 * Manually check if a feature is enabled.
 * Returns true if enabled, false if disabled.
 *
 * @param featureId - Feature identifier
 * @param kv - KV namespace with circuit breaker state
 */
export async function isFeatureEnabled(featureId: FeatureId, kv: KVNamespace): Promise<boolean> {
  try {
    await checkCircuitBreaker(featureId, kv);
    return true;
  } catch (e) {
    if (e instanceof CircuitBreakerError) {
      return false;
    }
    throw e;
  }
}

/**
 * Set circuit breaker status for a feature.
 *
 * @param featureId - Feature identifier
 * @param status - 'GO' to enable, 'STOP' to disable
 * @param kv - KV namespace
 * @param reason - Optional reason for STOP status
 */
export async function setCircuitBreakerStatus(
  featureId: FeatureId,
  status: 'GO' | 'STOP',
  kv: KVNamespace,
  reason?: string
): Promise<void> {
  if (status === 'GO') {
    // Clear all circuit breaker keys
    await Promise.all([
      kv.delete(KV_KEYS.featureStatus(featureId)),
      kv.delete(KV_KEYS.featureReason(featureId)),
      kv.delete(KV_KEYS.featureDisabledAt(featureId)),
      kv.delete(KV_KEYS.featureAutoResetAt(featureId)),
    ]);
  } else {
    // Set STOP status
    await Promise.all([
      kv.put(KV_KEYS.featureStatus(featureId), CIRCUIT_STATUS.STOP),
      reason ? kv.put(KV_KEYS.featureReason(featureId), reason) : Promise.resolve(),
      kv.put(KV_KEYS.featureDisabledAt(featureId), Date.now().toString()),
    ]);
  }

  // Clear cache
  circuitBreakerCache.delete(featureId);
}

// =============================================================================
// HEALTH CHECK
// =============================================================================

/**
 * Check the health of the Platform SDK for a given feature.
 * Validates both control plane (KV connectivity) and data plane (queue delivery).
 *
 * @param featureId - Feature identifier in format 'project:category:feature'
 * @param kv - KV namespace for circuit breaker state
 * @param queue - Optional queue for telemetry (if provided, sends heartbeat probe)
 * @param ctx - Optional ExecutionContext for waitUntil
 * @returns HealthResult with status of both planes
 *
 * @example
 * ```typescript
 * const result = await health('scout:ocr:process', env.PLATFORM_CACHE, env.PLATFORM_TELEMETRY);
 * if (!result.healthy) {
 *   console.error('Platform unhealthy:', result);
 * }
 * ```
 */
export async function health(
  featureId: FeatureId,
  kv: KVNamespace,
  queue?: Queue<TelemetryMessage>,
  ctx?: ExecutionContext
): Promise<HealthResult> {
  const timestamp = Date.now();
  const { project, category, feature } = parseFeatureId(featureId);

  // Check control plane (KV connectivity and circuit breaker status)
  let controlPlane: ControlPlaneHealth;
  try {
    const [featureStatus, projectStatus, globalStatus] = await Promise.all([
      kv.get(KV_KEYS.featureStatus(featureId)),
      kv.get(KV_KEYS.projectStatus(project)),
      kv.get(KV_KEYS.globalStatus()),
    ]);

    // Determine circuit status (any STOP means STOP)
    let status: CircuitStatus = 'GO';
    if (
      globalStatus === CIRCUIT_STATUS.STOP ||
      projectStatus === CIRCUIT_STATUS.STOP ||
      featureStatus === CIRCUIT_STATUS.STOP
    ) {
      status = 'STOP';
    }

    controlPlane = { healthy: true, status };
  } catch (error) {
    controlPlane = {
      healthy: false,
      status: 'UNKNOWN',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // Check data plane (queue delivery) if queue is provided
  let dataPlane: DataPlaneHealth;
  if (queue) {
    try {
      const heartbeatMessage: TelemetryMessage = {
        feature_key: featureId,
        project,
        category,
        feature,
        metrics: {},
        timestamp,
        is_heartbeat: true,
      };

      // Send heartbeat to queue
      const sendPromise = queue.send(heartbeatMessage);
      if (ctx?.waitUntil) {
        ctx.waitUntil(sendPromise);
        dataPlane = { healthy: true, queueSent: true };
      } else {
        await sendPromise;
        dataPlane = { healthy: true, queueSent: true };
      }
    } catch (error) {
      dataPlane = {
        healthy: false,
        queueSent: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  } else {
    // No queue provided - skip data plane check
    dataPlane = { healthy: true, queueSent: false };
  }

  return {
    healthy: controlPlane.healthy && dataPlane.healthy,
    controlPlane,
    dataPlane,
    project,
    feature: featureId,
    timestamp,
  };
}

// =============================================================================
// CRON/QUEUE BUDGET HELPERS
// =============================================================================

/**
 * Wrap an environment for cron handler budget tracking.
 *
 * Thin wrapper over withFeatureBudget with cron-specific defaults:
 * - Generates deterministic correlation ID from cron expression + timestamp
 * - Requires ExecutionContext (compile-time enforcement)
 *
 * @param env - Worker environment with bindings
 * @param featureId - Feature identifier in format 'project:category:feature'
 * @param options - Cron-specific options (ctx required)
 * @returns Proxied environment with tracked bindings
 *
 * @example
 * ```typescript
 * export default {
 *   async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
 *     const trackedEnv = withCronBudget(env, 'platform:cron:cleanup', {
 *       ctx,
 *       cronExpression: event.cron,
 *     });
 *     await trackedEnv.DB.prepare('DELETE FROM old_records...').run();
 *     await completeTracking(trackedEnv);
 *   }
 * };
 * ```
 */
export function withCronBudget<T extends object>(
  env: T,
  featureId: FeatureId,
  options: CronBudgetOptions
): TrackedEnv<T> {
  const { ctx, cronExpression, externalCostUsd } = options;

  // Generate deterministic correlation ID from cron expression + timestamp
  // Format: cron:{expression}:{epochMs}
  const cronId = cronExpression
    ? `cron:${cronExpression.replace(/\s+/g, '-')}:${Date.now()}`
    : `cron:manual:${Date.now()}`;

  return withFeatureBudget(env, featureId, {
    ctx,
    correlationId: cronId,
    externalCostUsd,
  });
}

/**
 * Wrap an environment for queue handler budget tracking.
 *
 * Thin wrapper over withFeatureBudget with queue-specific defaults:
 * - Extracts correlation ID from message body if present
 * - Generates queue-prefixed correlation ID otherwise
 *
 * @param env - Worker environment with bindings
 * @param featureId - Feature identifier in format 'project:category:feature'
 * @param options - Queue-specific options
 * @returns Proxied environment with tracked bindings
 *
 * @example
 * ```typescript
 * export default {
 *   async queue(batch: MessageBatch<MyMessage>, env: Env) {
 *     for (const message of batch.messages) {
 *       const trackedEnv = withQueueBudget(env, 'platform:queue:process', {
 *         message: message.body,
 *         queueName: 'my-queue',
 *       });
 *       // Process message...
 *       await completeTracking(trackedEnv);
 *       message.ack();
 *     }
 *   }
 * };
 * ```
 */
export function withQueueBudget<T extends object, M = unknown>(
  env: T,
  featureId: FeatureId,
  options: QueueBudgetOptions<M> = {}
): TrackedEnv<T> {
  const { message, queueName, externalCostUsd } = options;

  // Try to extract correlation ID from message body
  let correlationId: string | undefined;

  if (message && typeof message === 'object' && message !== null) {
    const msgObj = message as Record<string, unknown>;
    if (typeof msgObj.correlation_id === 'string') {
      correlationId = msgObj.correlation_id;
    }
  }

  // Generate queue-prefixed correlation ID if not extracted
  if (!correlationId) {
    const queuePrefix = queueName ?? 'unknown';
    correlationId = `queue:${queuePrefix}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  }

  return withFeatureBudget(env, featureId, {
    correlationId,
    externalCostUsd,
    // Note: No ctx for queue handlers - they don't have ExecutionContext
    // Telemetry is flushed synchronously via completeTracking()
  });
}

// =============================================================================
// RE-EXPORTED PORTABLE UTILITIES
// =============================================================================

// Gatus heartbeat helper
export { pingHeartbeat } from './heartbeat';

// Exponential backoff retry
export { withExponentialBackoff } from './retry';

// Cloudflare pricing and cost calculation
export {
  HOURS_PER_MONTH,
  DAYS_PER_MONTH,
  PRICING_TIERS,
  PAID_ALLOWANCES,
  calculateHourlyCosts,
  prorateBaseCost,
  prorateBaseCostByDays,
  calculateDailyBillableCosts,
  type HourlyUsageMetrics,
  type HourlyCostBreakdown,
  type AccountDailyUsage,
  type DailyBillableCostBreakdown,
} from './costs';

// =============================================================================
// RE-EXPORTED MIDDLEWARE UTILITIES (v0.2.0)
// =============================================================================

// Project-level circuit breaker middleware
export {
  // Constants
  PROJECT_CB_STATUS,
  GLOBAL_STOP_KEY,
  CB_PROJECT_KEYS,
  CB_ERROR_CODES,
  BUDGET_STATUS_HEADER,
  // Functions
  createProjectKey,
  checkProjectCircuitBreaker,
  checkProjectCircuitBreakerDetailed,
  createCircuitBreakerMiddleware,
  getCircuitBreakerStates,
  getProjectStatus,
  setProjectStatus,
  isGlobalStopActive,
  setGlobalStop,
  // Types
  type CircuitBreakerStatusValue,
  type CircuitBreakerCheckResult,
  type CircuitBreakerMiddlewareOptions,
  type CircuitBreakerErrorResponse,
} from './middleware';

// Transient error patterns (zero I/O, fully portable)
export {
  TRANSIENT_ERROR_PATTERNS,
  classifyErrorAsTransient,
  type TransientErrorPattern,
} from './patterns';

// Dynamic patterns (KV-backed, AI-discovered)
export {
  // Constants
  DYNAMIC_PATTERNS_KV_KEY,
  // Functions
  loadDynamicPatterns,
  compileDynamicPatterns,
  clearDynamicPatternsCache,
  classifyWithDynamicPatterns,
  exportDynamicPatterns,
  importDynamicPatterns,
  // Types
  type DynamicPatternRule,
  type CompiledPattern,
  type ClassificationResult,
} from './dynamic-patterns';
