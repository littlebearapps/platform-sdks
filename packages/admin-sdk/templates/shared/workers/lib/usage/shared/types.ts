/**
 * Platform Usage Types
 *
 * Shared type definitions extracted from platform-usage.ts.
 * These types are used across handlers, scheduled tasks, and queue processing.
 */

import type {
  KVNamespace,
  D1Database,
  Queue,
  AnalyticsEngineDataset,
  Fetcher,
} from '@cloudflare/workers-types';
import type { TelemetryMessage, FeatureMetrics } from '@littlebearapps/platform-consumer-sdk';
import type {
  TimePeriod,
  DateRange,
  CompareMode,
  AccountUsage,
  CostBreakdown,
  ProjectCostBreakdown,
  ThresholdAnalysis,
  SparklineData,
  WorkersErrorBreakdown,
  QueuesMetrics,
  CacheAnalytics,
  PeriodComparison,
  ResourceType,
  DailyCostData,
  WorkersAISummary,
} from '../../shared/cloudflare';
import type { BillingSettings } from '../../billing';
import type { PlatformSettings } from '../../platform-settings';

// =============================================================================
// ENVIRONMENT
// =============================================================================

/**
 * Worker environment bindings
 */
export interface Env {
  PLATFORM_CACHE: KVNamespace;
  PLATFORM_DB: D1Database;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  SLACK_WEBHOOK_URL?: string;
  GITHUB_TOKEN?: string;
  // GitHub Enterprise (for consumed-licenses API)
  GITHUB_PAT?: string; // PAT with read:enterprise scope (falls back to GITHUB_TOKEN)
  GITHUB_ENTERPRISE_SLUG?: string; // Enterprise slug for license queries
  // Third-party provider API keys
  ANTHROPIC_ADMIN_API_KEY?: string;
  OPENAI_ADMIN_API_KEY?: string; // Admin key (sk-admin-...) required for Usage API
  RESEND_API_KEY?: string;
  APIFY_API_KEY?: string;
  // Additional AI providers
  DEEPSEEK_API_KEY?: string;
  MINIMAX_API_KEY?: string;
  GCP_PROJECT_ID?: string;
  GCP_SERVICE_ACCOUNT_JSON?: string; // JSON string for service account credentials
  // Live usage API authentication
  USAGE_API_KEY?: string;
  // Platform SDK bindings (pilot integration)
  PLATFORM_TELEMETRY: Queue<TelemetryMessage>;
  PLATFORM_DLQ: Queue<TelemetryMessage>; // Dead Letter Queue for failed messages
  PLATFORM_ANALYTICS: AnalyticsEngineDataset;
  // Service bindings
  ALERT_ROUTER?: Fetcher;
  NOTIFICATIONS_API?: Fetcher; // For creating dashboard notifications
  // Gatus heartbeat ping URL for cron monitoring
  GATUS_HEARTBEAT_URL?: string;
  GATUS_TOKEN?: string;
}

// =============================================================================
// BUDGET CHECKING TYPES
// =============================================================================

/**
 * Daily limits structure stored in KV (snake_case, matching budgets.yaml).
 * Used for budget checking in queue handler.
 */
export interface DailyLimits {
  d1_writes?: number;
  d1_reads?: number;
  d1_rows_read?: number;
  d1_rows_written?: number;
  kv_reads?: number;
  kv_writes?: number;
  kv_deletes?: number;
  kv_lists?: number;
  r2_class_a?: number;
  r2_class_b?: number;
  ai_requests?: number;
  ai_neurons?: number;
  vectorize_queries?: number;
  vectorize_inserts?: number;
  queue_messages?: number;
  do_requests?: number;
  workflow_invocations?: number;
  requests?: number;
  cpu_ms?: number;
}

/**
 * Monthly limits structure stored in KV (same fields as DailyLimits).
 * Checked once daily at midnight via checkMonthlyBudgets().
 * KV key: CONFIG:FEATURE:{feature_key}:BUDGET_MONTHLY
 */
export type MonthlyLimits = DailyLimits;

// =============================================================================
// ADAPTIVE SAMPLING
// =============================================================================

/**
 * Sampling mode based on D1 write usage.
 * Higher modes collect less frequently but never stop completely.
 */
export enum SamplingMode {
  FULL = 1, // Every hour (< 60% of D1 limit)
  HALF = 2, // Every 2 hours (60-80% of limit)
  QUARTER = 4, // Every 4 hours (80-90% of limit)
  MINIMAL = 24, // Daily only (> 90% of limit)
}

// =============================================================================
// DELTA CALCULATION TYPES
// =============================================================================

/**
 * Previous hour's cumulative metric values for delta calculation.
 * These are the raw cumulative values from the last GraphQL collection.
 */
export interface PreviousHourMetrics {
  snapshotHour: string; // YYYY-MM-DDTHH:00:00Z when these values were recorded
  timestamp: number; // Unix timestamp

  // Durable Objects (counters - need delta)
  do: {
    requests: number;
    gbSeconds: number;
    storageReadUnits: number;
    storageWriteUnits: number;
    storageDeleteUnits: number;
  };

  // Workers AI (counters - need delta)
  workersAI: {
    neurons: number;
    requests: number;
  };

  // Vectorize (counters - need delta)
  vectorize: {
    queries: number;
  };

  // Queues (counters - need delta)
  queues: {
    produced: number;
    consumed: number;
  };

  // Workflows (counters - need delta)
  workflows: {
    executions: number;
    successes: number;
    failures: number;
    wallTimeMs: number;
    cpuTimeMs: number;
  };

  // Workers (counters - need delta)
  workers: {
    requests: number;
    errors: number;
    cpuTimeMs: number;
  };

  // D1 (counters - need delta)
  d1: {
    rowsRead: number;
    rowsWritten: number;
  };

  // KV (counters - need delta)
  kv: {
    reads: number;
    writes: number;
    deletes: number;
    lists: number;
  };

  // R2 (counters - need delta)
  r2: {
    classAOps: number;
    classBOps: number;
    egressBytes: number;
  };

  // AI Gateway (counters - need delta)
  aiGateway: {
    requests: number;
    tokensIn: number;
    tokensOut: number;
    cached: number;
  };

  // Pages (counters - need delta)
  pages: {
    deployments: number;
    bandwidthBytes: number;
  };

  // Per-project cumulative metrics for delta calculation
  projects?: Record<
    string,
    {
      workersRequests: number;
      workersErrors: number;
      workersCpuTimeMs: number;
      d1RowsRead: number;
      d1RowsWritten: number;
      kvReads: number;
      kvWrites: number;
      kvDeletes: number;
      kvLists: number;
      r2ClassAOps: number;
      r2ClassBOps: number;
      doRequests: number;
      doGbSeconds: number;
    }
  >;
}

/**
 * Delta values for all metric types.
 * These represent the change from the previous hour.
 */
export interface MetricDeltas {
  do: {
    requests: number;
    gbSeconds: number;
    storageReadUnits: number;
    storageWriteUnits: number;
    storageDeleteUnits: number;
  };
  workersAI: {
    neurons: number;
    requests: number;
  };
  vectorize: {
    queries: number;
  };
  queues: {
    produced: number;
    consumed: number;
  };
  workflows: {
    executions: number;
    successes: number;
    failures: number;
    wallTimeMs: number;
    cpuTimeMs: number;
  };
  workers: {
    requests: number;
    errors: number;
    cpuTimeMs: number;
  };
  d1: {
    rowsRead: number;
    rowsWritten: number;
  };
  kv: {
    reads: number;
    writes: number;
    deletes: number;
    lists: number;
  };
  r2: {
    classAOps: number;
    classBOps: number;
    egressBytes: number;
  };
  aiGateway: {
    requests: number;
    tokensIn: number;
    tokensOut: number;
    cached: number;
  };
  pages: {
    deployments: number;
    bandwidthBytes: number;
  };
}

// =============================================================================
// PRICING TYPES
// =============================================================================

/**
 * Platform pricing configuration loaded from KV.
 * Falls back to hardcoded defaults from CF_PRICING if KV is empty.
 */
export interface PlatformPricing {
  version: string;
  workers: {
    baseCostMonthly: number;
    includedRequests: number;
    requestsPerMillion: number;
    cpuMsPerMillion: number;
  };
  d1: {
    rowsReadPerBillion: number;
    rowsWrittenPerMillion: number;
    storagePerGb: number;
  };
  kv: {
    readsPerMillion: number;
    writesPerMillion: number;
    deletesPerMillion: number;
    listsPerMillion: number;
    storagePerGb: number;
  };
  r2: {
    storagePerGbMonth: number;
    classAPerMillion: number;
    classBPerMillion: number;
  };
  vectorize: {
    storedDimensionsPerMillion: number;
    queriedDimensionsPerMillion: number;
  };
  workersAI: {
    neuronsPerThousand: number;
  };
  durableObjects: {
    requestsPerMillion: number;
    gbSecondsPerMillion: number;
    storagePerGbMonth: number;
    readsPerMillion: number;
    writesPerMillion: number;
    deletesPerMillion: number;
  };
  queues: {
    messagesPerMillion: number;
    operationsPerMillion: number;
  };
  pages: {
    buildCost: number;
    bandwidthPerGb: number;
  };
}

// =============================================================================
// API RESPONSE TYPES
// =============================================================================

/**
 * Usage API response
 */
export interface UsageResponse {
  success: boolean;
  period: TimePeriod;
  project: string;
  timestamp: string;
  cached: boolean;
  data: {
    workers: AccountUsage['workers'];
    d1: AccountUsage['d1'];
    kv: AccountUsage['kv'];
    r2: AccountUsage['r2'];
    durableObjects: AccountUsage['durableObjects'];
    vectorize: AccountUsage['vectorize'];
    aiGateway: AccountUsage['aiGateway'];
    pages: AccountUsage['pages'];
    summary: {
      totalWorkers: number;
      totalD1Databases: number;
      totalKVNamespaces: number;
      totalR2Buckets: number;
      totalVectorizeIndexes: number;
      totalAIGateways: number;
      totalPagesProjects: number;
      totalRequests: number;
      totalRowsRead: number;
      totalRowsWritten: number;
    };
  };
  costs: CostBreakdown & {
    formatted: {
      workers: string;
      d1: string;
      kv: string;
      r2: string;
      durableObjects: string;
      vectorize: string;
      aiGateway: string;
      pages: string;
      queues: string;
      workflows: string;
      total: string;
    };
  };
  projectCosts: ProjectCostBreakdown[];
  thresholds: ThresholdAnalysis;
}

/**
 * Enhanced Usage Response with sparklines, trends, and additional metrics
 */
export interface EnhancedUsageResponse extends UsageResponse {
  sparklines: {
    workersRequests: SparklineData;
    workersErrors: SparklineData;
    d1RowsRead: SparklineData;
    kvReads: SparklineData;
  };
  errorBreakdown: WorkersErrorBreakdown[];
  queues: QueuesMetrics[];
  cache: CacheAnalytics;
  comparison: {
    workersRequests: PeriodComparison;
    workersErrors: PeriodComparison;
    d1RowsRead: PeriodComparison;
    totalCost: PeriodComparison;
  };
}

/**
 * Comparison Response
 */
export interface ComparisonResponse {
  success: boolean;
  compareMode: CompareMode;
  current: {
    dateRange: DateRange;
    summary: {
      totalWorkers: number;
      totalD1Databases: number;
      totalKVNamespaces: number;
      totalR2Buckets: number;
      totalVectorizeIndexes: number;
      totalAIGateways: number;
      totalPagesProjects: number;
      totalRequests: number;
      totalRowsRead: number;
      totalRowsWritten: number;
    };
    costs: CostBreakdown;
    data: AccountUsage;
  };
  prior: {
    dateRange: DateRange;
    summary: {
      totalWorkers: number;
      totalD1Databases: number;
      totalKVNamespaces: number;
      totalR2Buckets: number;
      totalVectorizeIndexes: number;
      totalAIGateways: number;
      totalPagesProjects: number;
      totalRequests: number;
      totalRowsRead: number;
      totalRowsWritten: number;
    };
    costs: CostBreakdown;
    data: AccountUsage;
  };
  comparison: {
    workersRequests: PeriodComparison;
    workersErrors: PeriodComparison;
    d1RowsRead: PeriodComparison;
    totalCost: PeriodComparison;
  };
  timestamp: string;
  cached: boolean;
}

/**
 * Settings response for alert thresholds
 */
export interface SettingsResponse {
  success: boolean;
  thresholds: Record<string, unknown>;
  budgetThresholds: {
    softBudgetLimit: number;
    warningThreshold: number;
  };
  updated?: string;
  cached?: boolean;
  responseTimeMs?: number;
}

/**
 * Projected Monthly Burn calculation
 */
export interface ProjectedBurn {
  currentPeriodDays: number;
  currentPeriodCost: number;
  dailyBurnRate: number;
  projectedMonthlyCost: number;
  projectedVsLastMonthPct: number | null;
  lastMonthCost: number | null;
  confidence: 'low' | 'medium' | 'high';
}

// =============================================================================
// LIVE USAGE TYPES
// =============================================================================

/**
 * Live usage response interface.
 */
export interface LiveUsageResponse {
  timestamp: string;
  circuitBreakers: {
    globalStop: boolean;
    activeBreakers: Array<{
      project: string;
      status: 'paused' | 'degraded';
      reason?: string;
    }>;
  };
  adaptiveSampling: {
    mode: string;
    d1Writes24h: number;
    d1WriteLimit: number;
    d1WritePercentage: number;
  };
  latestSnapshot: {
    snapshotHour: string | null;
    workersRequests: number | null;
    d1RowsRead: number | null;
    kvReads: number | null;
  } | null;
  responseTimeMs: number;
}

// =============================================================================
// FEATURE USAGE TYPES
// =============================================================================

/**
 * Feature usage response for a single feature.
 */
export interface FeatureUsageData {
  featureKey: string;
  project: string;
  category: string;
  feature: string;
  metrics: Record<string, number>;
  circuitBreaker: {
    enabled: boolean;
    disabledReason?: string;
    disabledAt?: string;
    autoResetAt?: string;
  };
  budget?: Record<string, number>;
  circuitBreakerEnabled?: boolean;
  hasActivity?: boolean;
  /** Last heartbeat timestamp (ISO string) from system_health_checks */
  lastHeartbeat?: string;
  /** Health status from system_health_checks (e.g., 'healthy') */
  healthStatus?: string;
}

// =============================================================================
// WORKERS AI TYPES
// =============================================================================

/**
 * Workers AI response interface
 */
export interface WorkersAIResponse {
  success: boolean;
  period: string;
  data: WorkersAISummary;
  cached: boolean;
  timestamp: string;
  responseTimeMs?: number;
}

// =============================================================================
// DAILY COST TYPES
// =============================================================================

/**
 * Daily cost response interface
 */
export interface DailyCostResponse {
  success: boolean;
  period: string; // Display period like '24h', '7d', '30d'
  data: DailyCostData;
  cached: boolean;
  timestamp: string;
  responseTimeMs?: number;
}

// =============================================================================
// UTILIZATION & BURN RATE TYPES
// =============================================================================

/**
 * Utilization status for service-level metrics
 */
export type ServiceUtilizationStatus = 'ok' | 'warning' | 'critical' | 'overage';

/**
 * Resource metric for the usage overview dashboard
 */
export interface ResourceMetricData {
  id: string;
  label: string;
  provider: 'cloudflare' | 'github';
  current: number;
  limit: number | null;
  unit: string;
  percentage: number;
  costEstimate: number;
  status: ServiceUtilizationStatus;
  overage: number;
  overageCost: number;
}

/**
 * Provider health summary
 */
export interface ProviderHealthData {
  provider: 'cloudflare' | 'github';
  percentage: number;
  warnings: number;
  status: ServiceUtilizationStatus;
}

/**
 * Project utilization data for UI
 */
export interface ProjectUtilizationData {
  projectId: string;
  projectName: string;
  primaryResource: string;
  mtdCost: number;
  costDeltaPct: number;
  utilizationPct: number;
  utilizationCurrent: number;
  utilizationLimit: number;
  utilizationUnit: string;
  status: 'green' | 'yellow' | 'red';
  sparklineData: number[];
  circuitBreakerStatus: 'active' | 'tripped' | 'degraded' | 'disabled';
  circuitBreakerLabel: string;
  hasCBEnabled: boolean;
}

/**
 * GitHub usage data for the utilization response
 */
export interface GitHubUsageResponse {
  mtdUsage: {
    actionsMinutes: number;
    actionsMinutesIncluded: number;
    actionsMinutesUsagePct: number;
    actionsStorageGbHours: number;
    actionsStorageGbIncluded: number;
    ghecUserMonths: number;
    ghasCodeSecuritySeats: number;
    ghasSecretProtectionSeats: number;
    totalCost: number;
  };
  plan: {
    name: string;
    filledSeats: number;
    totalSeats: number;
  };
  lastUpdated: string | null;
  isStale: boolean;
}

/**
 * Burn rate response data
 */
export interface BurnRateResponse {
  success: boolean;
  burnRate: {
    mtdCost: number;
    mtdStartDate: string;
    mtdEndDate: string;
    projectedMonthlyCost: number;
    dailyBurnRate: number;
    daysIntoMonth: number;
    daysRemaining: number;
    confidence: 'low' | 'medium' | 'high';
    vsLastMonthPct: number | null;
    billingPeriodStart: string;
    billingPeriodEnd: string;
    status: 'green' | 'yellow' | 'red';
    statusLabel: string;
    statusDetail: string;
  };
  projects: ProjectUtilizationData[];
  github: GitHubUsageResponse | null;
  health?: {
    cloudflare: ProviderHealthData;
    github: ProviderHealthData;
  };
  cloudflareServices?: ResourceMetricData[];
  githubServices?: ResourceMetricData[];
  timestamp: string;
  cached: boolean;
  responseTimeMs?: number;
}

/**
 * Budget threshold settings from D1 usage_settings table
 */
export interface BudgetThresholds {
  softBudgetLimit: number;
  warningThreshold: number;
}

// =============================================================================
// ANOMALY DETECTION TYPES
// =============================================================================

/**
 * Rolling stats for anomaly detection.
 * Uses avg/stddev/samples to match the actual implementation.
 */
export interface RollingStats {
  avg: number;
  stddev: number;
  samples: number;
}

/**
 * Anomaly record from D1 (matches actual table schema).
 * Note: D1 returns integers for timestamps and booleans (0/1).
 */
export interface AnomalyRecord {
  id: number;
  detected_at: number; // Unix timestamp (seconds)
  metric_name: string;
  project: string;
  current_value: number;
  rolling_avg: number;
  rolling_stddev?: number;
  deviation_factor: number;
  alert_sent: number; // 0 or 1
  alert_channel: string | null;
  resolved: number; // 0 or 1
  resolved_at: number | null; // Unix timestamp (seconds)
  resolved_by: string | null;
}

/**
 * Anomalies response
 */
export interface AnomaliesResponse {
  success: boolean;
  anomalies: Array<{
    id: number;
    detectedAt: string;
    metric: string;
    project: string;
    currentValue: number;
    rollingAvg: number;
    deviationFactor: number;
    alertSent: boolean;
    alertChannel: string | null;
    resolved: boolean;
    resolvedAt: string | null;
    resolvedBy: string | null;
  }>;
  total: number;
  timestamp: string;
  cached: boolean;
}

// =============================================================================
// GITHUB BILLING TYPES
// =============================================================================

/**
 * GitHub billing usage item from the new API.
 */
export interface GitHubUsageItem {
  date: string;
  product: string;
  sku: string;
  quantity: number;
  unitType: string;
  pricePerUnit: number;
  grossAmount: number;
  discountAmount: number;
  netAmount: number;
  organizationName: string;
  repositoryName: string;
}

/**
 * GitHub organization plan info from /orgs/{org} endpoint.
 */
export interface GitHubPlanInfo {
  planName: string;
  filledSeats: number;
  totalSeats: number;
  privateRepos: number;
}

/**
 * Aggregated GitHub billing data.
 */
export interface GitHubBillingData {
  plan: GitHubPlanInfo;
  actionsMinutes: number;
  actionsMinutesCost: number;
  actionsStorageGbHours: number;
  actionsStorageCost: number;
  ghecUserMonths: number;
  ghecCost: number;
  ghasCodeSecurityUserMonths: number;
  ghasCodeSecurityCost: number;
  ghasSecretProtectionUserMonths: number;
  ghasSecretProtectionCost: number;
  /** Packages storage in GB */
  packagesStorageGb: number;
  packagesStorageCost: number;
  /** Packages bandwidth in GB */
  packagesBandwidthGb: number;
  packagesBandwidthCost: number;
  /** Git LFS storage in GB */
  lfsStorageGb: number;
  lfsStorageCost: number;
  /** Git LFS bandwidth in GB */
  lfsBandwidthGb: number;
  lfsBandwidthCost: number;
  /** Copilot seats */
  copilotSeats: number;
  copilotCost: number;
  totalNetCost: number;
}

/**
 * GitHub plan inclusions (what's included per plan).
 */
export interface GitHubPlanInclusions {
  actionsMinutesIncluded: number;
  actionsStorageGbIncluded: number;
  packagesStorageGbIncluded: number;
  codespacesHoursIncluded: number;
}

// =============================================================================
// THIRD-PARTY USAGE TYPES
// =============================================================================

/**
 * Anthropic usage data
 */
export interface AnthropicUsageData {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  totalCost: number;
  modelBreakdown: Record<string, { inputTokens: number; outputTokens: number }>;
}

/**
 * OpenAI usage data
 */
export interface OpenAIUsageData {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalCost: number;
  requestCount: number;
  modelBreakdown: Record<string, { inputTokens: number; outputTokens: number; requests: number }>;
}

/**
 * Resend usage data
 */
export interface ResendUsageData {
  emailsSent: number;
  domainsCount: number;
}

/**
 * Apify usage data
 */
export interface ApifyUsageData {
  totalUsageCreditsUsd: number;
  actorComputeUnits: number;
  dataTransferGb: number;
  storageGb: number;
}

/**
 * DeepSeek balance data (Stock metric - balance remaining, not usage)
 * @see https://api-docs.deepseek.com/api/get-user-balance
 */
export interface DeepSeekBalanceData {
  /** Total balance remaining in USD */
  totalBalance: number;
  /** Granted/promotional balance */
  grantedBalance: number;
  /** Topped-up/purchased balance */
  toppedUpBalance: number;
  /** Whether the account is available for API calls */
  isAvailable: boolean;
  /** Currency (typically 'USD') */
  currency: string;
}

/**
 * Minimax quota data (Stock metric - quota remaining, not usage)
 */
export interface MinimaxQuotaData {
  /** Remaining quota units */
  remainingQuota: number;
  /** Total quota units allocated */
  totalQuota: number;
  /** Usage percentage (0-100) */
  usagePercentage: number;
  /** Plan type (e.g., 'coding_plan') */
  planType: string;
}

/**
 * Google Gemini usage data (Flow metric - actual usage)
 * Collected via Cloud Monitoring API for generativelanguage.googleapis.com
 */
export interface GeminiUsageData {
  /** Total API requests in the period */
  requestCount: number;
  /** Average latency in milliseconds */
  avgLatencyMs: number;
  /** Estimated cost in USD (based on request counts and Gemini pricing) */
  estimatedCostUsd: number;
  /** Period start timestamp */
  periodStart: string;
  /** Period end timestamp */
  periodEnd: string;
  /** Per-method request breakdown (e.g. GenerateContent, EmbedContent) */
  methodBreakdown: Record<string, number>;
}

// =============================================================================
// ERROR HANDLING TYPES
// =============================================================================

/**
 * Error alert payload - flexible structure for different alert types
 */
export interface ErrorAlertPayload {
  type: 'p0_immediate' | 'p1_digest' | 'p2_summary';
  feature_key: string;
  project: string;
  category: string;
  feature: string;
  // P0 immediate alerts
  error_category?: string;
  error_code?: string;
  error_rate?: number;
  window_minutes?: number;
  correlation_id?: string;
  // Digest/summary alerts
  total_errors?: number;
  distinct_types?: number;
  top_errors?: Array<{
    feature_key: string;
    error_category: string;
    count: number;
  }>;
  period_start?: string;
  period_end?: string;
}

// =============================================================================
// QUEUE PROCESSING TYPES
// =============================================================================

/**
 * Feature batch state for queue processing
 */
export interface FeatureBatchState {
  cpuMsSamples: number[];
  bcuTotal: number;
  messageCount: number;
  lastTimestamp: number;
}

// =============================================================================
// VECTORIZE ATTRIBUTION TYPES
// =============================================================================

/**
 * Attribution result for Vectorize queries by project.
 */
export interface VectorizeAttribution {
  byProject: Map<string, number>;
  unattributed: number;
  total: number;
}

/**
 * Project lookup cache for a single request.
 * Maps "{resourceType}:{resourceName}" -> projectId
 */
export type ProjectLookupCache = Map<string, string>;

// =============================================================================
// RE-EXPORTS
// =============================================================================

// Re-export commonly used types from dependencies
export type { TelemetryMessage, FeatureMetrics } from '@littlebearapps/platform-consumer-sdk';

export type {
  TimePeriod,
  DateRange,
  CompareMode,
  AccountUsage,
  CostBreakdown,
  ProjectCostBreakdown,
  ThresholdAnalysis,
  SparklineData,
  WorkersErrorBreakdown,
  QueuesMetrics,
  CacheAnalytics,
  PeriodComparison,
  ResourceType,
  AlertThresholds,
  ServiceThreshold,
  WorkersAISummary,
  AIGatewaySummary,
  DailyCostData,
  DailyUsageMetrics,
  Project,
} from '../../shared/cloudflare';

export type { BillingSettings, BillingPeriod } from '../../billing';

export type { PlatformSettings } from '../../platform-settings';

export type {
  HourlyUsageMetrics,
  AccountDailyUsage,
  DailyBillableCostBreakdown,
} from '@littlebearapps/platform-consumer-sdk';

export type { TimeBucketedUsage, TimeBucketQueryParams } from '../../analytics-engine';

export type { PIDState } from '../../control';

export type { ReservoirState } from '../../telemetry-sampling';

export type { BCUResult } from '../../economics';

export type { CircuitBreakerStatusValue } from '../../circuit-breaker-middleware';
