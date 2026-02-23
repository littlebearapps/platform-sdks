/**
 * Platform SDK Constants
 *
 * KV key patterns and metric field names for the Platform SDK.
 */

// =============================================================================
// KV KEY PATTERNS
// =============================================================================

/**
 * KV key patterns for circuit breaker and configuration.
 *
 * New convention (Platform SDK):
 * - CONFIG:FEATURE:{featureId}:STATUS  -> GO | STOP
 * - CONFIG:PROJECT:{projectId}:STATUS  -> GO | STOP
 * - CONFIG:GLOBAL:STATUS               -> GO | STOP
 * - CONFIG:FEATURE:{featureId}:BUDGET  -> Budget config JSON
 *
 * Legacy convention (feature-budget.ts):
 * - FEATURE:{key}:enabled              -> 'true' | 'false'
 * - FEATURE:{key}:disabled_reason      -> string
 * - CONFIG:BUDGETS                     -> Full budgets config
 */
export const KV_KEYS = {
  // Circuit breaker status keys
  featureStatus: (featureId: string) => `CONFIG:FEATURE:${featureId}:STATUS`,
  projectStatus: (projectId: string) => `CONFIG:PROJECT:${projectId}:STATUS`,
  globalStatus: () => 'CONFIG:GLOBAL:STATUS',

  // Circuit breaker metadata
  featureReason: (featureId: string) => `CONFIG:FEATURE:${featureId}:REASON`,
  featureDisabledAt: (featureId: string) => `CONFIG:FEATURE:${featureId}:DISABLED_AT`,
  featureAutoResetAt: (featureId: string) => `CONFIG:FEATURE:${featureId}:AUTO_RESET_AT`,

  // Budget configuration
  featureBudget: (featureId: string) => `CONFIG:FEATURE:${featureId}:BUDGET`,
  defaultBudgets: () => 'CONFIG:BUDGETS:DEFAULTS',

  // AI-specific circuit breaker (per-model limits)
  featureAIStatus: (featureId: string) => `CONFIG:FEATURE:${featureId}:ai:STATUS`,

  // Intelligent degradation (PID controller, throttling)
  /** PID controller state: integral, prevError, lastUpdate */
  pidState: (featureId: string) => `STATE:PID:${featureId}`,
  /** Current throttle rate (0.0-1.0) for SDK consumption */
  throttleRate: (featureId: string) => `CONFIG:FEATURE:${featureId}:THROTTLE_RATE`,
  /** Reservoir sampling state for latency percentiles */
  reservoirState: (featureId: string) => `STATE:RESERVOIR:${featureId}`,

  // Legacy keys (for backwards compatibility during migration)
  legacy: {
    enabled: (key: string) => `FEATURE:${key}:enabled`,
    disabledReason: (key: string) => `FEATURE:${key}:disabled_reason`,
    disabledAt: (key: string) => `FEATURE:${key}:disabled_at`,
    autoResetAt: (key: string) => `FEATURE:${key}:auto_reset_at`,
    budgets: () => 'CONFIG:BUDGETS',
  },
} as const;

// =============================================================================
// METRIC FIELD NAMES
// =============================================================================

/**
 * Ordered list of metric fields for Analytics Engine.
 *
 * IMPORTANT: Positions 1-12 are locked for backward compatibility with existing
 * Analytics Engine data. New fields MUST be appended to positions 13+.
 *
 * Field positions map to Analytics Engine doubles:
 * - double1-double12: Legacy fields (do not reorder)
 * - double13-double20: Extended fields (append only, 20 field limit)
 */
export const METRIC_FIELDS = [
  // === Legacy fields (positions 1-12) - DO NOT REORDER ===
  'd1Writes', // double1
  'd1Reads', // double2
  'kvReads', // double3
  'kvWrites', // double4
  'doRequests', // double5
  'doGbSeconds', // double6
  'r2ClassA', // double7
  'r2ClassB', // double8
  'aiNeurons', // double9
  'queueMessages', // double10
  'requests', // double11
  'cpuMs', // double12

  // === Extended fields (positions 13-20) - APPEND ONLY ===
  // NOTE: Analytics Engine only supports 20 double fields (double1-double20).
  // vectorizeDeletes was removed to stay within limit.
  'd1RowsRead', // double13
  'd1RowsWritten', // double14
  'kvDeletes', // double15
  'kvLists', // double16
  'aiRequests', // double17
  'vectorizeQueries', // double18
  'vectorizeInserts', // double19
  'workflowInvocations', // double20
] as const;

/**
 * Type for valid metric field names.
 */
export type MetricFieldName = (typeof METRIC_FIELDS)[number];

// =============================================================================
// CIRCUIT BREAKER DEFAULTS
// =============================================================================

/**
 * Default auto-reset interval for circuit breakers (1 hour in seconds).
 */
export const DEFAULT_AUTO_RESET_SECONDS = 3600;

/**
 * Circuit breaker status values.
 */
export const CIRCUIT_STATUS = {
  GO: 'GO',
  STOP: 'STOP',
} as const;

// =============================================================================
// TELEMETRY DEFAULTS
// =============================================================================

/**
 * Maximum delay before flushing telemetry (in milliseconds).
 * Telemetry is flushed immediately on request completion via waitUntil.
 */
export const TELEMETRY_FLUSH_DELAY_MS = 0;

// =============================================================================
// BINDING NAMES
// =============================================================================

/**
 * Expected binding names in worker environment.
 */
export const BINDING_NAMES = {
  /** KV namespace for circuit breaker state */
  PLATFORM_CACHE: 'PLATFORM_CACHE',
  /** Queue for telemetry messages */
  PLATFORM_TELEMETRY: 'PLATFORM_TELEMETRY',
} as const;
