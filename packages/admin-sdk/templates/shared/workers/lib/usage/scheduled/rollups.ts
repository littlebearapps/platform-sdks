/**
 * Scheduled Rollup Functions
 *
 * Functions for aggregating usage data from hourly snapshots into daily and monthly rollups.
 * These run during the scheduled cron job at midnight UTC.
 *
 * Reference: backlog/tasks/task-61 - Platform-Usage-Refactoring.md
 */

import type { Env } from '../shared';
import { generateId, fetchBillingSettings } from '../shared';
import { createLoggerFromEnv } from '@littlebearapps/platform-consumer-sdk';
import { calculateBillingPeriod, type BillingPeriod } from '../../billing';
import { calculateDailyBillableCosts, type AccountDailyUsage } from '@littlebearapps/platform-consumer-sdk';
import { getDailyUsageFromAnalyticsEngine } from '../../analytics-engine';

// =============================================================================
// PRICING VERSION CACHING
// =============================================================================

// In-memory cache for current pricing version ID (per-request lifetime)
let cachedPricingVersionId: number | null = null;

/**
 * Get the current pricing version ID from D1.
 * Returns the ID of the pricing version with NULL effective_to (current pricing).
 * Caches result in-memory for the duration of the request.
 *
 * @param env - Worker environment with D1 binding
 * @returns Pricing version ID, or null if no versioned pricing exists
 */
async function getCurrentPricingVersionId(env: Env): Promise<number | null> {
  // Return cached value if already loaded this request
  if (cachedPricingVersionId !== null) {
    return cachedPricingVersionId;
  }

  try {
    const result = await env.PLATFORM_DB.prepare(
      `SELECT id FROM pricing_versions WHERE effective_to IS NULL ORDER BY effective_from DESC LIMIT 1`
    ).first<{ id: number }>();

    cachedPricingVersionId = result?.id ?? null;

    // Pricing version ID loaded (may be null if no versioned pricing)
    return cachedPricingVersionId;
  } catch {
    // Table may not exist yet (pre-migration)
    return null;
  }
}

/**
 * Reset cached pricing version ID (call at start of each request if needed).
 */
export function resetPricingVersionCache(): void {
  cachedPricingVersionId = null;
}

// =============================================================================
// CACHE INVALIDATION
// =============================================================================

/**
 * Invalidate daily usage cache keys in KV.
 * Called at midnight to ensure fresh data for the new day.
 *
 * @returns Number of cache keys deleted
 */
export async function invalidateDailyCache(env: Env): Promise<number> {
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:cache');
  log.info('Invalidating daily usage cache keys', { tag: 'CACHE' });
  let deletedCount = 0;

  try {
    // List all keys with 'daily:' prefix
    const listResult = await env.PLATFORM_CACHE.list({ prefix: 'daily:' });

    if (listResult.keys.length === 0) {
      log.info('No daily cache keys to invalidate', { tag: 'CACHE' });
      return 0;
    }

    // Delete each matching key
    for (const key of listResult.keys) {
      try {
        await env.PLATFORM_CACHE.delete(key.name);
        deletedCount++;
      } catch (error) {
        log.error(
          `Failed to delete key ${key.name}`,
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }

    log.info(`Invalidated ${deletedCount} daily cache keys`, { tag: 'CACHE' });
  } catch (error) {
    log.error(
      'Failed to list/invalidate daily cache',
      error instanceof Error ? error : new Error(String(error))
    );
  }

  return deletedCount;
}

// =============================================================================
// DAILY ROLLUP
// =============================================================================

/**
 * Run daily rollup: aggregate hourly snapshots into daily_usage_rollups.
 * Called at midnight UTC.
 *
 * IMPORTANT: Cost columns store cumulative MTD (month-to-date) values.
 * Daily cost = today's end-of-day MTD - previous day's end-of-day MTD.
 *
 * For the first day of the month, previous day is in a different month,
 * so we use today's MTD value directly (it represents the full first day).
 *
 * @param env - Worker environment
 * @param date - Date to run rollup for (YYYY-MM-DD)
 * @returns Number of rows changed
 */
export async function runDailyRollup(env: Env, date: string): Promise<number> {
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:scheduled');
  log.info(`Running daily rollup for ${date}`, { tag: 'SCHEDULED' });

  // Calculate the previous day's date
  const targetDate = new Date(date + 'T00:00:00Z');
  const prevDate = new Date(targetDate);
  prevDate.setUTCDate(prevDate.getUTCDate() - 1);
  const prevDateStr = prevDate.toISOString().split('T')[0];

  // Check if this is the first day of the month
  const isFirstDayOfMonth = targetDate.getUTCDate() === 1;

  // Get current pricing version ID for audit trail
  const pricingVersionId = await getCurrentPricingVersionId(env);

  // Fetch billing settings for billing-aware calculations
  const billingSettings = await fetchBillingSettings(env);
  const billingPeriod = calculateBillingPeriod(billingSettings.billingCycleDay, targetDate);
  log.info(
    `Period: ${billingPeriod.startDate.toISOString().split('T')[0]} to ` +
      `${billingPeriod.endDate.toISOString().split('T')[0]}, ` +
      `${billingPeriod.daysElapsed}/${billingPeriod.daysInPeriod} days elapsed (${Math.round(billingPeriod.progress * 100)}%)`,
    { tag: 'BILLING' }
  );

  // Get today's MAX values (end-of-day MTD totals) for each project
  interface HourlyMaxRow {
    project: string;
    workers_requests: number;
    workers_errors: number;
    workers_cpu_time_ms: number;
    workers_duration_p50_ms_avg: number;
    workers_duration_p99_ms_max: number;
    workers_cost_usd: number;
    d1_rows_read: number;
    d1_rows_written: number;
    d1_storage_bytes_max: number;
    d1_cost_usd: number;
    kv_reads: number;
    kv_writes: number;
    kv_deletes: number;
    kv_list_ops: number;
    kv_storage_bytes_max: number;
    kv_cost_usd: number;
    r2_class_a_ops: number;
    r2_class_b_ops: number;
    r2_storage_bytes_max: number;
    r2_egress_bytes: number;
    r2_cost_usd: number;
    do_requests: number;
    do_gb_seconds: number;
    do_websocket_connections: number;
    do_storage_reads: number;
    do_storage_writes: number;
    do_storage_deletes: number;
    do_cost_usd: number;
    vectorize_queries: number;
    vectorize_vectors_stored_max: number;
    vectorize_cost_usd: number;
    aigateway_requests: number;
    aigateway_tokens_in: number;
    aigateway_tokens_out: number;
    aigateway_cached_requests: number;
    aigateway_cost_usd: number;
    pages_deployments: number;
    pages_bandwidth_bytes: number;
    pages_cost_usd: number;
    queues_messages_produced: number;
    queues_messages_consumed: number;
    queues_cost_usd: number;
    workersai_requests: number;
    workersai_neurons: number;
    workersai_cost_usd: number;
    workflows_executions: number;
    workflows_successes: number;
    workflows_failures: number;
    workflows_wall_time_ms: number;
    workflows_cpu_time_ms: number;
    workflows_cost_usd: number;
    total_cost_usd: number;
    samples_count: number;
  }

  // REGRESSION CHECK: D1 rows MUST use SUM() not MAX()
  // Bug fix (2026-01-24): Using MAX() caused 825M read counts when actual was ~65K.
  // The hourly_usage_snapshots table stores operational counts per hour.
  // Daily rollups must SUM these hourly values, not take the MAX single-hour peak.
  const todayResult = await env.PLATFORM_DB.prepare(
    `
    SELECT
      project,
      SUM(workers_requests) as workers_requests,
      SUM(workers_errors) as workers_errors,
      SUM(workers_cpu_time_ms) as workers_cpu_time_ms,
      AVG(workers_duration_p50_ms) as workers_duration_p50_ms_avg,
      MAX(workers_duration_p99_ms) as workers_duration_p99_ms_max,
      MAX(workers_cost_usd) as workers_cost_usd,
      SUM(d1_rows_read) as d1_rows_read,        -- MUST be SUM, not MAX (regression check)
      SUM(d1_rows_written) as d1_rows_written,  -- MUST be SUM, not MAX (regression check)
      MAX(d1_storage_bytes) as d1_storage_bytes_max,
      MAX(d1_cost_usd) as d1_cost_usd,
      SUM(kv_reads) as kv_reads,
      SUM(kv_writes) as kv_writes,
      SUM(kv_deletes) as kv_deletes,
      SUM(kv_list_ops) as kv_list_ops,
      MAX(kv_storage_bytes) as kv_storage_bytes_max,
      MAX(kv_cost_usd) as kv_cost_usd,
      SUM(r2_class_a_ops) as r2_class_a_ops,
      SUM(r2_class_b_ops) as r2_class_b_ops,
      MAX(r2_storage_bytes) as r2_storage_bytes_max,
      SUM(r2_egress_bytes) as r2_egress_bytes,
      MAX(r2_cost_usd) as r2_cost_usd,
      SUM(do_requests) as do_requests,
      MAX(COALESCE(do_gb_seconds, 0)) as do_gb_seconds,
      SUM(do_websocket_connections) as do_websocket_connections,
      SUM(do_storage_reads) as do_storage_reads,
      SUM(do_storage_writes) as do_storage_writes,
      SUM(do_storage_deletes) as do_storage_deletes,
      MAX(do_cost_usd) as do_cost_usd,
      SUM(vectorize_queries) as vectorize_queries,
      MAX(vectorize_vectors_stored) as vectorize_vectors_stored_max,
      MAX(vectorize_cost_usd) as vectorize_cost_usd,
      SUM(aigateway_requests) as aigateway_requests,
      SUM(aigateway_tokens_in) as aigateway_tokens_in,
      SUM(aigateway_tokens_out) as aigateway_tokens_out,
      SUM(aigateway_cached_requests) as aigateway_cached_requests,
      MAX(aigateway_cost_usd) as aigateway_cost_usd,
      SUM(pages_deployments) as pages_deployments,
      SUM(pages_bandwidth_bytes) as pages_bandwidth_bytes,
      MAX(pages_cost_usd) as pages_cost_usd,
      SUM(queues_messages_produced) as queues_messages_produced,
      SUM(queues_messages_consumed) as queues_messages_consumed,
      MAX(queues_cost_usd) as queues_cost_usd,
      SUM(workersai_requests) as workersai_requests,
      SUM(workersai_neurons) as workersai_neurons,
      MAX(workersai_cost_usd) as workersai_cost_usd,
      SUM(COALESCE(workflows_executions, 0)) as workflows_executions,
      SUM(COALESCE(workflows_successes, 0)) as workflows_successes,
      SUM(COALESCE(workflows_failures, 0)) as workflows_failures,
      SUM(COALESCE(workflows_wall_time_ms, 0)) as workflows_wall_time_ms,
      SUM(COALESCE(workflows_cpu_time_ms, 0)) as workflows_cpu_time_ms,
      MAX(COALESCE(workflows_cost_usd, 0)) as workflows_cost_usd,
      MAX(total_cost_usd) as total_cost_usd,
      COUNT(*) as samples_count
    FROM hourly_usage_snapshots
    WHERE DATE(snapshot_hour) = ?
    GROUP BY project
    `
  )
    .bind(date)
    .all<HourlyMaxRow>();

  if (!todayResult.results || todayResult.results.length === 0) {
    log.info(`No hourly data found for ${date}`, { tag: 'SCHEDULED' });
    return 0;
  }

  // Get previous day's MAX values (only needed if not first day of month)
  interface PrevDayMaxRow {
    project: string;
    workers_cost_usd: number;
    d1_rows_read: number;
    d1_rows_written: number;
    d1_cost_usd: number;
    kv_cost_usd: number;
    r2_cost_usd: number;
    do_cost_usd: number;
    vectorize_cost_usd: number;
    aigateway_cost_usd: number;
    pages_cost_usd: number;
    queues_cost_usd: number;
    workersai_cost_usd: number;
    workflows_cost_usd: number;
    total_cost_usd: number;
  }

  const prevDayMaxByProject: Map<string, PrevDayMaxRow> = new Map();

  if (!isFirstDayOfMonth) {
    // Previous day's aggregation for MTD calculation
    // D1 rows use SUM (see regression check comment above)
    const prevResult = await env.PLATFORM_DB.prepare(
      `
      SELECT
        project,
        MAX(workers_cost_usd) as workers_cost_usd,
        SUM(d1_rows_read) as d1_rows_read,        -- MUST be SUM, not MAX
        SUM(d1_rows_written) as d1_rows_written,  -- MUST be SUM, not MAX
        MAX(d1_cost_usd) as d1_cost_usd,
        MAX(kv_cost_usd) as kv_cost_usd,
        MAX(r2_cost_usd) as r2_cost_usd,
        MAX(do_cost_usd) as do_cost_usd,
        MAX(vectorize_cost_usd) as vectorize_cost_usd,
        MAX(aigateway_cost_usd) as aigateway_cost_usd,
        MAX(pages_cost_usd) as pages_cost_usd,
        MAX(queues_cost_usd) as queues_cost_usd,
        MAX(workersai_cost_usd) as workersai_cost_usd,
        MAX(COALESCE(workflows_cost_usd, 0)) as workflows_cost_usd,
        MAX(total_cost_usd) as total_cost_usd
      FROM hourly_usage_snapshots
      WHERE DATE(snapshot_hour) = ?
      GROUP BY project
      `
    )
      .bind(prevDateStr)
      .all<PrevDayMaxRow>();

    if (prevResult.results) {
      for (const row of prevResult.results) {
        prevDayMaxByProject.set(row.project, row);
      }
    }
  }

  // ============================================================================
  // ACCOUNT-LEVEL BILLABLE COST CALCULATION
  // ============================================================================
  // Calculate actual billable costs at account level BEFORE storing per-project.
  // This ensures D1 daily_usage_rollups is the "Source of Truth" with accurate
  // billable amounts that match Cloudflare invoices.
  //
  // Formula: billable_cost = max(0, account_usage - prorated_allowance) * rate
  // ============================================================================

  // Step 1: Aggregate all project usage to account level
  const accountUsage: AccountDailyUsage = {
    workersRequests: 0,
    workersCpuMs: 0,
    d1RowsRead: 0,
    d1RowsWritten: 0,
    d1StorageBytes: 0,
    kvReads: 0,
    kvWrites: 0,
    kvDeletes: 0,
    kvLists: 0,
    kvStorageBytes: 0,
    r2ClassA: 0,
    r2ClassB: 0,
    r2StorageBytes: 0,
    doRequests: 0,
    doGbSeconds: 0,
    doStorageReads: 0,
    doStorageWrites: 0,
    doStorageDeletes: 0,
    vectorizeQueries: 0,
    vectorizeStoredDimensions: 0,
    aiGatewayRequests: 0,
    workersAINeurons: 0,
    queuesMessagesProduced: 0,
    queuesMessagesConsumed: 0,
    pagesDeployments: 0,
    pagesBandwidthBytes: 0,
    workflowsExecutions: 0,
    workflowsCpuMs: 0,
  };

  // Track raw costs for proportional distribution
  const projectRawCosts = new Map<
    string,
    {
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
  >();

  let totalRawCost = 0;

  for (const row of todayResult.results) {
    // Calculate daily deltas for this project
    const prev = prevDayMaxByProject.get(row.project);

    // Raw cost deltas (before allowance subtraction)
    const rawWorkersCost =
      isFirstDayOfMonth || !prev
        ? row.workers_cost_usd
        : Math.max(0, row.workers_cost_usd - prev.workers_cost_usd);
    const rawD1Cost =
      isFirstDayOfMonth || !prev
        ? row.d1_cost_usd
        : Math.max(0, row.d1_cost_usd - prev.d1_cost_usd);
    const rawKvCost =
      isFirstDayOfMonth || !prev
        ? row.kv_cost_usd
        : Math.max(0, row.kv_cost_usd - prev.kv_cost_usd);
    const rawR2Cost =
      isFirstDayOfMonth || !prev
        ? row.r2_cost_usd
        : Math.max(0, row.r2_cost_usd - prev.r2_cost_usd);
    const rawDoCost =
      isFirstDayOfMonth || !prev
        ? row.do_cost_usd
        : Math.max(0, row.do_cost_usd - prev.do_cost_usd);
    const rawVectorizeCost =
      isFirstDayOfMonth || !prev
        ? row.vectorize_cost_usd
        : Math.max(0, row.vectorize_cost_usd - prev.vectorize_cost_usd);
    const rawAiGatewayCost =
      isFirstDayOfMonth || !prev
        ? row.aigateway_cost_usd
        : Math.max(0, row.aigateway_cost_usd - prev.aigateway_cost_usd);
    const rawWorkersAICost =
      isFirstDayOfMonth || !prev
        ? row.workersai_cost_usd
        : Math.max(0, row.workersai_cost_usd - prev.workersai_cost_usd);
    const rawPagesCost =
      isFirstDayOfMonth || !prev
        ? row.pages_cost_usd
        : Math.max(0, row.pages_cost_usd - prev.pages_cost_usd);
    const rawQueuesCost =
      isFirstDayOfMonth || !prev
        ? row.queues_cost_usd
        : Math.max(0, row.queues_cost_usd - prev.queues_cost_usd);
    const rawWorkflowsCost =
      isFirstDayOfMonth || !prev
        ? row.workflows_cost_usd
        : Math.max(0, row.workflows_cost_usd - prev.workflows_cost_usd);
    const rawTotalCost =
      rawWorkersCost +
      rawD1Cost +
      rawKvCost +
      rawR2Cost +
      rawDoCost +
      rawVectorizeCost +
      rawAiGatewayCost +
      rawWorkersAICost +
      rawPagesCost +
      rawQueuesCost +
      rawWorkflowsCost;

    projectRawCosts.set(row.project, {
      workers: rawWorkersCost,
      d1: rawD1Cost,
      kv: rawKvCost,
      r2: rawR2Cost,
      durableObjects: rawDoCost,
      vectorize: rawVectorizeCost,
      aiGateway: rawAiGatewayCost,
      workersAI: rawWorkersAICost,
      pages: rawPagesCost,
      queues: rawQueuesCost,
      workflows: rawWorkflowsCost,
      total: rawTotalCost,
    });

    totalRawCost += rawTotalCost;

    // Aggregate MTD usage to account level (for billable cost calculation)
    accountUsage.workersRequests += row.workers_requests || 0;
    accountUsage.workersCpuMs += row.workers_cpu_time_ms || 0;
    accountUsage.d1RowsRead += row.d1_rows_read || 0;
    accountUsage.d1RowsWritten += row.d1_rows_written || 0;
    accountUsage.d1StorageBytes += row.d1_storage_bytes_max || 0;
    accountUsage.kvReads += row.kv_reads || 0;
    accountUsage.kvWrites += row.kv_writes || 0;
    accountUsage.kvDeletes += row.kv_deletes || 0;
    accountUsage.kvLists += row.kv_list_ops || 0;
    accountUsage.kvStorageBytes += row.kv_storage_bytes_max || 0;
    accountUsage.r2ClassA += row.r2_class_a_ops || 0;
    accountUsage.r2ClassB += row.r2_class_b_ops || 0;
    accountUsage.r2StorageBytes += row.r2_storage_bytes_max || 0;
    accountUsage.doRequests += row.do_requests || 0;
    accountUsage.doGbSeconds += row.do_gb_seconds || 0;
    accountUsage.doStorageReads += row.do_storage_reads || 0;
    accountUsage.doStorageWrites += row.do_storage_writes || 0;
    accountUsage.doStorageDeletes += row.do_storage_deletes || 0;
    accountUsage.vectorizeQueries += row.vectorize_queries || 0;
    accountUsage.vectorizeStoredDimensions += row.vectorize_vectors_stored_max || 0;
    accountUsage.aiGatewayRequests += row.aigateway_requests || 0;
    accountUsage.workersAINeurons += row.workersai_neurons || 0;
    accountUsage.queuesMessagesProduced += row.queues_messages_produced || 0;
    accountUsage.queuesMessagesConsumed += row.queues_messages_consumed || 0;
    accountUsage.pagesDeployments += row.pages_deployments || 0;
    accountUsage.pagesBandwidthBytes += row.pages_bandwidth_bytes || 0;
    accountUsage.workflowsExecutions += row.workflows_executions || 0;
    accountUsage.workflowsCpuMs += row.workflows_cpu_time_ms || 0;
  }

  // Step 2: Calculate account-level billable costs with proper allowance subtraction
  const accountBillableCosts = calculateDailyBillableCosts(
    accountUsage,
    billingPeriod.daysElapsed,
    billingPeriod.daysInPeriod
  );

  // Log account-level billable costs
  log.info(
    `Account billable costs (day ${billingPeriod.daysElapsed}/${billingPeriod.daysInPeriod}): ` +
      `rawTotal=$${totalRawCost.toFixed(4)}, billableTotal=$${accountBillableCosts.total.toFixed(4)}, ` +
      `workers=$${accountBillableCosts.workers.toFixed(4)}, d1=$${accountBillableCosts.d1.toFixed(4)}, ` +
      `kv=$${accountBillableCosts.kv.toFixed(4)}, do=$${accountBillableCosts.durableObjects.toFixed(4)}`,
    { tag: 'BILLING' }
  );

  // Step 3: Calculate proportional distribution factor
  // Each project gets: (projectRawCost / totalRawCost) * accountBillableCost
  // This ensures the sum of project billable costs equals account billable cost
  const costScaleFactor = totalRawCost > 0 ? accountBillableCosts.total / totalRawCost : 0;

  log.info(
    `Cost scale factor: ${costScaleFactor.toFixed(4)} ` +
      `(billable $${accountBillableCosts.total.toFixed(4)} / raw $${totalRawCost.toFixed(4)})`,
    { tag: 'BILLING' }
  );

  // Insert daily rollup with BILLABLE costs (proportionally distributed)
  let totalChanges = 0;

  for (const today of todayResult.results) {
    const prev = prevDayMaxByProject.get(today.project);
    const rawCosts = projectRawCosts.get(today.project)!;

    // D1 rows are cumulative MTD, need delta calculation
    const d1RowsReadDelta =
      isFirstDayOfMonth || !prev
        ? today.d1_rows_read
        : Math.max(0, today.d1_rows_read - prev.d1_rows_read);
    const d1RowsWrittenDelta =
      isFirstDayOfMonth || !prev
        ? today.d1_rows_written
        : Math.max(0, today.d1_rows_written - prev.d1_rows_written);

    // ========================================================================
    // BILLABLE COSTS (Proportionally distributed from account-level)
    // ========================================================================
    // Each project's billable cost = rawCost * costScaleFactor
    // This ensures: sum(projectBillableCost) == accountBillableCost
    // The costScaleFactor adjusts for allowances at account level
    // ========================================================================
    const workersCostBillable = rawCosts.workers * costScaleFactor;
    const d1CostBillable = rawCosts.d1 * costScaleFactor;
    const kvCostBillable = rawCosts.kv * costScaleFactor;
    const r2CostBillable = rawCosts.r2 * costScaleFactor;
    const doCostBillable = rawCosts.durableObjects * costScaleFactor;
    const vectorizeCostBillable = rawCosts.vectorize * costScaleFactor;
    const aigatewayCostBillable = rawCosts.aiGateway * costScaleFactor;
    const pagesCostBillable = rawCosts.pages * costScaleFactor;
    const queuesCostBillable = rawCosts.queues * costScaleFactor;
    const workersaiCostBillable = rawCosts.workersAI * costScaleFactor;
    const workflowsCostBillable = rawCosts.workflows * costScaleFactor;
    const totalCostBillable = rawCosts.total * costScaleFactor;

    log.info(
      `Rollup ${date} project=${today.project}: ` +
        `rawCost=$${rawCosts.total.toFixed(4)}, ` +
        `billableCost=$${totalCostBillable.toFixed(4)}, ` +
        `scaleFactor=${costScaleFactor.toFixed(4)}, ` +
        `d1WritesDaily=${d1RowsWrittenDelta.toLocaleString()}`,
      { tag: 'SCHEDULED' }
    );

    const result = await env.PLATFORM_DB.prepare(
      `
      INSERT INTO daily_usage_rollups (
        snapshot_date, project,
        workers_requests, workers_errors, workers_cpu_time_ms,
        workers_duration_p50_ms_avg, workers_duration_p99_ms_max, workers_cost_usd,
        d1_rows_read, d1_rows_written, d1_storage_bytes_max, d1_cost_usd,
        kv_reads, kv_writes, kv_deletes, kv_list_ops, kv_storage_bytes_max, kv_cost_usd,
        r2_class_a_ops, r2_class_b_ops, r2_storage_bytes_max, r2_egress_bytes, r2_cost_usd,
        do_requests, do_gb_seconds, do_websocket_connections, do_storage_reads, do_storage_writes, do_storage_deletes, do_cost_usd,
        vectorize_queries, vectorize_vectors_stored_max, vectorize_cost_usd,
        aigateway_requests, aigateway_tokens_in, aigateway_tokens_out, aigateway_cached_requests, aigateway_cost_usd,
        pages_deployments, pages_bandwidth_bytes, pages_cost_usd,
        queues_messages_produced, queues_messages_consumed, queues_cost_usd,
        workersai_requests, workersai_neurons, workersai_cost_usd,
        workflows_executions, workflows_successes, workflows_failures, workflows_wall_time_ms, workflows_cpu_time_ms, workflows_cost_usd,
        total_cost_usd, samples_count, rollup_version, pricing_version_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?)
      ON CONFLICT (snapshot_date, project) DO UPDATE SET
        workers_requests = excluded.workers_requests,
        workers_errors = excluded.workers_errors,
        workers_cpu_time_ms = excluded.workers_cpu_time_ms,
        workers_duration_p50_ms_avg = excluded.workers_duration_p50_ms_avg,
        workers_duration_p99_ms_max = excluded.workers_duration_p99_ms_max,
        workers_cost_usd = excluded.workers_cost_usd,
        d1_rows_read = excluded.d1_rows_read,
        d1_rows_written = excluded.d1_rows_written,
        d1_storage_bytes_max = excluded.d1_storage_bytes_max,
        d1_cost_usd = excluded.d1_cost_usd,
        kv_reads = excluded.kv_reads,
        kv_writes = excluded.kv_writes,
        kv_deletes = excluded.kv_deletes,
        kv_list_ops = excluded.kv_list_ops,
        kv_storage_bytes_max = excluded.kv_storage_bytes_max,
        kv_cost_usd = excluded.kv_cost_usd,
        r2_class_a_ops = excluded.r2_class_a_ops,
        r2_class_b_ops = excluded.r2_class_b_ops,
        r2_storage_bytes_max = excluded.r2_storage_bytes_max,
        r2_egress_bytes = excluded.r2_egress_bytes,
        r2_cost_usd = excluded.r2_cost_usd,
        do_requests = excluded.do_requests,
        do_gb_seconds = excluded.do_gb_seconds,
        do_websocket_connections = excluded.do_websocket_connections,
        do_storage_reads = excluded.do_storage_reads,
        do_storage_writes = excluded.do_storage_writes,
        do_storage_deletes = excluded.do_storage_deletes,
        do_cost_usd = excluded.do_cost_usd,
        vectorize_queries = excluded.vectorize_queries,
        vectorize_vectors_stored_max = excluded.vectorize_vectors_stored_max,
        vectorize_cost_usd = excluded.vectorize_cost_usd,
        aigateway_requests = excluded.aigateway_requests,
        aigateway_tokens_in = excluded.aigateway_tokens_in,
        aigateway_tokens_out = excluded.aigateway_tokens_out,
        aigateway_cached_requests = excluded.aigateway_cached_requests,
        aigateway_cost_usd = excluded.aigateway_cost_usd,
        pages_deployments = excluded.pages_deployments,
        pages_bandwidth_bytes = excluded.pages_bandwidth_bytes,
        pages_cost_usd = excluded.pages_cost_usd,
        queues_messages_produced = excluded.queues_messages_produced,
        queues_messages_consumed = excluded.queues_messages_consumed,
        queues_cost_usd = excluded.queues_cost_usd,
        workersai_requests = excluded.workersai_requests,
        workersai_neurons = excluded.workersai_neurons,
        workersai_cost_usd = excluded.workersai_cost_usd,
        workflows_executions = excluded.workflows_executions,
        workflows_successes = excluded.workflows_successes,
        workflows_failures = excluded.workflows_failures,
        workflows_wall_time_ms = excluded.workflows_wall_time_ms,
        workflows_cpu_time_ms = excluded.workflows_cpu_time_ms,
        workflows_cost_usd = excluded.workflows_cost_usd,
        total_cost_usd = excluded.total_cost_usd,
        samples_count = excluded.samples_count,
        rollup_version = excluded.rollup_version,
        pricing_version_id = excluded.pricing_version_id
      `
    )
      .bind(
        date,
        today.project,
        today.workers_requests,
        today.workers_errors,
        today.workers_cpu_time_ms,
        today.workers_duration_p50_ms_avg,
        today.workers_duration_p99_ms_max,
        workersCostBillable, // BILLABLE cost (account-level allowance applied)
        d1RowsReadDelta,
        d1RowsWrittenDelta,
        today.d1_storage_bytes_max,
        d1CostBillable, // BILLABLE cost
        today.kv_reads,
        today.kv_writes,
        today.kv_deletes,
        today.kv_list_ops,
        today.kv_storage_bytes_max,
        kvCostBillable, // BILLABLE cost
        today.r2_class_a_ops,
        today.r2_class_b_ops,
        today.r2_storage_bytes_max,
        today.r2_egress_bytes,
        r2CostBillable, // BILLABLE cost
        today.do_requests,
        today.do_gb_seconds,
        today.do_websocket_connections,
        today.do_storage_reads,
        today.do_storage_writes,
        today.do_storage_deletes,
        doCostBillable, // BILLABLE cost
        today.vectorize_queries,
        today.vectorize_vectors_stored_max,
        vectorizeCostBillable, // BILLABLE cost
        today.aigateway_requests,
        today.aigateway_tokens_in,
        today.aigateway_tokens_out,
        today.aigateway_cached_requests,
        aigatewayCostBillable, // BILLABLE cost (always 0 - free tier)
        today.pages_deployments,
        today.pages_bandwidth_bytes,
        pagesCostBillable, // BILLABLE cost
        today.queues_messages_produced,
        today.queues_messages_consumed,
        queuesCostBillable, // BILLABLE cost
        today.workersai_requests,
        today.workersai_neurons,
        workersaiCostBillable, // BILLABLE cost
        today.workflows_executions,
        today.workflows_successes,
        today.workflows_failures,
        today.workflows_wall_time_ms,
        today.workflows_cpu_time_ms,
        workflowsCostBillable, // BILLABLE cost (always 0 - beta)
        totalCostBillable, // BILLABLE total cost
        today.samples_count,
        pricingVersionId
      )
      .run();

    totalChanges += result.meta.changes || 0;
  }

  // ============================================================================
  // BILLING SUMMARY
  // ============================================================================
  // D1 daily_usage_rollups is now the "Source of Truth" for billable costs.
  // Costs stored in *_cost_usd columns are ACTUAL BILLABLE amounts after:
  //   1. Account-level allowance subtraction (PAID_ALLOWANCES in workers/lib/costs.ts)
  //   2. Proportional distribution to projects (fair share based on raw cost proportion)
  //
  // Formula: projectBillableCost = projectRawCost * (accountBillableCost / accountRawCost)
  //
  // Pricing logic lives in:
  //   - workers/lib/costs.ts (calculateDailyBillableCosts, PRICING_TIERS, PAID_ALLOWANCES)
  //   - workers/lib/billing.ts (calculateBillingPeriod, proration utilities)
  // ============================================================================

  // Log overage warning if account is over allowance
  if (accountBillableCosts.total > 0 && costScaleFactor > 0) {
    log.warn(
      `Account exceeds free tier: ` +
        `billable=$${accountBillableCosts.total.toFixed(4)} ` +
        `(workers=$${accountBillableCosts.workers.toFixed(4)}, ` +
        `d1=$${accountBillableCosts.d1.toFixed(4)}, ` +
        `kv=$${accountBillableCosts.kv.toFixed(4)}, ` +
        `do=$${accountBillableCosts.durableObjects.toFixed(4)})`,
      undefined,
      { tag: 'BILLING' }
    );
  } else {
    log.info(
      `Account within free tier allowances ` +
        `(day ${billingPeriod.daysElapsed}/${billingPeriod.daysInPeriod})`,
      { tag: 'BILLING' }
    );
  }

  log.info(
    `Daily rollup complete: ${totalChanges} rows, billable=$${accountBillableCosts.total.toFixed(4)}`,
    { tag: 'SCHEDULED' }
  );
  return totalChanges;
}

// =============================================================================
// FEATURE USAGE DAILY ROLLUP
// =============================================================================

/**
 * Run feature-level daily rollup from Analytics Engine.
 * Aggregates SDK telemetry from PLATFORM_ANALYTICS dataset into feature_usage_daily table.
 * Called at midnight UTC for yesterday's data.
 *
 * This is the new "data tiering" approach where:
 * - High-resolution telemetry is stored in Analytics Engine (SDK telemetry via queue)
 * - Daily aggregates are stored in D1 (feature_usage_daily) for historical queries
 *
 * @param env - Worker environment
 * @param date - Date to run rollup for (YYYY-MM-DD)
 * @returns Number of rows inserted/updated
 */
export async function runFeatureUsageDailyRollup(env: Env, date: string): Promise<number> {
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:scheduled');
  log.info(`Running feature usage daily rollup for ${date}`, { tag: 'SCHEDULED' });

  try {
    // Query Analytics Engine for yesterday's SDK telemetry
    const aggregations = await getDailyUsageFromAnalyticsEngine(
      env.CLOUDFLARE_ACCOUNT_ID,
      env.CLOUDFLARE_API_TOKEN,
      'platform-analytics'
    );

    if (aggregations.length === 0) {
      log.info(`No SDK telemetry found in Analytics Engine for ${date}`, { tag: 'SCHEDULED' });
      return 0;
    }

    log.info(`Found ${aggregations.length} feature aggregations from Analytics Engine`, {
      tag: 'SCHEDULED',
    });

    let totalChanges = 0;

    for (const agg of aggregations) {
      // Insert or update feature_usage_daily
      const result = await env.PLATFORM_DB.prepare(
        `
        INSERT INTO feature_usage_daily (
          id, feature_key, usage_date,
          d1_writes, d1_reads, kv_reads, kv_writes,
          ai_neurons, requests
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (feature_key, usage_date) DO UPDATE SET
          d1_writes = excluded.d1_writes,
          d1_reads = excluded.d1_reads,
          kv_reads = excluded.kv_reads,
          kv_writes = excluded.kv_writes,
          ai_neurons = excluded.ai_neurons,
          requests = excluded.requests
        `
      )
        .bind(
          generateId(),
          agg.feature_id,
          date,
          agg.d1_writes + agg.d1_rows_written, // Combine write operations
          agg.d1_reads + agg.d1_rows_read, // Combine read operations
          agg.kv_reads,
          agg.kv_writes + agg.kv_deletes + agg.kv_lists, // Combine write-like operations
          agg.ai_neurons,
          agg.interaction_count // Total telemetry events as requests
        )
        .run();

      totalChanges += result.meta.changes || 0;
    }

    log.info('Feature usage daily rollup complete', {
      tag: 'FEATURE_ROLLUP_COMPLETE',
      totalChanges,
      featureCount: aggregations.length,
    });
    return totalChanges;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('Feature usage daily rollup failed', error instanceof Error ? error : undefined, {
      tag: 'FEATURE_ROLLUP_ERROR',
      errorMessage,
    });
    // Don't throw - this is a non-critical operation
    return 0;
  }
}

// =============================================================================
// MONTHLY ROLLUP
// =============================================================================

/**
 * Run monthly rollup: aggregate daily rollups into monthly_usage_rollups.
 * Called on the 1st of each month for the previous month.
 *
 * @param env - Worker environment
 * @param month - Month to run rollup for (YYYY-MM)
 * @returns Number of rows changed
 */
export async function runMonthlyRollup(env: Env, month: string): Promise<number> {
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:scheduled');
  log.info('Running monthly rollup', { tag: 'MONTHLY_ROLLUP_START', month });

  const result = await env.PLATFORM_DB.prepare(
    `
    INSERT INTO monthly_usage_rollups (
      snapshot_month, project,
      workers_requests, workers_errors, workers_cost_usd,
      d1_rows_read, d1_rows_written, d1_cost_usd,
      kv_reads, kv_writes, kv_cost_usd,
      r2_class_a_ops, r2_class_b_ops, r2_egress_bytes, r2_cost_usd,
      do_requests, do_gb_seconds, do_cost_usd,
      aigateway_requests, aigateway_tokens_total, aigateway_cost_usd,
      workersai_requests, workersai_neurons, workersai_cost_usd,
      workflows_executions, workflows_failures, workflows_cpu_time_ms, workflows_cost_usd,
      total_cost_usd, days_count, pricing_version_id
    )
    SELECT
      SUBSTR(snapshot_date, 1, 7) as snapshot_month,
      project,
      SUM(workers_requests), SUM(workers_errors), SUM(workers_cost_usd),
      SUM(d1_rows_read), SUM(d1_rows_written), SUM(d1_cost_usd),
      SUM(kv_reads), SUM(kv_writes), SUM(kv_cost_usd),
      SUM(r2_class_a_ops), SUM(r2_class_b_ops), SUM(r2_egress_bytes), SUM(r2_cost_usd),
      SUM(do_requests), SUM(COALESCE(do_gb_seconds, 0)), SUM(do_cost_usd),
      SUM(aigateway_requests), SUM(aigateway_tokens_in + aigateway_tokens_out), SUM(aigateway_cost_usd),
      SUM(workersai_requests), SUM(workersai_neurons), SUM(workersai_cost_usd),
      SUM(COALESCE(workflows_executions, 0)), SUM(COALESCE(workflows_failures, 0)),
      SUM(COALESCE(workflows_cpu_time_ms, 0)), SUM(COALESCE(workflows_cost_usd, 0)),
      SUM(total_cost_usd), COUNT(DISTINCT snapshot_date),
      MAX(pricing_version_id)  -- Use most recent pricing version from daily rollups
    FROM daily_usage_rollups
    WHERE SUBSTR(snapshot_date, 1, 7) = ?
    GROUP BY SUBSTR(snapshot_date, 1, 7), project
    ON CONFLICT (snapshot_month, project) DO UPDATE SET
      workers_requests = excluded.workers_requests,
      workers_errors = excluded.workers_errors,
      workflows_executions = excluded.workflows_executions,
      workflows_failures = excluded.workflows_failures,
      workflows_cpu_time_ms = excluded.workflows_cpu_time_ms,
      workflows_cost_usd = excluded.workflows_cost_usd,
      total_cost_usd = excluded.total_cost_usd,
      days_count = excluded.days_count,
      pricing_version_id = excluded.pricing_version_id
  `
  )
    .bind(month)
    .run();

  log.info('Monthly rollup complete', {
    tag: 'MONTHLY_ROLLUP_COMPLETE',
    rowsChanged: result.meta.changes,
    month,
  });
  return result.meta.changes || 0;
}

// =============================================================================
// DATA CLEANUP
// =============================================================================

/**
 * Clean up old data based on retention policies.
 * - Hourly: 7 days
 * - Daily: 90 days
 * - Monthly: forever (no cleanup)
 *
 * @param env - Worker environment
 * @returns Number of rows deleted by type
 */
export async function cleanupOldData(
  env: Env
): Promise<{ hourlyDeleted: number; dailyDeleted: number }> {
  // Delete hourly snapshots older than 7 days
  const hourlyResult = await env.PLATFORM_DB.prepare(
    `
    DELETE FROM hourly_usage_snapshots
    WHERE snapshot_hour < datetime('now', '-7 days')
  `
  ).run();

  // Delete daily rollups older than 90 days
  const dailyResult = await env.PLATFORM_DB.prepare(
    `
    DELETE FROM daily_usage_rollups
    WHERE snapshot_date < date('now', '-90 days')
  `
  ).run();

  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:scheduled');
  log.info('Cleanup complete', {
    tag: 'CLEANUP_COMPLETE',
    hourlyDeleted: hourlyResult.meta.changes,
    dailyDeleted: dailyResult.meta.changes,
  });

  return {
    hourlyDeleted: hourlyResult.meta.changes || 0,
    dailyDeleted: dailyResult.meta.changes || 0,
  };
}

// =============================================================================
// USAGE VS ALLOWANCE PERCENTAGES
// =============================================================================

/**
 * Calculate and persist usage vs allowance percentages.
 * Computes month-to-date usage / monthly allowance * 100 for Cloudflare resources.
 * Stores as new resource_type entries (e.g., workers_requests_usage_pct).
 *
 * @param env - Worker environment
 * @param date - Date (YYYY-MM-DD) for the calculation
 * @returns Number of D1 writes performed
 */
export async function calculateUsageVsAllowancePercentages(
  env: Env,
  date: string
): Promise<number> {
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:allowance');
  log.info('Calculating usage vs allowance percentages', { date });

  // Get current month (YYYY-MM)
  const currentMonth = date.slice(0, 7);

  // Mapping of usage metrics to their inclusion counterparts
  const usageToInclusionMap: Array<{
    usageColumn: string;
    inclusionType: string;
    pctType: string;
  }> = [
    {
      usageColumn: 'workers_requests',
      inclusionType: 'workers_requests_included',
      pctType: 'workers_requests_usage_pct',
    },
    {
      usageColumn: 'd1_rows_read',
      inclusionType: 'd1_rows_read_included',
      pctType: 'd1_rows_read_usage_pct',
    },
    {
      usageColumn: 'd1_rows_written',
      inclusionType: 'd1_rows_written_included',
      pctType: 'd1_rows_written_usage_pct',
    },
    {
      usageColumn: 'kv_reads',
      inclusionType: 'kv_reads_included',
      pctType: 'kv_reads_usage_pct',
    },
    {
      usageColumn: 'kv_writes',
      inclusionType: 'kv_writes_included',
      pctType: 'kv_writes_usage_pct',
    },
    {
      usageColumn: 'r2_class_a_ops',
      inclusionType: 'r2_class_a_included',
      pctType: 'r2_class_a_usage_pct',
    },
    {
      usageColumn: 'r2_class_b_ops',
      inclusionType: 'r2_class_b_included',
      pctType: 'r2_class_b_usage_pct',
    },
    {
      usageColumn: 'do_requests',
      inclusionType: 'do_requests_included',
      pctType: 'do_requests_usage_pct',
    },
    {
      usageColumn: 'workersai_neurons',
      inclusionType: 'workers_ai_neurons_included',
      pctType: 'workers_ai_neurons_usage_pct',
    },
  ];

  let d1Writes = 0;

  // Get month-to-date usage totals from daily_usage_rollups (sum across all projects)
  const mtdUsageResult = await env.PLATFORM_DB.prepare(
    `
    SELECT
      SUM(workers_requests) as workers_requests,
      SUM(d1_rows_read) as d1_rows_read,
      SUM(d1_rows_written) as d1_rows_written,
      SUM(kv_reads) as kv_reads,
      SUM(kv_writes) as kv_writes,
      SUM(r2_class_a_ops) as r2_class_a_ops,
      SUM(r2_class_b_ops) as r2_class_b_ops,
      SUM(do_requests) as do_requests,
      SUM(workersai_neurons) as workersai_neurons
    FROM daily_usage_rollups
    WHERE snapshot_date LIKE ? || '%'
  `
  )
    .bind(currentMonth)
    .first<Record<string, number | null>>();

  if (!mtdUsageResult) {
    log.info('No usage data found for month', { month: currentMonth });
    return 0;
  }

  // Get inclusions from third_party_usage (latest for Cloudflare)
  const inclusionsResult = await env.PLATFORM_DB.prepare(
    `
    SELECT resource_type, usage_value
    FROM third_party_usage
    WHERE provider = 'cloudflare'
      AND resource_type LIKE '%_included'
      AND snapshot_date = (
        SELECT MAX(snapshot_date) FROM third_party_usage
        WHERE provider = 'cloudflare' AND resource_type LIKE '%_included'
      )
  `
  ).all<{ resource_type: string; usage_value: number }>();

  if (!inclusionsResult.results || inclusionsResult.results.length === 0) {
    log.info('No inclusions data found for Cloudflare');
    return 0;
  }

  // Create a map of inclusion types to values
  const inclusionsMap = new Map<string, number>();
  for (const row of inclusionsResult.results) {
    inclusionsMap.set(row.resource_type, row.usage_value);
  }

  // Calculate and persist percentages
  for (const mapping of usageToInclusionMap) {
    const usage = mtdUsageResult[mapping.usageColumn] || 0;
    const inclusion = inclusionsMap.get(mapping.inclusionType);

    if (inclusion === undefined || inclusion === 0) {
      // Skip if no inclusion value (avoid division by zero)
      continue;
    }

    const percentage = (usage / inclusion) * 100;

    await persistThirdPartyUsage(
      env,
      date,
      'cloudflare',
      mapping.pctType,
      Math.round(percentage * 100) / 100, // Round to 2 decimal places
      'percent',
      0
    );
    d1Writes++;
  }

  // GitHub Actions: get MTD minutes and compare to included
  const githubMtdResult = await env.PLATFORM_DB.prepare(
    `
    SELECT SUM(usage_value) as mtd_minutes
    FROM third_party_usage
    WHERE provider = 'github'
      AND resource_type = 'actions_minutes'
      AND snapshot_date LIKE ? || '%'
  `
  )
    .bind(currentMonth)
    .first<{ mtd_minutes: number | null }>();

  // Get GitHub inclusions separately
  const githubInclusionsResult = await env.PLATFORM_DB.prepare(
    `
    SELECT resource_type, usage_value
    FROM third_party_usage
    WHERE provider = 'github'
      AND resource_type LIKE '%_included'
      AND snapshot_date = (
        SELECT MAX(snapshot_date) FROM third_party_usage
        WHERE provider = 'github' AND resource_type LIKE '%_included'
      )
  `
  ).all<{ resource_type: string; usage_value: number }>();

  if (
    githubMtdResult?.mtd_minutes &&
    githubInclusionsResult.results &&
    githubInclusionsResult.results.length > 0
  ) {
    const actionsIncluded = githubInclusionsResult.results.find(
      (r) => r.resource_type === 'actions_minutes_included'
    );
    if (actionsIncluded && actionsIncluded.usage_value > 0) {
      const pct = (githubMtdResult.mtd_minutes / actionsIncluded.usage_value) * 100;
      await persistThirdPartyUsage(
        env,
        date,
        'github',
        'actions_minutes_usage_pct',
        Math.round(pct * 100) / 100,
        'percent',
        0
      );
      d1Writes++;
    }
  }

  log.info('Calculated usage vs allowance percentages', { d1Writes });
  return d1Writes;
}

/**
 * Persist third-party usage data (GitHub billing, etc.).
 */
async function persistThirdPartyUsage(
  env: Env,
  date: string,
  provider: string,
  resourceType: string,
  usageValue: number,
  usageUnit: string,
  costUsd: number = 0,
  resourceName?: string
): Promise<void> {
  await env.PLATFORM_DB.prepare(
    `
    INSERT INTO third_party_usage (
      id, snapshot_date, provider, resource_type, resource_name,
      usage_value, usage_unit, cost_usd, collection_timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (snapshot_date, provider, resource_type, COALESCE(resource_name, ''))
    DO UPDATE SET
      usage_value = excluded.usage_value,
      cost_usd = excluded.cost_usd,
      collection_timestamp = excluded.collection_timestamp
  `
  )
    .bind(
      generateId(),
      date,
      provider,
      resourceType,
      resourceName || '',
      usageValue,
      usageUnit,
      costUsd,
      Math.floor(Date.now() / 1000)
    )
    .run();
}

// =============================================================================
// AI MODEL BREAKDOWN PERSISTENCE
// =============================================================================

/**
 * Persist Workers AI model breakdown data to D1.
 * Stores per-project, per-model usage for historical analysis.
 *
 * @param env - Worker environment
 * @param snapshotHour - Hour of the snapshot (ISO format)
 * @param metrics - Array of model usage metrics
 * @returns Number of D1 writes performed
 */
export async function persistWorkersAIModelBreakdown(
  env: Env,
  snapshotHour: string,
  metrics: Array<{
    project: string;
    model: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    isEstimated: boolean;
  }>
): Promise<number> {
  let writes = 0;
  for (const m of metrics) {
    await env.PLATFORM_DB.prepare(
      `
      INSERT INTO workersai_model_usage (
        id, snapshot_hour, project, model, requests,
        input_tokens, output_tokens, cost_usd, is_estimated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (snapshot_hour, project, model) DO UPDATE SET
        requests = excluded.requests,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cost_usd = excluded.cost_usd,
        is_estimated = excluded.is_estimated
    `
    )
      .bind(
        generateId(),
        snapshotHour,
        m.project,
        m.model,
        m.requests,
        m.inputTokens,
        m.outputTokens,
        m.costUsd,
        m.isEstimated ? 1 : 0
      )
      .run();
    writes++;
  }
  return writes;
}

/**
 * Persist AI Gateway model breakdown data to D1.
 * Stores per-gateway, per-provider, per-model usage for historical analysis.
 *
 * @param env - Worker environment
 * @param snapshotHour - Hour of the snapshot (ISO format)
 * @param gatewayId - AI Gateway ID
 * @param models - Array of model usage metrics
 * @returns Number of D1 writes performed
 */
export async function persistAIGatewayModelBreakdown(
  env: Env,
  snapshotHour: string,
  gatewayId: string,
  models: Array<{
    provider: string;
    model: string;
    requests: number;
    cachedRequests: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
  }>
): Promise<number> {
  let writes = 0;
  for (const m of models) {
    await env.PLATFORM_DB.prepare(
      `
      INSERT INTO aigateway_model_usage (
        id, snapshot_hour, gateway_id, provider, model,
        requests, cached_requests, tokens_in, tokens_out, cost_usd
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (snapshot_hour, gateway_id, provider, model) DO UPDATE SET
        requests = excluded.requests,
        cached_requests = excluded.cached_requests,
        tokens_in = excluded.tokens_in,
        tokens_out = excluded.tokens_out,
        cost_usd = excluded.cost_usd
    `
    )
      .bind(
        generateId(),
        snapshotHour,
        gatewayId,
        m.provider,
        m.model,
        m.requests,
        m.cachedRequests,
        m.tokensIn,
        m.tokensOut,
        m.costUsd
      )
      .run();
    writes++;
  }
  return writes;
}

/**
 * Persist feature-level AI model usage to D1.
 * Called from queue consumer when telemetry includes aiModelBreakdown.
 * Uses upsert to aggregate invocations for the same feature/model/date.
 *
 * @param env - Worker environment
 * @param featureKey - Feature key (project:category:feature)
 * @param modelBreakdown - Map of model name to invocation count
 * @param timestamp - Timestamp of the telemetry
 * @returns Number of D1 writes performed
 */
export async function persistFeatureAIModelUsage(
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
// AI MODEL DAILY ROLLUPS
// =============================================================================

/**
 * Run daily rollup for Workers AI model usage.
 * Aggregates hourly data into daily totals.
 *
 * @param env - Worker environment
 * @param date - Date to run rollup for (YYYY-MM-DD)
 * @returns Number of rows changed
 */
export async function runWorkersAIModelDailyRollup(env: Env, date: string): Promise<number> {
  const startHour = `${date}T00:00:00Z`;
  const endHour = `${date}T23:59:59Z`;

  const result = await env.PLATFORM_DB.prepare(
    `
    INSERT INTO workersai_model_daily (
      snapshot_date, project, model, requests, input_tokens, output_tokens, cost_usd, samples_count
    )
    SELECT
      ? as snapshot_date,
      project,
      model,
      COALESCE(SUM(requests), 0),
      COALESCE(SUM(input_tokens), 0),
      COALESCE(SUM(output_tokens), 0),
      COALESCE(SUM(cost_usd), 0),
      COUNT(*)
    FROM workersai_model_usage
    WHERE snapshot_hour >= ? AND snapshot_hour <= ?
    GROUP BY project, model
    ON CONFLICT (snapshot_date, project, model) DO UPDATE SET
      requests = excluded.requests,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cost_usd = excluded.cost_usd,
      samples_count = excluded.samples_count
  `
  )
    .bind(date, startHour, endHour)
    .run();

  return result.meta.changes || 0;
}

/**
 * Run daily rollup for AI Gateway model usage.
 * Aggregates hourly data into daily totals.
 *
 * @param env - Worker environment
 * @param date - Date to run rollup for (YYYY-MM-DD)
 * @returns Number of rows changed
 */
export async function runAIGatewayModelDailyRollup(env: Env, date: string): Promise<number> {
  const startHour = `${date}T00:00:00Z`;
  const endHour = `${date}T23:59:59Z`;

  const result = await env.PLATFORM_DB.prepare(
    `
    INSERT INTO aigateway_model_daily (
      snapshot_date, gateway_id, provider, model, requests, cached_requests, tokens_in, tokens_out, cost_usd, samples_count
    )
    SELECT
      ? as snapshot_date,
      gateway_id,
      provider,
      model,
      COALESCE(SUM(requests), 0),
      COALESCE(SUM(cached_requests), 0),
      COALESCE(SUM(tokens_in), 0),
      COALESCE(SUM(tokens_out), 0),
      COALESCE(SUM(cost_usd), 0),
      COUNT(*)
    FROM aigateway_model_usage
    WHERE snapshot_hour >= ? AND snapshot_hour <= ?
    GROUP BY gateway_id, provider, model
    ON CONFLICT (snapshot_date, gateway_id, provider, model) DO UPDATE SET
      requests = excluded.requests,
      cached_requests = excluded.cached_requests,
      tokens_in = excluded.tokens_in,
      tokens_out = excluded.tokens_out,
      cost_usd = excluded.cost_usd,
      samples_count = excluded.samples_count
  `
  )
    .bind(date, startHour, endHour)
    .run();

  return result.meta.changes || 0;
}

// =============================================================================
// GAP-FILLING: Self-healing daily rollups from hourly data
// =============================================================================

/**
 * Finds gaps in daily_usage_rollups where storage metrics are 0 but hourly data exists.
 * Re-runs runDailyRollup for those days to fix the data.
 *
 * This is a self-healing mechanism that runs at midnight after the regular daily rollup.
 * It addresses the scenario where the backfill script overwrote good data with incomplete data.
 *
 * Limits to MAX_DAYS_PER_RUN days per cron run to stay within CPU budget.
 *
 * @param env - Worker environment
 * @returns Number of days fixed
 */
export async function backfillMissingDays(env: Env): Promise<number> {
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:gap-fill');
  const MAX_DAYS_PER_RUN = 3; // Stay within CPU budget
  const LOOKBACK_DAYS = 30; // Check last 30 days

  log.info('Starting gap detection', { lookbackDays: LOOKBACK_DAYS });

  // Find days where daily_usage_rollups has 0 storage but hourly_usage_snapshots has data
  // This indicates the backfill script overwrote good rollup data with incomplete data
  interface GapRow {
    snapshot_date: string;
    daily_storage: number | null;
    hourly_storage: number | null;
  }

  const gapQuery = await env.PLATFORM_DB.prepare(
    `
    WITH daily_storage AS (
      SELECT snapshot_date, MAX(d1_storage_bytes_max) as storage
      FROM daily_usage_rollups
      WHERE project = 'all'
        AND snapshot_date >= date('now', '-${LOOKBACK_DAYS} days')
      GROUP BY snapshot_date
    ),
    hourly_storage AS (
      SELECT DATE(snapshot_hour) as snapshot_date, MAX(d1_storage_bytes) as storage
      FROM hourly_usage_snapshots
      WHERE project = 'all'
        AND snapshot_hour >= datetime('now', '-${LOOKBACK_DAYS} days')
      GROUP BY DATE(snapshot_hour)
    )
    SELECT
      h.snapshot_date,
      d.storage as daily_storage,
      h.storage as hourly_storage
    FROM hourly_storage h
    LEFT JOIN daily_storage d ON h.snapshot_date = d.snapshot_date
    WHERE (d.storage IS NULL OR d.storage = 0)
      AND h.storage > 0
    ORDER BY h.snapshot_date DESC
    LIMIT ?
    `
  )
    .bind(MAX_DAYS_PER_RUN)
    .all<GapRow>();

  if (!gapQuery.results || gapQuery.results.length === 0) {
    log.info('No gaps found - all daily rollups have correct storage data');
    return 0;
  }

  log.info('Found days needing fix', { count: gapQuery.results.length });

  let fixedCount = 0;
  for (const gap of gapQuery.results) {
    log.info('Fixing gap', {
      date: gap.snapshot_date,
      dailyStorage: gap.daily_storage ?? 0,
      hourlyStorage: gap.hourly_storage,
    });
    try {
      await runDailyRollup(env, gap.snapshot_date);
      fixedCount++;
      log.info('Fixed gap', { date: gap.snapshot_date });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`Error fixing ${gap.snapshot_date}: ${errorMsg}`);
    }
  }

  log.info('Gap-fill complete', { fixed: fixedCount, total: gapQuery.results.length });
  return fixedCount;
}
