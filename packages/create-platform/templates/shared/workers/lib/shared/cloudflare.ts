/**
 * Cloudflare Observability Library
 *
 * Provides unified access to Cloudflare metrics, costs, and analytics.
 * This module consolidates GraphQL client, cost calculator, project registry,
 * and alerting functionality used by the platform-usage worker.
 *
 * NOTE: This is a self-contained version extracted from the dashboard library.
 * In production deployments, the dashboard may have additional UI-specific exports.
 *
 * @module cloudflare
 */

import type { D1Database } from '@cloudflare/workers-types';

// =============================================================================
// GRAPHQL TYPES
// =============================================================================

/** Time period for metrics queries */
export type TimePeriod = '24h' | '7d' | '30d';

/** Date range for GraphQL queries */
export interface DateRange {
  startDate: string;
  endDate: string;
}

/** Custom date range query parameters */
export interface CustomDateRangeParams {
  startDate: string;
  endDate: string;
  priorStartDate?: string;
  priorEndDate?: string;
}

/** Comparison mode */
export type CompareMode = 'none' | 'lastMonth' | 'custom';

/** Workers usage metrics */
export interface WorkersMetrics {
  scriptName: string;
  requests: number;
  errors: number;
  cpuTimeMs: number;
  duration50thMs: number;
  duration99thMs: number;
}

/** D1 database usage metrics */
export interface D1Metrics {
  databaseId: string;
  databaseName: string;
  rowsRead: number;
  rowsWritten: number;
  readQueries: number;
  writeQueries: number;
  storageBytes: number;
}

/** KV namespace usage metrics */
export interface KVMetrics {
  namespaceId: string;
  namespaceName: string;
  reads: number;
  writes: number;
  deletes: number;
  lists: number;
  storageBytes: number;
  keyCount: number;
}

/** R2 bucket usage metrics */
export interface R2Metrics {
  bucketName: string;
  classAOperations: number;
  classBOperations: number;
  storageBytes: number;
  egressBytes: number;
}

/** Per-script Durable Objects metrics */
export interface DOScriptMetrics {
  scriptName: string;
  requests: number;
  gbSeconds: number;
  storageBytes?: number;
}

/** Durable Objects usage metrics */
export interface DOMetrics {
  requests: number;
  responseBodySize: number;
  gbSeconds: number;
  storageBytes: number;
  storageReadUnits: number;
  storageWriteUnits: number;
  storageDeleteUnits: number;
  byScript?: DOScriptMetrics[];
}

/** Vectorize index info */
export interface VectorizeInfo {
  name: string;
  vectorCount: number;
  dimensions: number;
}

/** AI Gateway model breakdown metrics */
export interface AIGatewayModelBreakdown {
  provider: string;
  model: string;
  requests: number;
  cachedRequests: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

/** AI Gateway usage metrics */
export interface AIGatewayMetrics {
  gatewayId: string;
  totalRequests: number;
  cachedRequests: number;
  totalTokens: number;
  estimatedCostUsd: number;
  byModel?: AIGatewayModelBreakdown[];
}

/** Pages usage metrics */
export interface PagesMetrics {
  projectName: string;
  totalBuilds: number;
  totalDeployments: number;
}

/** Sparkline point */
export interface SparklinePoint {
  date: string;
  value: number;
}

/** Sparkline data */
export interface SparklineData {
  points: SparklinePoint[];
  min: number;
  max: number;
  current: number;
  trend: 'up' | 'down' | 'stable';
}

/** Workers error breakdown */
export interface WorkersErrorBreakdown {
  scriptName: string;
  errorCount: number;
  totalRequests: number;
  errorRate: number;
}

/** Queues metrics */
export interface QueuesMetrics {
  queueName: string;
  messagesProduced: number;
  messagesConsumed: number;
}

/** Cache analytics */
export interface CacheAnalytics {
  totalCacheHits: number;
  totalCacheMisses: number;
  hitRate: number;
}

/** Period comparison */
export interface PeriodComparison {
  current: number;
  prior: number;
  delta: number;
  percentChange: number;
  trend: 'up' | 'down' | 'stable';
}

/** Account-wide usage data */
export interface AccountUsage {
  workers: WorkersMetrics[];
  d1: D1Metrics[];
  kv: KVMetrics[];
  r2: R2Metrics[];
  durableObjects: DOMetrics;
  vectorize: VectorizeInfo[];
  aiGateway: AIGatewayMetrics[];
  pages: PagesMetrics[];
  period: TimePeriod;
}

/** Enhanced usage with additional analytics */
export interface EnhancedAccountUsage extends AccountUsage {
  sparklines: Record<string, SparklineData>;
  errorBreakdown: WorkersErrorBreakdown[];
  queues: QueuesMetrics[];
  cache: CacheAnalytics;
}

/** Workers AI metrics from Analytics Engine */
export interface WorkersAIMetrics {
  project: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  isEstimated: boolean;
}

/** Workers AI summary */
export interface WorkersAISummary {
  totalRequests: number;
  totalTokens: number;
  totalCostUsd: number;
  models: Array<{
    model: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }>;
}

/** AI Gateway aggregated metrics */
export interface AIGatewaySummary {
  totalRequests: number;
  totalCachedRequests: number;
  cacheHitRate: number;
  tokensIn: number;
  tokensOut: number;
  totalCostUsd: number;
  byProvider: Record<
    string,
    {
      requests: number;
      cachedRequests: number;
      tokensIn: number;
      tokensOut: number;
      costUsd: number;
    }
  >;
  byModel: Array<{
    provider: string;
    model: string;
    requests: number;
    cachedRequests: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
  }>;
}

/** Daily cost breakdown */
export interface DailyCostBreakdown {
  date: string;
  workers: number;
  d1: number;
  kv: number;
  r2: number;
  vectorize: number;
  aiGateway: number;
  durableObjects: number;
  workersAI: number;
  pages: number;
  queues: number;
  workflows: number;
  total: number;
}

/** Daily cost data (chart data) */
export interface DailyCostData {
  days: DailyCostBreakdown[];
  totalCost: number;
  averageDailyCost: number;
  peakDay: DailyCostBreakdown | null;
}

/** Workflows metrics */
export interface WorkflowsMetrics {
  workflowName: string;
  executions: number;
  successes: number;
  failures: number;
  wallTimeMs: number;
  cpuTimeMs: number;
}

/** Workflows summary */
export interface WorkflowsSummary {
  totalExecutions: number;
  totalSuccesses: number;
  totalFailures: number;
  totalWallTimeMs: number;
  totalCpuTimeMs: number;
  byWorkflow: WorkflowsMetrics[];
}

/** Cloudflare subscription */
export interface CloudflareSubscription {
  ratePlanName: string;
  price: number;
  frequency: string;
}

/** Workers Paid Plan inclusions */
export interface WorkersPaidPlanInclusions {
  requestsIncluded: number;
  cpuTimeIncluded: number;
  d1RowsReadIncluded: number;
  d1RowsWrittenIncluded: number;
  d1StorageIncluded: number;
  kvReadsIncluded: number;
  kvWritesIncluded: number;
  kvStorageIncluded: number;
  r2ClassAIncluded: number;
  r2ClassBIncluded: number;
  r2StorageIncluded: number;
  doRequestsIncluded: number;
  doDurationIncluded: number;
  doStorageIncluded: number;
  vectorizeQueriedDimensionsIncluded: number;
  vectorizeStoredDimensionsIncluded: number;
  queuesOperationsIncluded: number;
}

/** Account subscriptions response */
export interface CloudflareAccountSubscriptions {
  subscriptions: CloudflareSubscription[];
  hasWorkersPaid: boolean;
  hasR2Paid: boolean;
  hasAnalyticsEngine: boolean;
  monthlyBaseCost: number;
  planInclusions: WorkersPaidPlanInclusions;
}

/** Billing profile */
export interface CloudflareBillingProfile {
  accountId: string;
  currency: string;
  paymentMethod: string;
}

// =============================================================================
// CLOUDFLARE GRAPHQL CLIENT
// =============================================================================

/**
 * CloudflareGraphQL client for querying Cloudflare's Analytics API.
 *
 * TODO: Implement your GraphQL queries for the Cloudflare Analytics API.
 * This is a minimal stub — add methods as needed for your metrics collection.
 *
 * @see https://developers.cloudflare.com/analytics/graphql-api/
 */
export class CloudflareGraphQL {
  private accountId: string;
  private apiToken: string;

  constructor(env: { CLOUDFLARE_ACCOUNT_ID: string; CLOUDFLARE_API_TOKEN: string }) {
    this.accountId = env.CLOUDFLARE_ACCOUNT_ID;
    this.apiToken = env.CLOUDFLARE_API_TOKEN;
  }

  /**
   * Fetch all account metrics for a given period.
   * TODO: Implement GraphQL queries for your needed metrics.
   */
  async getAllMetrics(period: TimePeriod): Promise<AccountUsage> {
    // TODO: Implement Cloudflare GraphQL queries
    // @see https://developers.cloudflare.com/analytics/graphql-api/
    throw new Error('CloudflareGraphQL.getAllMetrics() not implemented — add your GraphQL queries');
  }

  /**
   * Get Workflows metrics from GraphQL.
   */
  async getWorkflowsMetrics(_period: TimePeriod): Promise<WorkflowsSummary> {
    throw new Error(
      'CloudflareGraphQL.getWorkflowsMetrics() not implemented — add your GraphQL queries'
    );
  }

  /**
   * Get Queues metrics from GraphQL.
   */
  async getQueuesMetrics(_period: TimePeriod): Promise<QueuesMetrics[]> {
    throw new Error(
      'CloudflareGraphQL.getQueuesMetrics() not implemented — add your GraphQL queries'
    );
  }

  /**
   * Get Workers AI metrics from Analytics Engine.
   */
  async getWorkersAIMetrics(
    _period: TimePeriod
  ): Promise<{ metrics: WorkersAIMetrics[]; totalRequests: number }> {
    throw new Error(
      'CloudflareGraphQL.getWorkersAIMetrics() not implemented — add your GraphQL queries'
    );
  }

  /**
   * Get Workers AI neuron data from GraphQL.
   */
  async getWorkersAINeuronsGraphQL(_dateRange: DateRange): Promise<{
    totalNeurons: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    byModel: Array<{
      modelId: string;
      requestCount: number;
      inputTokens: number;
      outputTokens: number;
      neurons: number;
    }>;
  }> {
    throw new Error(
      'CloudflareGraphQL.getWorkersAINeuronsGraphQL() not implemented — add your GraphQL queries'
    );
  }

  /**
   * Get Vectorize query metrics from GraphQL.
   */
  async getVectorizeQueriesGraphQL(_dateRange: DateRange): Promise<{
    totalQueriedDimensions: number;
    totalServedVectors: number;
    byIndex: Array<{ indexName: string; queriedDimensions: number }>;
  }> {
    throw new Error(
      'CloudflareGraphQL.getVectorizeQueriesGraphQL() not implemented — add your GraphQL queries'
    );
  }

  /**
   * Get Vectorize storage metrics from GraphQL.
   */
  async getVectorizeStorageGraphQL(_dateRange: DateRange): Promise<{
    totalStoredDimensions: number;
    totalVectorCount: number;
    byIndex: Array<{ indexName: string; storedDimensions: number; vectorCount: number }>;
  }> {
    throw new Error(
      'CloudflareGraphQL.getVectorizeStorageGraphQL() not implemented — add your GraphQL queries'
    );
  }

  /**
   * Get Cloudflare account subscriptions.
   */
  async getAccountSubscriptions(): Promise<CloudflareAccountSubscriptions | null> {
    throw new Error(
      'CloudflareGraphQL.getAccountSubscriptions() not implemented — add your REST API calls'
    );
  }
}

// =============================================================================
// COST CALCULATOR
// =============================================================================

/** Cloudflare pricing constants (Workers Paid plan) */
export const CF_PRICING = {
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
  durableObjects: {
    requestsPerMillion: 0.15,
    gbSecondsPerMillion: 12.5,
    storagePerGbMonth: 0.2,
    readsPerMillion: 0.2,
    writesPerMillion: 1.0,
    deletesPerMillion: 1.0,
  },
  vectorize: {
    storedDimensionsPerMillion: 0.01,
    queriedDimensionsPerMillion: 0.01,
  },
  aiGateway: { free: true },
  workersAI: {
    models: {
      default: { input: 0.2, output: 0.4 },
    } as Record<string, { input: number; output: number }>,
    neuronsPerThousand: 0.011,
  },
  pages: {
    buildCost: 0.15,
    bandwidthPerGb: 0.02,
  },
  queues: {
    messagesPerMillion: 0.4,
    operationsPerMillion: 0.4,
  },
  workflows: { free: true },
} as const;

/** Workers Paid Plan monthly allowances */
export const CF_PAID_ALLOWANCES = {
  d1: { rowsRead: 25_000_000_000, rowsWritten: 50_000_000 },
  kv: { reads: 10_000_000, writes: 1_000_000, deletes: 1_000_000, lists: 1_000_000 },
  r2: { storage: 10_000_000_000, classA: 1_000_000, classB: 10_000_000 },
  durableObjects: { requests: 1_000_000, gbSeconds: 400_000 },
  vectorize: { storedDimensions: 10_000_000, queriedDimensions: 50_000_000 },
  queues: { operations: 1_000_000 },
  pages: { builds: 500 },
  workersAI: { neurons: 0 },
} as const;

/** Free tier limits */
export const CF_FREE_LIMITS = {
  workers: { requestsPerDay: 100_000, cpuMsPerInvocation: 10 },
  d1: { rowsReadPerDay: 5_000_000, rowsWrittenPerDay: 100_000, storageGb: 5 },
  kv: { readsPerDay: 100_000, writesPerDay: 1_000, storageGb: 1 },
  r2: { storageGb: 10, classAPerMonth: 1_000_000, classBPerMonth: 10_000_000 },
  durableObjects: { requestsPerMonth: 1_000_000, gbSecondsPerMonth: 400_000, storageGb: 1 },
  vectorize: { storedDimensionsPerMonth: 10_000_000, queriesPerMonth: 50_000_000 },
  pages: { buildsPerMonth: 500, bandwidthGbPerMonth: 100 },
  queues: { messagesPerMonth: 1_000_000, operationsPerMonth: 1_000_000 },
  workflows: { cpuMsPerMonth: 10_000_000 },
  workersAI: { neuronsPerDay: 10_000 },
} as const;

/** Cost breakdown by resource type */
export interface CostBreakdown {
  workers: number;
  d1: number;
  kv: number;
  r2: number;
  durableObjects: number;
  vectorize: number;
  aiGateway: number;
  workersAI: number;
  pages: number;
  queues: number;
  workflows: number;
  total: number;
}

/** Cost breakdown by project */
export interface ProjectCostBreakdown {
  project: string;
  workers: number;
  d1: number;
  kv: number;
  r2: number;
  durableObjects: number;
  vectorize: number;
  aiGateway: number;
  workersAI: number;
  total: number;
  doRequests: number;
  doGbSeconds: number;
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
  r2StorageBytes: number;
}

/** Threshold levels */
export type ThresholdLevel = 'normal' | 'warning' | 'high' | 'critical';

/** Threshold warning */
export interface ThresholdWarning {
  resource: string;
  metric: string;
  current: number;
  limit: number;
  percentage: number;
  level: ThresholdLevel;
}

/** Threshold analysis result */
export interface ThresholdAnalysis {
  warnings: ThresholdWarning[];
  hasWarnings: boolean;
  hasCritical: boolean;
}

/** Service type for alert thresholds */
export type AlertServiceType =
  | 'workers'
  | 'd1'
  | 'kv'
  | 'r2'
  | 'durableObjects'
  | 'vectorize'
  | 'aiGateway'
  | 'workersAI'
  | 'pages'
  | 'queues'
  | 'workflows';

/** Configurable alert thresholds per service type */
export interface ServiceThreshold {
  warningPct: number;
  highPct: number;
  criticalPct: number;
  absoluteMax: number;
  enabled: boolean;
}

/** All configurable alert thresholds */
export interface AlertThresholds {
  [key: string]: ServiceThreshold;
}

/** Daily usage metrics input for cost calculation */
export interface DailyUsageMetrics {
  workersRequests: number;
  workersCpuMs: number;
  d1Reads: number;
  d1Writes: number;
  kvReads: number;
  kvWrites: number;
  kvDeletes?: number;
  kvLists?: number;
  r2ClassA: number;
  r2ClassB: number;
  vectorizeQueries: number;
  aiGatewayRequests: number;
  durableObjectsRequests: number;
  durableObjectsGbSeconds?: number;
  workersAITokens?: number;
  queuesMessages?: number;
}

/** Default alert thresholds */
export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  workers: { warningPct: 50, highPct: 75, criticalPct: 90, absoluteMax: 5, enabled: true },
  d1: { warningPct: 40, highPct: 60, criticalPct: 80, absoluteMax: 20, enabled: true },
  kv: { warningPct: 50, highPct: 75, criticalPct: 90, absoluteMax: 5, enabled: true },
  r2: { warningPct: 50, highPct: 75, criticalPct: 90, absoluteMax: 20, enabled: true },
  durableObjects: { warningPct: 50, highPct: 75, criticalPct: 90, absoluteMax: 10, enabled: true },
  vectorize: { warningPct: 50, highPct: 75, criticalPct: 90, absoluteMax: 5, enabled: true },
  aiGateway: { warningPct: 50, highPct: 75, criticalPct: 90, absoluteMax: 0, enabled: false },
  workersAI: { warningPct: 50, highPct: 75, criticalPct: 90, absoluteMax: 10, enabled: true },
  pages: { warningPct: 50, highPct: 75, criticalPct: 90, absoluteMax: 5, enabled: true },
  queues: { warningPct: 50, highPct: 75, criticalPct: 90, absoluteMax: 5, enabled: true },
  workflows: { warningPct: 50, highPct: 75, criticalPct: 90, absoluteMax: 0, enabled: false },
};

/**
 * Project patterns for resource identification.
 *
 * TODO: Customise these for your projects.
 * Workers are matched by name (case-insensitive contains) or regex.
 */
export const PROJECT_PATTERNS: Record<
  string,
  {
    workers: (string | RegExp)[];
    d1: (string | RegExp)[];
    kv: (string | RegExp)[];
    r2: (string | RegExp)[];
    vectorize: (string | RegExp)[];
    aiGateway: (string | RegExp)[];
  }
> = {
  // TODO: Add your project patterns here. Example:
  // 'my-project': {
  //   workers: [/^my-project/],
  //   d1: [/^my-project/],
  //   kv: [/^MY_PROJECT/],
  //   r2: [/^my-project/],
  //   vectorize: [/^my-project/],
  //   aiGateway: ['my-project'],
  // },
};

/** Identify which project a resource belongs to */
export function identifyProject(resourceName: string): string | null {
  for (const [project, patterns] of Object.entries(PROJECT_PATTERNS)) {
    const allPatterns = [
      ...patterns.workers,
      ...patterns.d1,
      ...patterns.kv,
      ...patterns.r2,
      ...patterns.vectorize,
      ...patterns.aiGateway,
    ];

    for (const pattern of allPatterns) {
      if (typeof pattern === 'string') {
        if (
          resourceName === pattern ||
          resourceName.toLowerCase().includes(pattern.toLowerCase())
        ) {
          return project;
        }
      } else if (pattern.test(resourceName)) {
        return project;
      }
    }
  }

  return null;
}

function calculateOverage(usage: number, included: number): number {
  return Math.max(0, usage - included);
}

function calculateWorkersUsageCost(workers: WorkersMetrics[]): number {
  const totalRequests = workers.reduce((sum, w) => sum + w.requests, 0);
  const totalCpuMs = workers.reduce((sum, w) => sum + w.cpuTimeMs, 0);
  let cost = 0;
  const overageRequests = Math.max(0, totalRequests - CF_PRICING.workers.includedRequests);
  cost += (overageRequests / 1_000_000) * CF_PRICING.workers.requestsPerMillion;
  cost += (totalCpuMs / 1_000_000) * CF_PRICING.workers.cpuMsPerMillion;
  return cost;
}

function calculateD1Cost(d1: D1Metrics[]): number {
  const totalRowsRead = d1.reduce((sum, db) => sum + db.rowsRead, 0);
  const totalRowsWritten = d1.reduce((sum, db) => sum + db.rowsWritten, 0);
  let cost = 0;
  cost +=
    (calculateOverage(totalRowsRead, CF_PAID_ALLOWANCES.d1.rowsRead) / 1_000_000_000) *
    CF_PRICING.d1.rowsReadPerBillion;
  cost +=
    (calculateOverage(totalRowsWritten, CF_PAID_ALLOWANCES.d1.rowsWritten) / 1_000_000) *
    CF_PRICING.d1.rowsWrittenPerMillion;
  return cost;
}

function calculateKVCost(kv: KVMetrics[]): number {
  const totalReads = kv.reduce((sum, ns) => sum + ns.reads, 0);
  const totalWrites = kv.reduce((sum, ns) => sum + ns.writes, 0);
  const totalDeletes = kv.reduce((sum, ns) => sum + ns.deletes, 0);
  const totalLists = kv.reduce((sum, ns) => sum + ns.lists, 0);
  let cost = 0;
  cost +=
    (calculateOverage(totalReads, CF_PAID_ALLOWANCES.kv.reads) / 1_000_000) *
    CF_PRICING.kv.readsPerMillion;
  cost +=
    (calculateOverage(totalWrites, CF_PAID_ALLOWANCES.kv.writes) / 1_000_000) *
    CF_PRICING.kv.writesPerMillion;
  cost +=
    (calculateOverage(totalDeletes, CF_PAID_ALLOWANCES.kv.deletes) / 1_000_000) *
    CF_PRICING.kv.deletesPerMillion;
  cost +=
    (calculateOverage(totalLists, CF_PAID_ALLOWANCES.kv.lists) / 1_000_000) *
    CF_PRICING.kv.listsPerMillion;
  return cost;
}

function calculateR2Cost(r2: R2Metrics[]): number {
  const totalStorage = r2.reduce((sum, b) => sum + b.storageBytes, 0);
  const totalClassA = r2.reduce((sum, b) => sum + b.classAOperations, 0);
  const totalClassB = r2.reduce((sum, b) => sum + b.classBOperations, 0);
  let cost = 0;
  cost +=
    (calculateOverage(totalStorage, CF_PAID_ALLOWANCES.r2.storage) / 1_000_000_000) *
    CF_PRICING.r2.storagePerGbMonth;
  cost +=
    (calculateOverage(totalClassA, CF_PAID_ALLOWANCES.r2.classA) / 1_000_000) *
    CF_PRICING.r2.classAPerMillion;
  cost +=
    (calculateOverage(totalClassB, CF_PAID_ALLOWANCES.r2.classB) / 1_000_000) *
    CF_PRICING.r2.classBPerMillion;
  return cost;
}

function calculateDOCost(doMetrics: DOMetrics): number {
  let cost = 0;
  cost +=
    (calculateOverage(doMetrics.requests, CF_PAID_ALLOWANCES.durableObjects.requests) / 1_000_000) *
    CF_PRICING.durableObjects.requestsPerMillion;
  cost +=
    (calculateOverage(doMetrics.gbSeconds, CF_PAID_ALLOWANCES.durableObjects.gbSeconds) /
      1_000_000) *
    CF_PRICING.durableObjects.gbSecondsPerMillion;
  cost += (doMetrics.storageReadUnits / 1_000_000) * CF_PRICING.durableObjects.readsPerMillion;
  cost += (doMetrics.storageWriteUnits / 1_000_000) * CF_PRICING.durableObjects.writesPerMillion;
  cost += (doMetrics.storageDeleteUnits / 1_000_000) * CF_PRICING.durableObjects.deletesPerMillion;
  return cost;
}

function calculateVectorizeCost(vectorize: VectorizeInfo[]): number {
  const totalDimensions = vectorize.reduce((sum, v) => sum + v.vectorCount * v.dimensions, 0);
  const overageDimensions = calculateOverage(
    totalDimensions,
    CF_PAID_ALLOWANCES.vectorize.storedDimensions
  );
  return (overageDimensions / 1_000_000) * CF_PRICING.vectorize.storedDimensionsPerMillion;
}

function calculatePagesCost(pages: PagesMetrics[]): number {
  const totalBuilds = pages.reduce((sum, p) => sum + p.totalBuilds, 0);
  const overageBuilds = Math.max(0, totalBuilds - CF_FREE_LIMITS.pages.buildsPerMonth);
  return overageBuilds * CF_PRICING.pages.buildCost;
}

function calculateQueuesCost(queues: QueuesMetrics[]): number {
  const totalMessages = queues.reduce((sum, q) => sum + q.messagesProduced + q.messagesConsumed, 0);
  const overageMessages = Math.max(0, totalMessages - CF_FREE_LIMITS.queues.messagesPerMonth);
  return (overageMessages / 1_000_000) * CF_PRICING.queues.messagesPerMillion;
}

/** Calculate cost breakdown for account usage */
export function calculateMonthlyCosts(
  usage: AccountUsage & { queues?: QueuesMetrics[] }
): CostBreakdown {
  const periodDays = usage.period === '24h' ? 1 : usage.period === '7d' ? 7 : 30;
  const baseProration = periodDays / 30;
  const workersUsage = calculateWorkersUsageCost(usage.workers);
  const workersBase = CF_PRICING.workers.baseCostMonthly * baseProration;
  const workers = workersBase + workersUsage;
  const d1 = calculateD1Cost(usage.d1);
  const kv = calculateKVCost(usage.kv);
  const r2 = calculateR2Cost(usage.r2);
  const durableObjects = calculateDOCost(usage.durableObjects);
  const vectorize = calculateVectorizeCost(usage.vectorize);
  const aiGateway = 0;
  const pages = calculatePagesCost(usage.pages);
  const queues = calculateQueuesCost(usage.queues ?? []);
  const workflows = 0;

  return {
    workers,
    d1,
    kv,
    r2,
    durableObjects,
    vectorize,
    aiGateway,
    pages,
    queues,
    workflows,
    workersAI: 0,
    total:
      workers + d1 + kv + r2 + durableObjects + vectorize + aiGateway + pages + queues + workflows,
  };
}

/** Calculate cost breakdown by project */
export function calculateProjectCosts(usage: AccountUsage): ProjectCostBreakdown[] {
  const projectCosts = new Map<string, ProjectCostBreakdown>();

  const createEmptyBreakdown = (projectName: string): ProjectCostBreakdown => ({
    project: projectName,
    workers: 0,
    d1: 0,
    kv: 0,
    r2: 0,
    durableObjects: 0,
    vectorize: 0,
    aiGateway: 0,
    workersAI: 0,
    total: 0,
    doRequests: 0,
    doGbSeconds: 0,
    workersRequests: 0,
    workersErrors: 0,
    workersCpuTimeMs: 0,
    d1RowsRead: 0,
    d1RowsWritten: 0,
    kvReads: 0,
    kvWrites: 0,
    kvDeletes: 0,
    kvLists: 0,
    r2ClassAOps: 0,
    r2ClassBOps: 0,
    r2StorageBytes: 0,
  });

  for (const project of Object.keys(PROJECT_PATTERNS)) {
    projectCosts.set(project, createEmptyBreakdown(project));
  }
  projectCosts.set('other', createEmptyBreakdown('other'));

  const periodDays = usage.period === '24h' ? 1 : usage.period === '7d' ? 7 : 30;
  const baseProration = periodDays / 30;
  const proratedBaseCost = CF_PRICING.workers.baseCostMonthly * baseProration;
  const totalRequests = usage.workers.reduce((sum, w) => sum + w.requests, 0);
  const projectRequests = new Map<string, number>();

  for (const worker of usage.workers) {
    const project = identifyProject(worker.scriptName) ?? 'other';
    projectRequests.set(project, (projectRequests.get(project) ?? 0) + worker.requests);
  }

  for (const worker of usage.workers) {
    const project = identifyProject(worker.scriptName) ?? 'other';
    const usageCost = calculateWorkersUsageCost([worker]);
    if (!projectCosts.has(project)) {
      projectCosts.set(project, createEmptyBreakdown(project));
    }
    const entry = projectCosts.get(project)!;
    entry.workers += usageCost;
    entry.total += usageCost;
    entry.workersRequests += worker.requests;
    entry.workersErrors += worker.errors;
    entry.workersCpuTimeMs += worker.cpuTimeMs;
  }

  if (totalRequests > 0) {
    for (const [project, requests] of Array.from(projectRequests.entries())) {
      const proportion = requests / totalRequests;
      const baseCostShare = proratedBaseCost * proportion;
      if (!projectCosts.has(project)) {
        projectCosts.set(project, createEmptyBreakdown(project));
      }
      const entry = projectCosts.get(project)!;
      entry.workers += baseCostShare;
      entry.total += baseCostShare;
    }
  }

  // D1 cost distribution
  const totalD1Cost = calculateD1Cost(usage.d1);
  const totalD1Usage = usage.d1.reduce((sum, db) => sum + db.rowsRead + db.rowsWritten, 0);
  for (const db of usage.d1) {
    const project = identifyProject(db.databaseName) ?? 'other';
    if (!projectCosts.has(project)) {
      projectCosts.set(project, createEmptyBreakdown(project));
    }
    const entry = projectCosts.get(project)!;
    if (totalD1Usage > 0 && totalD1Cost > 0) {
      const dbUsage = db.rowsRead + db.rowsWritten;
      const proportion = dbUsage / totalD1Usage;
      const cost = totalD1Cost * proportion;
      entry.d1 += cost;
      entry.total += cost;
    }
    entry.d1RowsRead += db.rowsRead;
    entry.d1RowsWritten += db.rowsWritten;
  }

  // KV cost distribution
  const totalKVCost = calculateKVCost(usage.kv);
  const totalKVUsage = usage.kv.reduce(
    (sum, ns) => sum + ns.reads + ns.writes + ns.deletes + ns.lists,
    0
  );
  for (const ns of usage.kv) {
    const project = identifyProject(ns.namespaceName) ?? 'other';
    if (!projectCosts.has(project)) {
      projectCosts.set(project, createEmptyBreakdown(project));
    }
    const entry = projectCosts.get(project)!;
    if (totalKVUsage > 0 && totalKVCost > 0) {
      const nsUsage = ns.reads + ns.writes + ns.deletes + ns.lists;
      const proportion = nsUsage / totalKVUsage;
      const cost = totalKVCost * proportion;
      entry.kv += cost;
      entry.total += cost;
    }
    entry.kvReads += ns.reads;
    entry.kvWrites += ns.writes;
    entry.kvDeletes += ns.deletes;
    entry.kvLists += ns.lists;
  }

  // R2 cost distribution
  const totalR2Cost = calculateR2Cost(usage.r2);
  const totalR2Usage = usage.r2.reduce(
    (sum, b) =>
      sum +
      b.storageBytes / 1_000_000_000 +
      b.classAOperations * 0.001 +
      b.classBOperations * 0.0001,
    0
  );
  for (const bucket of usage.r2) {
    const project = identifyProject(bucket.bucketName) ?? 'other';
    if (!projectCosts.has(project)) {
      projectCosts.set(project, createEmptyBreakdown(project));
    }
    const entry = projectCosts.get(project)!;
    if (totalR2Usage > 0 && totalR2Cost > 0) {
      const bucketUsage =
        bucket.storageBytes / 1_000_000_000 +
        bucket.classAOperations * 0.001 +
        bucket.classBOperations * 0.0001;
      const proportion = bucketUsage / totalR2Usage;
      const cost = totalR2Cost * proportion;
      entry.r2 += cost;
      entry.total += cost;
    }
    entry.r2ClassAOps += bucket.classAOperations;
    entry.r2ClassBOps += bucket.classBOperations;
    entry.r2StorageBytes += bucket.storageBytes;
  }

  // DO cost distribution
  const totalDOCost = calculateDOCost(usage.durableObjects);
  if (usage.durableObjects.byScript && usage.durableObjects.byScript.length > 0) {
    const totalWeight = usage.durableObjects.byScript.reduce(
      (sum, script) => sum + script.requests * 0.3 + script.gbSeconds * 0.7,
      0
    );
    if (totalWeight > 0) {
      for (const script of usage.durableObjects.byScript) {
        const project = identifyProject(script.scriptName) ?? 'other';
        const scriptWeight = script.requests * 0.3 + script.gbSeconds * 0.7;
        const scriptCost = totalDOCost > 0 ? totalDOCost * (scriptWeight / totalWeight) : 0;
        if (!projectCosts.has(project)) {
          projectCosts.set(project, createEmptyBreakdown(project));
        }
        const entry = projectCosts.get(project)!;
        entry.durableObjects += scriptCost;
        entry.total += scriptCost;
        entry.doRequests += script.requests;
        entry.doGbSeconds += script.gbSeconds;
      }
    }
  }

  // Vectorize cost distribution
  const totalVectorizeCost = calculateVectorizeCost(usage.vectorize);
  const totalVectorizeUsage = usage.vectorize.reduce(
    (sum, v) => sum + v.vectorCount * v.dimensions,
    0
  );
  for (const index of usage.vectorize) {
    const project = identifyProject(index.name) ?? 'other';
    if (!projectCosts.has(project)) {
      projectCosts.set(project, createEmptyBreakdown(project));
    }
    const entry = projectCosts.get(project)!;
    if (totalVectorizeUsage > 0 && totalVectorizeCost > 0) {
      const indexUsage = index.vectorCount * index.dimensions;
      const proportion = indexUsage / totalVectorizeUsage;
      const cost = totalVectorizeCost * proportion;
      entry.vectorize += cost;
      entry.total += cost;
    }
  }

  return Array.from(projectCosts.values()).filter((p) => p.total > 0);
}

/** Get threshold level */
export function getThresholdLevel(
  percentage: number,
  thresholds?: ServiceThreshold
): ThresholdLevel {
  const criticalPct = thresholds?.criticalPct ?? 90;
  const highPct = thresholds?.highPct ?? 75;
  const warningPct = thresholds?.warningPct ?? 50;
  if (percentage >= criticalPct) return 'critical';
  if (percentage >= highPct) return 'high';
  if (percentage >= warningPct) return 'warning';
  return 'normal';
}

/** Merge custom thresholds with defaults */
export function mergeThresholds(custom?: Partial<AlertThresholds>): AlertThresholds {
  if (!custom) return DEFAULT_ALERT_THRESHOLDS;
  const merged: AlertThresholds = { ...DEFAULT_ALERT_THRESHOLDS };
  for (const key of Object.keys(custom)) {
    if (merged[key] && custom[key]) {
      merged[key] = { ...merged[key], ...custom[key] };
    }
  }
  return merged;
}

/** Analyse usage against thresholds */
export function analyseThresholds(
  usage: AccountUsage,
  customThresholds?: Partial<AlertThresholds>
): ThresholdAnalysis {
  const warnings: ThresholdWarning[] = [];
  const thresholds = mergeThresholds(customThresholds);
  const dailyScale = usage.period === '24h' ? 1 : usage.period === '7d' ? 1 / 7 : 1 / 30;

  const shouldWarn = (serviceType: string, percentage: number): boolean => {
    const t = thresholds[serviceType];
    if (!t || !t.enabled) return false;
    return percentage >= t.warningPct;
  };

  if (thresholds.workers.enabled) {
    const totalRequests = usage.workers.reduce((sum, w) => sum + w.requests, 0);
    const dailyRequests = totalRequests * dailyScale;
    const pct = (dailyRequests / CF_FREE_LIMITS.workers.requestsPerDay) * 100;
    if (shouldWarn('workers', pct)) {
      warnings.push({
        resource: 'Workers',
        metric: 'Requests/day',
        current: dailyRequests,
        limit: CF_FREE_LIMITS.workers.requestsPerDay,
        percentage: pct,
        level: getThresholdLevel(pct, thresholds.workers),
      });
    }
  }

  if (thresholds.d1.enabled) {
    const totalRowsRead = usage.d1.reduce((sum, db) => sum + db.rowsRead, 0);
    const dailyRowsRead = totalRowsRead * dailyScale;
    const pct = (dailyRowsRead / CF_FREE_LIMITS.d1.rowsReadPerDay) * 100;
    if (shouldWarn('d1', pct)) {
      warnings.push({
        resource: 'D1',
        metric: 'Rows Read/day',
        current: dailyRowsRead,
        limit: CF_FREE_LIMITS.d1.rowsReadPerDay,
        percentage: pct,
        level: getThresholdLevel(pct, thresholds.d1),
      });
    }
  }

  return {
    warnings,
    hasWarnings: warnings.length > 0,
    hasCritical: warnings.some((w) => w.level === 'critical'),
  };
}

/** Calculate costs for a single day's usage metrics */
export function calculateDailyCosts(usage: DailyUsageMetrics): Omit<DailyCostBreakdown, 'date'> {
  const dailyIncludedRequests = CF_PRICING.workers.includedRequests / 30;
  const overageRequests = Math.max(0, usage.workersRequests - dailyIncludedRequests);
  const workersCost =
    (overageRequests / 1_000_000) * CF_PRICING.workers.requestsPerMillion +
    (usage.workersCpuMs / 1_000_000) * CF_PRICING.workers.cpuMsPerMillion;
  const d1Cost =
    (usage.d1Reads / 1_000_000_000) * CF_PRICING.d1.rowsReadPerBillion +
    (usage.d1Writes / 1_000_000) * CF_PRICING.d1.rowsWrittenPerMillion;
  const kvCost =
    (usage.kvReads / 1_000_000) * CF_PRICING.kv.readsPerMillion +
    (usage.kvWrites / 1_000_000) * CF_PRICING.kv.writesPerMillion +
    ((usage.kvDeletes ?? 0) / 1_000_000) * CF_PRICING.kv.deletesPerMillion +
    ((usage.kvLists ?? 0) / 1_000_000) * CF_PRICING.kv.listsPerMillion;
  const r2Cost =
    (usage.r2ClassA / 1_000_000) * CF_PRICING.r2.classAPerMillion +
    (usage.r2ClassB / 1_000_000) * CF_PRICING.r2.classBPerMillion;
  const vectorizeCost =
    (usage.vectorizeQueries / 1_000_000) * CF_PRICING.vectorize.queriedDimensionsPerMillion;
  const durableObjectsCost =
    (usage.durableObjectsRequests / 1_000_000) * CF_PRICING.durableObjects.requestsPerMillion +
    ((usage.durableObjectsGbSeconds ?? 0) / 1_000_000) *
      CF_PRICING.durableObjects.gbSecondsPerMillion;
  const workersAITokens = usage.workersAITokens ?? 0;
  const workersAICost =
    ((workersAITokens / 1_000_000) *
      (CF_PRICING.workersAI.models['default'].input +
        CF_PRICING.workersAI.models['default'].output)) /
    2;
  const queuesMessages = usage.queuesMessages ?? 0;
  const queuesCost = (queuesMessages / 1_000_000) * CF_PRICING.queues.messagesPerMillion;
  const total =
    workersCost +
    d1Cost +
    kvCost +
    r2Cost +
    vectorizeCost +
    durableObjectsCost +
    workersAICost +
    queuesCost;

  return {
    workers: workersCost,
    d1: d1Cost,
    kv: kvCost,
    r2: r2Cost,
    vectorize: vectorizeCost,
    aiGateway: 0,
    durableObjects: durableObjectsCost,
    workersAI: workersAICost,
    pages: 0,
    queues: queuesCost,
    workflows: 0,
    total,
  };
}

/** Format number for display */
export function formatNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toLocaleString('en-AU');
}

/** Format currency for display */
export function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

// =============================================================================
// PROJECT REGISTRY (D1-backed)
// =============================================================================

// Re-export from shared types (already defined there)
export type { Project, ResourceMapping, ResourceType } from './types';

/** In-memory cache for registry data */
interface RegistryCache {
  projects: Map<string, import('./types').Project>;
  loadedAt: number;
}

let registryCache: RegistryCache | null = null;
const REGISTRY_CACHE_TTL_MS = 5 * 60 * 1000;

/** Clear the in-memory cache */
export function clearRegistryCache(): void {
  registryCache = null;
}

/** Get all projects from D1 */
export async function getProjects(db: D1Database): Promise<import('./types').Project[]> {
  if (registryCache && Date.now() - registryCache.loadedAt < REGISTRY_CACHE_TTL_MS) {
    return Array.from(registryCache.projects.values());
  }

  try {
    const result = await db
      .prepare(
        `SELECT project_id, display_name, description, color, icon, owner,
                repo_path, status, primary_resource, custom_limit, repo_url, github_repo_id
         FROM project_registry
         WHERE status != 'archived'
         ORDER BY display_name`
      )
      .all<{
        project_id: string;
        display_name: string;
        description: string | null;
        color: string | null;
        icon: string | null;
        owner: string | null;
        repo_path: string | null;
        status: string;
        primary_resource: string | null;
        custom_limit: number | null;
        repo_url: string | null;
        github_repo_id: string | null;
      }>();

    const projects: import('./types').Project[] = (result.results ?? []).map((row) => ({
      projectId: row.project_id,
      displayName: row.display_name,
      description: row.description,
      color: row.color,
      icon: row.icon,
      owner: row.owner,
      repoPath: row.repo_path,
      status: row.status as 'active' | 'archived' | 'development',
      primaryResource: row.primary_resource as import('./types').ResourceType | null,
      customLimit: row.custom_limit,
      repoUrl: row.repo_url,
      githubRepoId: row.github_repo_id,
    }));

    // Update cache
    const projectMap = new Map<string, import('./types').Project>();
    for (const p of projects) {
      projectMap.set(p.projectId, p);
    }
    registryCache = { projects: projectMap, loadedAt: Date.now() };

    return projects;
  } catch {
    return [];
  }
}

/** Get a single project by ID */
export async function getProject(
  db: D1Database,
  projectId: string
): Promise<import('./types').Project | null> {
  const projects = await getProjects(db);
  return projects.find((p) => p.projectId === projectId) ?? null;
}

/** Identify project from D1 registry */
export async function identifyProjectFromRegistry(
  db: D1Database,
  resourceType: string,
  resourceName: string
): Promise<string | null> {
  try {
    const result = await db
      .prepare(
        `SELECT project_id FROM resource_project_mapping
         WHERE resource_type = ? AND (resource_name = ? OR resource_id = ?)
         LIMIT 1`
      )
      .bind(resourceType, resourceName, resourceName)
      .first<{ project_id: string }>();

    return result?.project_id ?? identifyProject(resourceName);
  } catch {
    return identifyProject(resourceName);
  }
}

// =============================================================================
// D1 HELPERS
// =============================================================================

/** Health check record from system_health_checks table */
export interface HealthCheckRecord {
  service_name: string;
  status: string;
  last_check: string;
  details: string | null;
}

/** Project health map */
export type ProjectHealthMap = Map<string, HealthCheckRecord>;

/** Get system health from D1 */
export async function getSystemHealth(db: D1Database): Promise<ProjectHealthMap> {
  const healthMap: ProjectHealthMap = new Map();
  try {
    const result = await db
      .prepare(
        `SELECT service_name, status, last_check, details
         FROM system_health_checks
         ORDER BY last_check DESC`
      )
      .all<HealthCheckRecord>();
    for (const row of result.results ?? []) {
      healthMap.set(row.service_name, row);
    }
  } catch {
    // Table may not exist yet
  }
  return healthMap;
}
