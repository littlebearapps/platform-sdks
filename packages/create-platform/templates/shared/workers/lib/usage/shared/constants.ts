/**
 * Platform Usage Constants
 *
 * Shared constants extracted from platform-usage.ts.
 * Includes KV keys, mappings, defaults, and configuration.
 */

import type { FeatureMetrics } from '@littlebearapps/platform-sdk';
import { METRIC_FIELDS } from '@littlebearapps/platform-sdk';
import { DEFAULT_PLATFORM_SETTINGS } from '../../platform-settings';
import type { DailyLimits, PlatformPricing } from './types';
import type { SimpleAllowanceType } from '../../shared/allowances';

// =============================================================================
// KV KEYS
// =============================================================================

/**
 * KV keys for circuit breaker and sampling state.
 *
 * TODO: Add project-specific circuit breaker keys for your projects, e.g.:
 *   MY_PROJECT_STATUS: 'PROJECT:MY-PROJECT:STATUS',
 */
export const CB_KEYS = {
  // Global stop flag
  GLOBAL_STOP: 'GLOBAL_STOP_ALL',
  // Usage worker (adaptive sampling)
  USAGE_SAMPLING_MODE: 'platform-usage:sampling-mode',
  // D1 write tracking
  D1_WRITES_24H: 'platform-usage:d1-writes-24h',
  D1_WRITES_TIMESTAMP: 'platform-usage:d1-writes-timestamp',
  // DO GB-seconds tracking (per-project)
  DO_GB_SECONDS_24H_PREFIX: 'platform-usage:do-gb-seconds-24h:',
  // Pricing configuration
  PRICING: 'platform-usage:pricing:v1',
  // Delta calculation state (hourly snapshot correction)
  PREV_HOUR_ACCOUNT_METRICS: 'platform-usage:prev-hour:account',
  PREV_HOUR_LAST_COLLECTION: 'platform-usage:prev-hour:timestamp',
} as const;

/**
 * Feature KV key patterns (matching workers/lib/feature-budget.ts).
 */
export const FEATURE_KV_KEYS = {
  BUDGETS: 'CONFIG:BUDGETS',
  enabled: (key: string) => `FEATURE:${key}:enabled`,
  disabledReason: (key: string) => `FEATURE:${key}:disabled_reason`,
  disabledAt: (key: string) => `FEATURE:${key}:disabled_at`,
  autoResetAt: (key: string) => `FEATURE:${key}:auto_reset_at`,
  alertLastSent: (key: string) => `ALERT:${key}:last_sent`,
} as const;

/**
 * Settings key for alert thresholds in KV
 */
export const SETTINGS_KEY = 'alert-thresholds:config';

// =============================================================================
// METRIC MAPPINGS
// =============================================================================

/**
 * Mapping from FeatureMetrics (camelCase) to DailyLimits (snake_case).
 */
export const METRIC_TO_BUDGET_KEY: Record<keyof FeatureMetrics, keyof DailyLimits | null> = {
  d1Writes: 'd1_writes',
  d1Reads: 'd1_reads',
  d1RowsRead: 'd1_rows_read',
  d1RowsWritten: 'd1_rows_written',
  kvReads: 'kv_reads',
  kvWrites: 'kv_writes',
  kvDeletes: 'kv_deletes',
  kvLists: 'kv_lists',
  aiRequests: 'ai_requests',
  aiNeurons: 'ai_neurons',
  aiModelBreakdown: null, // Not a numeric metric, stored separately in D1
  vectorizeQueries: 'vectorize_queries',
  vectorizeInserts: 'vectorize_inserts',
  r2ClassA: 'r2_class_a',
  r2ClassB: 'r2_class_b',
  queueMessages: 'queue_messages',
  doRequests: 'do_requests',
  doGbSeconds: null, // No budget limit for GB-seconds
  doAvgLatencyMs: null, // Latency stats are informational, not budgeted
  doMaxLatencyMs: null,
  doP99LatencyMs: null,
  workflowInvocations: 'workflow_invocations',
  requests: 'requests',
  cpuMs: 'cpu_ms',
};

/**
 * Metric field order in Analytics Engine.
 * Alias to SDK METRIC_FIELDS for backward compatibility.
 */
export const FEATURE_METRIC_FIELDS = METRIC_FIELDS;

/**
 * ResourceType mapping from GraphQL metric types to registry types.
 */
export const RESOURCE_TYPE_MAP: Record<string, string> = {
  worker: 'worker',
  d1: 'd1',
  kv: 'kv',
  r2: 'r2',
  vectorize: 'vectorize',
  aiGateway: 'ai_gateway',
  pages: 'pages',
  durableObject: 'durable_object',
  queue: 'queue',
  workflow: 'workflow',
};

// =============================================================================
// QUEUE/WORKFLOW MAPPINGS
// =============================================================================

/**
 * Queue-to-project mapping sets.
 *
 * TODO: Populate these with your project's queue names.
 * Each Set maps queue names to a project for cost attribution.
 *
 * Example:
 *   export const MY_PROJECT_QUEUES = new Set([
 *     'my-project-queue',
 *     'my-project-dlq',
 *   ]);
 */

/**
 * Workflow-to-project mapping sets.
 *
 * TODO: Populate these with your project's workflow names.
 *
 * Example:
 *   export const MY_PROJECT_WORKFLOWS = new Set([
 *     'my-workflow',
 *   ]);
 */

// =============================================================================
// PRICING DEFAULTS
// =============================================================================

/**
 * Default pricing constants (synced from CF_PRICING in shared/cloudflare.ts).
 * These serve as fallback if KV pricing is not configured.
 */
export const DEFAULT_PRICING: PlatformPricing = {
  version: '2026-01-hardcoded',
  workers: {
    baseCostMonthly: 5.0,
    includedRequests: 10_000_000,
    requestsPerMillion: 0.3,
    cpuMsPerMillion: 0.02,
  },
  d1: {
    rowsReadPerBillion: 0.001,
    rowsWrittenPerMillion: 1.0,
    storagePerGb: 0.75,
  },
  kv: {
    readsPerMillion: 0.5,
    writesPerMillion: 5.0,
    deletesPerMillion: 5.0,
    listsPerMillion: 5.0,
    storagePerGb: 0.5,
  },
  r2: {
    storagePerGbMonth: 0.015,
    classAPerMillion: 4.5,
    classBPerMillion: 0.36,
  },
  vectorize: {
    storedDimensionsPerMillion: 0.01,
    queriedDimensionsPerMillion: 0.01,
  },
  workersAI: {
    neuronsPerThousand: 0.011,
  },
  durableObjects: {
    requestsPerMillion: 0.15,
    gbSecondsPerMillion: 12.5,
    storagePerGbMonth: 0.2,
    readsPerMillion: 0.2,
    writesPerMillion: 1.0,
    deletesPerMillion: 1.0,
  },
  queues: {
    messagesPerMillion: 0.4,
    operationsPerMillion: 0.4,
  },
  pages: {
    buildCost: 0.15,
    bandwidthPerGb: 0.02,
  },
};

/**
 * Default budget thresholds (fallback if not configured in D1)
 */
export const DEFAULT_BUDGET_THRESHOLDS = {
  softBudgetLimit: DEFAULT_PLATFORM_SETTINGS.budgetSoftLimit,
  warningThreshold: DEFAULT_PLATFORM_SETTINGS.budgetWarningThreshold,
};

/**
 * Cloudflare overage pricing per unit
 */
export const CF_OVERAGE_PRICING: Record<string, number> = {
  workers: 0.3, // $0.30 per million requests
  d1_reads: 0.001, // $0.001 per billion rows read (negligible)
  d1_writes: 1.0, // $1.00 per million rows written
  kv_reads: 0.5, // $0.50 per million reads
  kv_writes: 5.0, // $5.00 per million writes
  r2_class_a: 4.5, // $4.50 per million Class A ops
  r2_class_b: 0.36, // $0.36 per million Class B ops
  vectorize: 0.01, // $0.01 per million dimensions
  workers_ai: 0.011, // $0.011 per 1000 neurons
};

// =============================================================================
// PROJECT CONFIGURATION
// =============================================================================

/**
 * Fallback project configurations (used when D1 registry has no primaryResource).
 *
 * TODO: Populate with your project configurations.
 *
 * Example:
 *   'my-project': { name: 'My Project', primaryResource: 'd1', customLimit: 20_000_000 },
 */
export const FALLBACK_PROJECT_CONFIGS: Record<
  string,
  { name: string; primaryResource: SimpleAllowanceType; customLimit?: number }
> = {
  // Add your projects here:
  // 'my-project': { name: 'My Project', primaryResource: 'd1', customLimit: 20_000_000 },
};

// =============================================================================
// ERROR HANDLING
// =============================================================================

/**
 * Error rate thresholds for alerting
 */
export const ERROR_RATE_THRESHOLDS = {
  P1: 10, // 10+ errors/hour = P1 critical
  P2: 5, // 5+ errors/hour = P2 warning
  WINDOW_HOURS: 1, // 1 hour window
  COOLDOWN_MINUTES: 30, // 30 minute cooldown between alerts
  // Extended thresholds for error rate monitoring
  windowMinutes: 60, // 60 minute window for rate calculation
  minRequests: 100, // Minimum requests before alerting
  p0: 50, // 50% error rate = P0 immediate
};

// =============================================================================
// ANALYTICS ENGINE DATASETS
// =============================================================================

/**
 * Known Analytics Engine datasets with metadata.
 *
 * TODO: Update with your project's Analytics Engine datasets.
 */
export const KNOWN_DATASETS = [
  // Platform SDK telemetry (all projects)
  { name: 'platform-analytics', category: 'sdk', billable: true },
  // TODO: Add your project-specific datasets here:
  // { name: 'my-project-analytics', category: 'my-project', billable: true },
];

/**
 * Datasets that are actively queried (billable).
 *
 * TODO: Update with your actively-queried datasets.
 */
export const QUERIED_DATASETS = new Set([
  'platform-analytics',
  // TODO: Add your project-specific datasets here
]);

// =============================================================================
// EXPECTED USAGE SETTINGS
// =============================================================================

/**
 * Expected settings keys in D1 usage_settings table
 */
export const EXPECTED_USAGE_SETTINGS = [
  // Budget and alerting
  'budget_soft_limit',
  'budget_warning_threshold',
  // D1 limits
  'd1_write_limit',
  'd1_write_warning_threshold',
  'd1_write_critical_threshold',
  // Error rate thresholds
  'error_rate_p1_threshold',
  'error_rate_p2_threshold',
  'error_rate_window_hours',
  'error_rate_cooldown_minutes',
  // Anomaly detection
  'anomaly_stddev_threshold',
  'anomaly_min_data_points',
  // Circuit breaker
  'circuit_breaker_auto_reset_hours',
  // Alert channel settings
  'slack_channel_alerts',
  'slack_channel_digests',
];

// =============================================================================
// MAX HOURLY DELTAS (prevents cumulative inflation from delta calculation failures)
// =============================================================================

/**
 * Maximum reasonable hourly delta values.
 * Set to ~3x the monthly allowance prorated to 1 hour (div 730).
 * Used to cap delta values when previous reference is missing (KV expired).
 *
 * Without these caps, a single hourly snapshot can store the entire billing-period
 * cumulative total as a "delta", inflating SUM() totals by 10-100x.
 */
export const MAX_HOURLY_DELTAS = {
  vectorize_queries: 250_000, // 3x (50M / 730h) ~ 205K, with headroom
  d1_rows_written: 2_000_000, // 3x (50M / 730h) ~ 205K, with headroom
  d1_rows_read: 1_000_000_000, // 3x (25B / 730h) ~ 103M, with headroom
  kv_reads: 500_000, // 3x (10M / 730h) ~ 41K, with headroom
  kv_writes: 50_000, // 3x (1M / 730h) ~ 4.1K, with headroom
  kv_deletes: 50_000,
  kv_lists: 50_000,
  workers_requests: 500_000, // 3x (10M / 730h) ~ 41K, with headroom
  workers_errors: 100_000,
  workers_cpu_ms: 50_000_000, // 50M ms/hr cap
  do_requests: 10_000, // 3x (1M / 730h) ~ 4.1K, with headroom
  do_gb_seconds: 5_000, // 3x (400K / 730h) ~ 1.6K, with headroom
  r2_class_a: 50_000, // 3x (1M / 730h) ~ 4.1K, with headroom
  r2_class_b: 500_000, // 3x (10M / 730h) ~ 41K, with headroom
  r2_egress_bytes: 500_000_000, // 500MB/hr cap
  ai_neurons: 10_000_000, // 10M neurons/hr cap
  ai_requests: 100_000,
  queue_produced: 50_000,
  queue_consumed: 50_000,
  workflow_executions: 10_000,
  pages_deployments: 100,
  ai_gateway_requests: 100_000,
  ai_gateway_tokens: 50_000_000,
} as const;

// =============================================================================
// CACHE TTL
// =============================================================================

/**
 * Billing settings cache TTL in milliseconds
 */
export const BILLING_SETTINGS_CACHE_TTL_MS = 60_000; // 60 seconds
