/**
 * Shared Cost Calculation Module
 *
 * Provides proration constants and cost calculation functions for different
 * time granularities (hourly, daily, monthly).
 *
 * Problem solved: Monthly base costs (e.g., $5/mo for Workers Paid) were being
 * applied without proration to hourly snapshots, causing inflated cost estimates.
 *
 * Solution:
 * - Hourly: base_cost = monthly_cost / HOURS_PER_MONTH (~730)
 * - Daily: base_cost = monthly_cost / DAYS_PER_MONTH (~30.42)
 * - Monthly: full base_cost
 *
 * @see https://developers.cloudflare.com/workers/platform/pricing/
 */

// =============================================================================
// PRORATION CONSTANTS
// =============================================================================

/**
 * Average hours per month: 365 * 24 / 12 = 730
 * Used for hourly snapshot proration.
 */
export const HOURS_PER_MONTH = (365 * 24) / 12; // ~730

/**
 * Average days per month: 365 / 12 = 30.4167
 * Used for daily rollup proration.
 */
export const DAYS_PER_MONTH = 365 / 12; // ~30.42

// =============================================================================
// PRICING TIERS (Consolidated from dashboard/src/lib/cloudflare/costs.ts)
// =============================================================================

/**
 * Cloudflare pricing constants (Workers Paid plan, as of Jan 2025)
 * Single source of truth for all cost calculations.
 *
 * NOTE: When updating pricing, also update dashboard/src/lib/cloudflare/costs.ts CF_PRICING
 */
export const PRICING_TIERS = {
  // Workers Paid: $5/month base + usage
  workers: {
    baseCostMonthly: 5.0,
    includedRequests: 10_000_000, // 10M included
    requestsPerMillion: 0.3, // $0.30 per million after included
    cpuMsPerMillion: 0.02, // $0.02 per million CPU ms
  },

  // D1: Pay per use
  d1: {
    rowsReadPerBillion: 0.001, // $0.001 per billion rows read
    rowsWrittenPerMillion: 1.0, // $1.00 per million rows written
    storagePerGb: 0.75, // $0.75 per GB-month
  },

  // KV: Pay per use
  kv: {
    readsPerMillion: 0.5, // $0.50 per million reads
    writesPerMillion: 5.0, // $5.00 per million writes
    deletesPerMillion: 5.0, // $5.00 per million deletes
    listsPerMillion: 5.0, // $5.00 per million lists
    storagePerGb: 0.5, // $0.50 per GB-month
  },

  // R2: Pay per use (no egress fees!)
  r2: {
    storagePerGbMonth: 0.015, // $0.015 per GB-month
    classAPerMillion: 4.5, // $4.50 per million Class A ops
    classBPerMillion: 0.36, // $0.36 per million Class B ops
  },

  // Durable Objects: Pay per use
  durableObjects: {
    requestsPerMillion: 0.15, // $0.15 per million requests
    gbSecondsPerMillion: 12.5, // $12.50 per million GB-seconds
    storagePerGbMonth: 0.2, // $0.20 per GB-month
    readsPerMillion: 0.2, // $0.20 per million storage reads
    writesPerMillion: 1.0, // $1.00 per million storage writes
    deletesPerMillion: 1.0, // $1.00 per million storage deletes
  },

  // Vectorize: Pay per use
  vectorize: {
    storedDimensionsPerMillion: 0.01, // $0.01 per million stored dimensions
    queriedDimensionsPerMillion: 0.01, // $0.01 per million queried dimensions
  },

  // AI Gateway: Free tier (logs only)
  aiGateway: {
    free: true,
  },

  // Workers AI: Pay per use
  workersAI: {
    neuronsPerThousand: 0.011, // $0.011 per 1,000 neurons
    models: {
      '@cf/meta/llama-3.1-8b-instruct-fp8': { input: 0.152, output: 0.287 },
      '@cf/meta/llama-3.2-3b-instruct': { input: 0.1, output: 0.2 },
      default: { input: 0.2, output: 0.4 },
    } as Record<string, { input: number; output: number }>,
  },

  // Pages: Generous free tier
  pages: {
    buildCost: 0.15, // $0.15 per build after 500 free
    bandwidthPerGb: 0.02, // $0.02 per GB after 100GB free
  },

  // Queues: Pay per use
  queues: {
    messagesPerMillion: 0.4, // $0.40 per million messages
    operationsPerMillion: 0.4, // $0.40 per million operations
  },

  // Workflows: Beta (no pricing yet)
  workflows: {
    free: true, // Currently in beta
  },
} as const;

/**
 * Workers Paid Plan monthly allowances (for net cost calculation)
 * These are subtracted before calculating billable usage.
 */
export const PAID_ALLOWANCES = {
  d1: {
    rowsRead: 25_000_000_000, // 25 billion/month
    rowsWritten: 50_000_000, // 50 million/month
  },
  kv: {
    reads: 10_000_000, // 10 million/month
    writes: 1_000_000, // 1 million/month
    deletes: 1_000_000, // 1 million/month
    lists: 1_000_000, // 1 million/month
  },
  r2: {
    storage: 10_000_000_000, // 10 GB
    classA: 1_000_000, // 1 million/month
    classB: 10_000_000, // 10 million/month
  },
  durableObjects: {
    requests: 1_000_000, // 1 million/month (Workers Paid Plan)
    gbSeconds: 400_000, // 400K GB-seconds/month
  },
  vectorize: {
    storedDimensions: 10_000_000, // 10 million/month
    queriedDimensions: 50_000_000, // 50 million/month
  },
  queues: {
    operations: 1_000_000, // 1 million operations/month
  },
} as const;

// =============================================================================
// HOURLY COST CALCULATION
// =============================================================================

/**
 * Usage metrics for hourly cost calculation.
 * Represents a single hour's worth of resource consumption.
 */
export interface HourlyUsageMetrics {
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
  workersAINeurons?: number;
  queuesMessages?: number;
}

/**
 * Cost breakdown result for hourly snapshots.
 */
export interface HourlyCostBreakdown {
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

/**
 * Calculate costs for a single hour's usage metrics.
 *
 * IMPORTANT: This prorates the Workers base cost ($5/month) to ~$0.00685/hour
 * to avoid inflated cost estimates in hourly snapshots.
 *
 * For hourly breakdown:
 * - Base cost is prorated: $5 / 730 hours = ~$0.00685/hour
 * - Usage costs are calculated from actual hourly consumption
 * - Free tier allowances are prorated hourly
 *
 * @param usage - The hourly usage metrics
 * @returns Cost breakdown for the hour
 */
export function calculateHourlyCosts(usage: HourlyUsageMetrics): HourlyCostBreakdown {
  // Prorate base cost: $5/month / 730 hours
  const hourlyBaseCost = PRICING_TIERS.workers.baseCostMonthly / HOURS_PER_MONTH;

  // Prorate included requests: 10M/month / 730 hours
  const hourlyIncludedRequests = PRICING_TIERS.workers.includedRequests / HOURS_PER_MONTH;

  // Workers: prorated base cost + usage-based cost
  const overageRequests = Math.max(0, usage.workersRequests - hourlyIncludedRequests);
  const workersUsageCost =
    (overageRequests / 1_000_000) * PRICING_TIERS.workers.requestsPerMillion +
    (usage.workersCpuMs / 1_000_000) * PRICING_TIERS.workers.cpuMsPerMillion;
  const workersCost = hourlyBaseCost + workersUsageCost;

  // D1 — subtract prorated Workers Paid plan allowances (25B reads, 50M writes per month)
  const hourlyD1ReadsAllowance = PAID_ALLOWANCES.d1.rowsRead / HOURS_PER_MONTH;
  const hourlyD1WritesAllowance = PAID_ALLOWANCES.d1.rowsWritten / HOURS_PER_MONTH;
  const d1Cost =
    (Math.max(0, usage.d1Reads - hourlyD1ReadsAllowance) / 1_000_000_000) *
      PRICING_TIERS.d1.rowsReadPerBillion +
    (Math.max(0, usage.d1Writes - hourlyD1WritesAllowance) / 1_000_000) *
      PRICING_TIERS.d1.rowsWrittenPerMillion;

  // KV — subtract prorated allowances (10M reads, 1M writes, 1M deletes, 1M lists per month)
  const hourlyKvReadsAllowance = PAID_ALLOWANCES.kv.reads / HOURS_PER_MONTH;
  const hourlyKvWritesAllowance = PAID_ALLOWANCES.kv.writes / HOURS_PER_MONTH;
  const hourlyKvDeletesAllowance = PAID_ALLOWANCES.kv.deletes / HOURS_PER_MONTH;
  const hourlyKvListsAllowance = PAID_ALLOWANCES.kv.lists / HOURS_PER_MONTH;
  const kvCost =
    (Math.max(0, usage.kvReads - hourlyKvReadsAllowance) / 1_000_000) *
      PRICING_TIERS.kv.readsPerMillion +
    (Math.max(0, usage.kvWrites - hourlyKvWritesAllowance) / 1_000_000) *
      PRICING_TIERS.kv.writesPerMillion +
    (Math.max(0, (usage.kvDeletes ?? 0) - hourlyKvDeletesAllowance) / 1_000_000) *
      PRICING_TIERS.kv.deletesPerMillion +
    (Math.max(0, (usage.kvLists ?? 0) - hourlyKvListsAllowance) / 1_000_000) *
      PRICING_TIERS.kv.listsPerMillion;

  // R2 — subtract prorated allowances (1M Class A, 10M Class B per month)
  const hourlyR2ClassAAllowance = PAID_ALLOWANCES.r2.classA / HOURS_PER_MONTH;
  const hourlyR2ClassBAllowance = PAID_ALLOWANCES.r2.classB / HOURS_PER_MONTH;
  const r2Cost =
    (Math.max(0, usage.r2ClassA - hourlyR2ClassAAllowance) / 1_000_000) *
      PRICING_TIERS.r2.classAPerMillion +
    (Math.max(0, usage.r2ClassB - hourlyR2ClassBAllowance) / 1_000_000) *
      PRICING_TIERS.r2.classBPerMillion;

  // Vectorize — subtract prorated allowances (50M queried dimensions per month)
  const hourlyVectorizeAllowance = PAID_ALLOWANCES.vectorize.queriedDimensions / HOURS_PER_MONTH;
  const vectorizeCost =
    (Math.max(0, usage.vectorizeQueries - hourlyVectorizeAllowance) / 1_000_000) *
      PRICING_TIERS.vectorize.queriedDimensionsPerMillion;

  // AI Gateway (free)
  const aiGatewayCost = 0;

  // Durable Objects — subtract prorated allowances (1M requests, 400K GB-s per month)
  const hourlyDoRequestsAllowance = PAID_ALLOWANCES.durableObjects.requests / HOURS_PER_MONTH;
  const hourlyDoGbSecondsAllowance = PAID_ALLOWANCES.durableObjects.gbSeconds / HOURS_PER_MONTH;
  const durableObjectsCost =
    (Math.max(0, usage.durableObjectsRequests - hourlyDoRequestsAllowance) / 1_000_000) *
      PRICING_TIERS.durableObjects.requestsPerMillion +
    (Math.max(0, (usage.durableObjectsGbSeconds ?? 0) - hourlyDoGbSecondsAllowance) / 1_000_000) *
      PRICING_TIERS.durableObjects.gbSecondsPerMillion;

  // Workers AI (neurons-based)
  const neuronsPerUsd = PRICING_TIERS.workersAI.neuronsPerThousand / 1000;
  const workersAICost = (usage.workersAINeurons ?? 0) * neuronsPerUsd;

  // Queues
  const queuesCost =
    ((usage.queuesMessages ?? 0) / 1_000_000) * PRICING_TIERS.queues.messagesPerMillion;

  // Pages and Workflows (typically 0 for hourly granularity)
  const pagesCost = 0;
  const workflowsCost = 0;

  const total =
    workersCost +
    d1Cost +
    kvCost +
    r2Cost +
    vectorizeCost +
    aiGatewayCost +
    durableObjectsCost +
    workersAICost +
    queuesCost +
    pagesCost +
    workflowsCost;

  return {
    workers: workersCost,
    d1: d1Cost,
    kv: kvCost,
    r2: r2Cost,
    durableObjects: durableObjectsCost,
    vectorize: vectorizeCost,
    aiGateway: aiGatewayCost,
    workersAI: workersAICost,
    pages: pagesCost,
    queues: queuesCost,
    workflows: workflowsCost,
    total,
  };
}

/**
 * Calculate the prorated base cost for a given number of hours.
 * Useful for custom time period calculations.
 *
 * @param hours - Number of hours in the period
 * @returns Prorated base cost in USD
 */
export function prorateBaseCost(hours: number): number {
  return (PRICING_TIERS.workers.baseCostMonthly / HOURS_PER_MONTH) * hours;
}

/**
 * Calculate the prorated base cost for a given number of days.
 * Useful for daily rollup calculations.
 *
 * @param days - Number of days in the period
 * @returns Prorated base cost in USD
 */
export function prorateBaseCostByDays(days: number): number {
  return (PRICING_TIERS.workers.baseCostMonthly / DAYS_PER_MONTH) * days;
}

// =============================================================================
// DAILY BILLABLE COST CALCULATION
// =============================================================================

/**
 * Account-level daily usage metrics for billable cost calculation.
 * These are the raw usage values aggregated across all projects.
 * Named differently to avoid conflict with DailyUsageMetrics from dashboard.
 */
export interface AccountDailyUsage {
  workersRequests: number;
  workersCpuMs: number;
  d1RowsRead: number;
  d1RowsWritten: number;
  d1StorageBytes: number;
  kvReads: number;
  kvWrites: number;
  kvDeletes: number;
  kvLists: number;
  kvStorageBytes: number;
  r2ClassA: number;
  r2ClassB: number;
  r2StorageBytes: number;
  doRequests: number;
  doGbSeconds: number;
  doStorageReads: number;
  doStorageWrites: number;
  doStorageDeletes: number;
  vectorizeQueries: number;
  vectorizeStoredDimensions: number;
  aiGatewayRequests: number;
  workersAINeurons: number;
  queuesMessagesProduced: number;
  queuesMessagesConsumed: number;
  pagesDeployments: number;
  pagesBandwidthBytes: number;
  workflowsExecutions: number;
  workflowsCpuMs: number;
}

/**
 * Billable cost breakdown result for daily rollups.
 * All values are in USD after allowance subtraction.
 */
export interface DailyBillableCostBreakdown {
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

/**
 * Calculate actual billable costs for a daily period with proper allowance subtraction.
 *
 * Formula: billable_cost = max(0, usage - prorated_allowance) * rate
 *
 * This function applies the Workers Paid Plan allowances at account level,
 * meaning allowances are subtracted ONCE from total account usage,
 * not per-project.
 *
 * @param usage - The daily usage metrics (should be account-level totals)
 * @param daysElapsed - Days elapsed in current billing period (for proration)
 * @param daysInPeriod - Total days in billing period (typically 28-31)
 * @returns Billable cost breakdown with allowances applied
 *
 * @example
 * // Account used 2M D1 writes in 15 days of a 30-day month
 * // Monthly allowance: 50M writes, prorated: 25M writes
 * // Billable: max(0, 2M - 25M) * $1/M = $0 (under allowance)
 */
export function calculateDailyBillableCosts(
  usage: AccountDailyUsage,
  daysElapsed: number,
  daysInPeriod: number
): DailyBillableCostBreakdown {
  // Proration factor: how much of monthly allowance is available for this period
  const prorationFactor = daysInPeriod > 0 ? daysElapsed / daysInPeriod : 1;

  // Helper: calculate billable usage after prorated allowance
  const billableUsage = (usageValue: number, monthlyAllowance: number): number => {
    const proratedAllowance = monthlyAllowance * prorationFactor;
    return Math.max(0, usageValue - proratedAllowance);
  };

  // ==========================================================================
  // Workers: $5/month base + $0.30/million requests after 10M included
  // ==========================================================================
  // Prorate base cost for the billing period
  const workersBaseCost = (PRICING_TIERS.workers.baseCostMonthly / daysInPeriod) * daysElapsed;

  // Requests: subtract prorated 10M included
  const billableRequests = billableUsage(
    usage.workersRequests,
    PRICING_TIERS.workers.includedRequests
  );
  const workersRequestsCost =
    (billableRequests / 1_000_000) * PRICING_TIERS.workers.requestsPerMillion;

  // CPU time: no allowance, pure usage
  const workersCpuCost = (usage.workersCpuMs / 1_000_000) * PRICING_TIERS.workers.cpuMsPerMillion;

  const workersCost = workersBaseCost + workersRequestsCost + workersCpuCost;

  // ==========================================================================
  // D1: 25B reads + 50M writes included
  // ==========================================================================
  const billableD1Reads = billableUsage(usage.d1RowsRead, PAID_ALLOWANCES.d1.rowsRead);
  const billableD1Writes = billableUsage(usage.d1RowsWritten, PAID_ALLOWANCES.d1.rowsWritten);

  const d1Cost =
    (billableD1Reads / 1_000_000_000) * PRICING_TIERS.d1.rowsReadPerBillion +
    (billableD1Writes / 1_000_000) * PRICING_TIERS.d1.rowsWrittenPerMillion +
    (usage.d1StorageBytes / 1_000_000_000) * PRICING_TIERS.d1.storagePerGb;

  // ==========================================================================
  // KV: 10M reads, 1M writes/deletes/lists included
  // ==========================================================================
  const billableKvReads = billableUsage(usage.kvReads, PAID_ALLOWANCES.kv.reads);
  const billableKvWrites = billableUsage(usage.kvWrites, PAID_ALLOWANCES.kv.writes);
  const billableKvDeletes = billableUsage(usage.kvDeletes, PAID_ALLOWANCES.kv.deletes);
  const billableKvLists = billableUsage(usage.kvLists, PAID_ALLOWANCES.kv.lists);

  const kvCost =
    (billableKvReads / 1_000_000) * PRICING_TIERS.kv.readsPerMillion +
    (billableKvWrites / 1_000_000) * PRICING_TIERS.kv.writesPerMillion +
    (billableKvDeletes / 1_000_000) * PRICING_TIERS.kv.deletesPerMillion +
    (billableKvLists / 1_000_000) * PRICING_TIERS.kv.listsPerMillion +
    (usage.kvStorageBytes / 1_000_000_000) * PRICING_TIERS.kv.storagePerGb;

  // ==========================================================================
  // R2: 10GB storage, 1M Class A, 10M Class B included
  // ==========================================================================
  const billableR2ClassA = billableUsage(usage.r2ClassA, PAID_ALLOWANCES.r2.classA);
  const billableR2ClassB = billableUsage(usage.r2ClassB, PAID_ALLOWANCES.r2.classB);
  const billableR2Storage = billableUsage(usage.r2StorageBytes, PAID_ALLOWANCES.r2.storage);

  const r2Cost =
    (billableR2ClassA / 1_000_000) * PRICING_TIERS.r2.classAPerMillion +
    (billableR2ClassB / 1_000_000) * PRICING_TIERS.r2.classBPerMillion +
    (billableR2Storage / 1_000_000_000) * PRICING_TIERS.r2.storagePerGbMonth;

  // ==========================================================================
  // Durable Objects: 1M requests, 400K GB-seconds included
  // ==========================================================================
  const billableDoRequests = billableUsage(
    usage.doRequests,
    PAID_ALLOWANCES.durableObjects.requests
  );
  const billableDoGbSeconds = billableUsage(
    usage.doGbSeconds,
    PAID_ALLOWANCES.durableObjects.gbSeconds
  );

  const durableObjectsCost =
    (billableDoRequests / 1_000_000) * PRICING_TIERS.durableObjects.requestsPerMillion +
    (billableDoGbSeconds / 1_000_000) * PRICING_TIERS.durableObjects.gbSecondsPerMillion +
    (usage.doStorageReads / 1_000_000) * PRICING_TIERS.durableObjects.readsPerMillion +
    (usage.doStorageWrites / 1_000_000) * PRICING_TIERS.durableObjects.writesPerMillion +
    (usage.doStorageDeletes / 1_000_000) * PRICING_TIERS.durableObjects.deletesPerMillion;

  // ==========================================================================
  // Vectorize: 10M stored + 50M queried dimensions included
  // ==========================================================================
  const billableVectorizeStored = billableUsage(
    usage.vectorizeStoredDimensions,
    PAID_ALLOWANCES.vectorize.storedDimensions
  );
  const billableVectorizeQueried = billableUsage(
    usage.vectorizeQueries,
    PAID_ALLOWANCES.vectorize.queriedDimensions
  );

  const vectorizeCost =
    (billableVectorizeStored / 1_000_000) * PRICING_TIERS.vectorize.storedDimensionsPerMillion +
    (billableVectorizeQueried / 1_000_000) * PRICING_TIERS.vectorize.queriedDimensionsPerMillion;

  // ==========================================================================
  // AI Gateway: Free (logs only)
  // ==========================================================================
  const aiGatewayCost = 0;

  // ==========================================================================
  // Workers AI: No included allowance (conservative - pay per use)
  // ==========================================================================
  const neuronsPerUsd = PRICING_TIERS.workersAI.neuronsPerThousand / 1000;
  const workersAICost = usage.workersAINeurons * neuronsPerUsd;

  // ==========================================================================
  // Queues: 1M operations included
  // ==========================================================================
  const totalQueueMessages = usage.queuesMessagesProduced + usage.queuesMessagesConsumed;
  const billableQueueMessages = billableUsage(totalQueueMessages, PAID_ALLOWANCES.queues.operations);
  const queuesCost =
    (billableQueueMessages / 1_000_000) * PRICING_TIERS.queues.messagesPerMillion;

  // ==========================================================================
  // Pages: 500 builds free, 100GB bandwidth free
  // ==========================================================================
  // Note: We track builds and bandwidth but proration is complex
  // For now, assume under free tier (500 builds/month, 100GB bandwidth)
  const pagesCost = 0; // TODO: Implement pages cost if exceeding free tier

  // ==========================================================================
  // Workflows: Beta (no pricing yet)
  // ==========================================================================
  const workflowsCost = 0;

  // ==========================================================================
  // Total
  // ==========================================================================
  const total =
    workersCost +
    d1Cost +
    kvCost +
    r2Cost +
    durableObjectsCost +
    vectorizeCost +
    aiGatewayCost +
    workersAICost +
    queuesCost +
    pagesCost +
    workflowsCost;

  return {
    workers: Math.max(0, workersCost),
    d1: Math.max(0, d1Cost),
    kv: Math.max(0, kvCost),
    r2: Math.max(0, r2Cost),
    durableObjects: Math.max(0, durableObjectsCost),
    vectorize: Math.max(0, vectorizeCost),
    aiGateway: aiGatewayCost,
    workersAI: Math.max(0, workersAICost),
    pages: pagesCost,
    queues: Math.max(0, queuesCost),
    workflows: workflowsCost,
    total: Math.max(0, total),
  };
}
