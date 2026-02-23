/**
 * Scheduled Data Collection Module
 *
 * Extracted from platform-usage.ts for the scheduled cron job.
 * Contains functions for collecting and persisting usage data from
 * Cloudflare GraphQL, GitHub billing, and third-party providers.
 *
 * Reference: backlog/tasks/task-62 - Platform-Usage-Migration-Subtasks.md (Phase C.1)
 */

import type {
  Env,
  MetricDeltas,
  SamplingMode,
  PlatformPricing,
  GitHubUsageItem,
  GitHubPlanInfo,
  GitHubBillingData,
  GitHubPlanInclusions,
  AnthropicUsageData,
  OpenAIUsageData,
  ResendUsageData,
  ApifyUsageData,
  AccountUsage,
  CostBreakdown,
  QueuesMetrics,
} from '../shared';
import { SamplingMode as SamplingModeEnum } from '../shared';
import { generateId, loadPricing, fetchWithRetry } from '../shared';
import { createLoggerFromEnv } from '@littlebearapps/platform-consumer-sdk';
import { identifyProject } from '../../shared/cloudflare';

// =============================================================================
// HOURLY SNAPSHOT PERSISTENCE
// =============================================================================

/**
 * Persist hourly usage snapshot to D1.
 *
 * Stores account-level or project-level usage metrics for a single hour.
 * Uses delta values when provided for accurate hourly totals (counters),
 * or raw values for gauges (storage metrics).
 *
 * @param env - Worker environment
 * @param snapshotHour - ISO datetime string (YYYY-MM-DDTHH:00:00Z)
 * @param project - Project identifier ('all', or from project_registry)
 * @param data - AccountUsage from GraphQL
 * @param costs - Cost breakdown from calculateMonthlyCosts
 * @param samplingMode - Current sampling mode
 * @param workflows - Optional workflow metrics
 * @param aiMetrics - Optional AI metrics (Workers AI, Vectorize)
 * @param queues - Optional queue metrics
 * @param deltas - Optional delta values for accurate hourly metrics
 * @returns Number of D1 writes (always 1)
 */
export async function persistHourlySnapshot(
  env: Env,
  snapshotHour: string,
  project: string,
  data: AccountUsage,
  costs: CostBreakdown,
  samplingMode: SamplingMode,
  workflows?: {
    executions: number;
    successes: number;
    failures: number;
    wallTimeMs: number;
    cpuTimeMs: number;
  },
  aiMetrics?: {
    workersAINeurons: number;
    workersAIRequests: number;
    vectorizeQueries: number;
    vectorizeVectorsQueried: number;
  },
  queues?: {
    messagesProduced: number;
    messagesConsumed: number;
  },
  deltas?: MetricDeltas
): Promise<number> {
  const id = generateId();
  const timestamp = Math.floor(Date.now() / 1000);

  // ==========================================================================
  // METRICS EXTRACTION: Use delta values when provided, else raw cumulative
  // Counters (requests, reads, writes) use deltas; gauges (storage) use raw
  // ==========================================================================

  // Get Workers metrics (data.workers is WorkersMetrics[])
  // Use delta values for counters if provided (for accurate hourly totals)
  const workersRequests =
    deltas?.workers?.requests ?? data.workers.reduce((sum, w) => sum + w.requests, 0);
  const workersErrors =
    deltas?.workers?.errors ?? data.workers.reduce((sum, w) => sum + w.errors, 0);
  const workersCpuTime =
    deltas?.workers?.cpuTimeMs ?? data.workers.reduce((sum, w) => sum + w.cpuTimeMs, 0);
  // Duration percentiles are point-in-time metrics, not cumulative - use raw values
  const workersDurationP50 =
    data.workers.length > 0
      ? data.workers.reduce((sum, w) => sum + w.duration50thMs, 0) / data.workers.length
      : 0;
  const workersDurationP99 =
    data.workers.length > 0 ? Math.max(...data.workers.map((w) => w.duration99thMs)) : 0;

  // Get D1 metrics (data.d1 is D1Metrics[])
  // Rows read/written are counters (use delta), storage is gauge (use raw)
  const d1RowsRead = deltas?.d1?.rowsRead ?? data.d1.reduce((sum, d) => sum + d.rowsRead, 0);
  const d1RowsWritten =
    deltas?.d1?.rowsWritten ?? data.d1.reduce((sum, d) => sum + d.rowsWritten, 0);
  const d1StorageBytes = data.d1.reduce((sum, d) => sum + (d.storageBytes ?? 0), 0); // Gauge - raw

  // Get KV metrics (data.kv is KVMetrics[])
  // Operations are counters (use delta), storage is gauge (use raw)
  const kvReads = deltas?.kv?.reads ?? data.kv.reduce((sum, k) => sum + k.reads, 0);
  const kvWrites = deltas?.kv?.writes ?? data.kv.reduce((sum, k) => sum + k.writes, 0);
  const kvDeletes = deltas?.kv?.deletes ?? data.kv.reduce((sum, k) => sum + k.deletes, 0);
  const kvListOps = deltas?.kv?.lists ?? data.kv.reduce((sum, k) => sum + k.lists, 0);
  const kvStorageBytes = data.kv.reduce((sum, k) => sum + (k.storageBytes ?? 0), 0); // Gauge - raw

  // Get R2 metrics (data.r2 is R2Metrics[])
  // Operations and egress are counters (use delta), storage is gauge (use raw)
  const r2ClassAOps =
    deltas?.r2?.classAOps ?? data.r2.reduce((sum, r) => sum + r.classAOperations, 0);
  const r2ClassBOps =
    deltas?.r2?.classBOps ?? data.r2.reduce((sum, r) => sum + r.classBOperations, 0);
  const r2StorageBytes = data.r2.reduce((sum, r) => sum + r.storageBytes, 0); // Gauge - raw
  const r2EgressBytes =
    deltas?.r2?.egressBytes ?? data.r2.reduce((sum, r) => sum + r.egressBytes, 0);

  // Get Durable Objects metrics (data.durableObjects is DOMetrics - single object, not array)
  // Requests, gbSeconds, and storage operations are counters (use delta)
  // Storage bytes is a gauge (use raw)
  const doRequests = deltas?.do?.requests ?? data.durableObjects.requests;
  const doGbSeconds = deltas?.do?.gbSeconds ?? data.durableObjects.gbSeconds;
  const doWsConnections = 0; // Not in DOMetrics interface
  const doStorageReads = deltas?.do?.storageReadUnits ?? data.durableObjects.storageReadUnits;
  const doStorageWrites = deltas?.do?.storageWriteUnits ?? data.durableObjects.storageWriteUnits;
  const doStorageDeletes = deltas?.do?.storageDeleteUnits ?? data.durableObjects.storageDeleteUnits;
  const doStorageBytes = data.durableObjects.storageBytes; // Gauge - raw (GB-months billing)

  // Get Vectorize metrics (data.vectorize is VectorizeInfo[] from REST, aiMetrics from GraphQL)
  // Queries are counters (use delta), stored dimensions is a gauge (use raw)
  const vectorizeQueries = deltas?.vectorize?.queries ?? aiMetrics?.vectorizeQueries ?? 0;
  // IMPORTANT: For billing, Cloudflare charges per stored dimension (vectorCount * dimensions per index)
  // We store total stored dimensions in vectorize_vectors_stored, and set vectorize_dimensions to 1
  // This ensures correct billing calculations: total_stored_dimensions * 1 = total_stored_dimensions
  // vectorizeVectorsStored is a gauge (current storage), not a counter
  const vectorizeVectorsStored = data.vectorize.reduce(
    (sum, v) => sum + v.vectorCount * v.dimensions,
    0
  );
  const vectorizeDimensions = 1; // Multiplier is 1 since vectorizeVectorsStored now holds total stored dimensions

  // Get AI Gateway metrics (data.aiGateway is AIGatewayMetrics[])
  // All AI Gateway metrics are counters (use delta)
  const aigRequests =
    deltas?.aiGateway?.requests ?? data.aiGateway.reduce((sum, a) => sum + a.totalRequests, 0);
  const aigTokensIn = deltas?.aiGateway?.tokensIn ?? 0; // Tokens in not available separately
  const aigTokensOut =
    deltas?.aiGateway?.tokensOut ?? data.aiGateway.reduce((sum, a) => sum + a.totalTokens, 0);
  const aigCached =
    deltas?.aiGateway?.cached ?? data.aiGateway.reduce((sum, a) => sum + a.cachedRequests, 0);

  // Get Pages metrics (data.pages is PagesMetrics[] - deployments only, no request/bandwidth data)
  // Deployments are all-time counts (use delta for hourly change)
  const pagesDeployments =
    deltas?.pages?.deployments ?? data.pages.reduce((sum, p) => sum + p.totalBuilds, 0);
  const pagesBandwidth = deltas?.pages?.bandwidthBytes ?? 0;

  // Queues metrics (from GraphQL queueConsumerMetricsAdaptiveGroups + queueMessageOperationsAdaptiveGroups)
  // Message counts are counters (use delta)
  const queuesProduced = deltas?.queues?.produced ?? queues?.messagesProduced ?? 0;
  const queuesConsumed = deltas?.queues?.consumed ?? queues?.messagesConsumed ?? 0;

  // Workers AI metrics now come from GraphQL (aiInferenceAdaptive dataset)
  // Requests and neurons are counters (use delta)
  const workersAIRequests = deltas?.workersAI?.requests ?? aiMetrics?.workersAIRequests ?? 0;
  const workersAINeurons = deltas?.workersAI?.neurons ?? aiMetrics?.workersAINeurons ?? 0;
  // Calculate Workers AI cost from neurons if not provided in costs (costs.workersAI is always 0 from calculateMonthlyCosts)
  // Load pricing from KV (with fallback to defaults) - pricing is cached per-request
  const pricing = await loadPricing(env);
  const neuronsPerUsd = pricing.workersAI.neuronsPerThousand / 1000; // $0.011 per 1000 = $0.000011 per neuron
  const workersAICost = costs.workersAI > 0 ? costs.workersAI : workersAINeurons * neuronsPerUsd;
  const persistLog = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:persist');
  persistLog.info(
    `WorkersAI: neurons=${workersAINeurons}, costs.workersAI=${costs.workersAI}, calculatedCost=${workersAICost}`,
    { tag: 'PERSIST' }
  );

  // Calculate total cost now that workersAICost is defined
  const totalCost =
    costs.workers +
    costs.d1 +
    costs.kv +
    costs.r2 +
    costs.durableObjects +
    costs.vectorize +
    costs.aiGateway +
    costs.pages +
    costs.queues +
    workersAICost;

  // Get Workflows metrics (passed in separately as not part of AccountUsage)
  // All workflow metrics are counters (use delta)
  const workflowsExecutions = deltas?.workflows?.executions ?? workflows?.executions ?? 0;
  const workflowsSuccesses = deltas?.workflows?.successes ?? workflows?.successes ?? 0;
  const workflowsFailures = deltas?.workflows?.failures ?? workflows?.failures ?? 0;
  const workflowsWallTimeMs = deltas?.workflows?.wallTimeMs ?? workflows?.wallTimeMs ?? 0;
  const workflowsCpuTimeMs = deltas?.workflows?.cpuTimeMs ?? workflows?.cpuTimeMs ?? 0;

  const samplingModeStr =
    [
      'FULL',
      'HALF',
      '',
      '',
      'QUARTER',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      'MINIMAL',
    ][samplingMode] || 'FULL';

  await env.PLATFORM_DB.prepare(
    `
    INSERT INTO hourly_usage_snapshots (
      id, snapshot_hour, project,
      workers_requests, workers_errors, workers_cpu_time_ms,
      workers_duration_p50_ms, workers_duration_p99_ms, workers_cost_usd,
      d1_rows_read, d1_rows_written, d1_storage_bytes, d1_cost_usd,
      kv_reads, kv_writes, kv_deletes, kv_list_ops, kv_storage_bytes, kv_cost_usd,
      r2_class_a_ops, r2_class_b_ops, r2_storage_bytes, r2_egress_bytes, r2_cost_usd,
      do_requests, do_gb_seconds, do_websocket_connections, do_storage_reads, do_storage_writes, do_storage_deletes, do_storage_bytes, do_cost_usd,
      vectorize_queries, vectorize_vectors_stored, vectorize_dimensions, vectorize_cost_usd,
      aigateway_requests, aigateway_tokens_in, aigateway_tokens_out, aigateway_cached_requests, aigateway_cost_usd,
      pages_deployments, pages_bandwidth_bytes, pages_cost_usd,
      queues_messages_produced, queues_messages_consumed, queues_cost_usd,
      workersai_requests, workersai_neurons, workersai_cost_usd,
      workflows_executions, workflows_successes, workflows_failures, workflows_wall_time_ms, workflows_cpu_time_ms, workflows_cost_usd,
      total_cost_usd, collection_timestamp, sampling_mode
    ) VALUES (
      ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?
    )
    ON CONFLICT (snapshot_hour, project) DO NOTHING
  `
  )
    .bind(
      id,
      snapshotHour,
      project,
      workersRequests,
      workersErrors,
      workersCpuTime,
      workersDurationP50,
      workersDurationP99,
      costs.workers,
      d1RowsRead,
      d1RowsWritten,
      d1StorageBytes,
      costs.d1,
      kvReads,
      kvWrites,
      kvDeletes,
      kvListOps,
      kvStorageBytes,
      costs.kv,
      r2ClassAOps,
      r2ClassBOps,
      r2StorageBytes,
      r2EgressBytes,
      costs.r2,
      doRequests,
      doGbSeconds,
      doWsConnections,
      doStorageReads,
      doStorageWrites,
      doStorageDeletes,
      doStorageBytes,
      costs.durableObjects,
      vectorizeQueries,
      vectorizeVectorsStored,
      vectorizeDimensions,
      costs.vectorize,
      aigRequests,
      aigTokensIn,
      aigTokensOut,
      aigCached,
      costs.aiGateway,
      pagesDeployments,
      pagesBandwidth,
      costs.pages,
      queuesProduced,
      queuesConsumed,
      costs.queues,
      workersAIRequests,
      workersAINeurons,
      workersAICost,
      workflowsExecutions,
      workflowsSuccesses,
      workflowsFailures,
      workflowsWallTimeMs,
      workflowsCpuTimeMs,
      costs.workflows,
      totalCost,
      timestamp,
      samplingModeStr
    )
    .run();

  // Return approximate write count (1 for this insert/update)
  return 1;
}

// =============================================================================
// RESOURCE-LEVEL SNAPSHOT PERSISTENCE
// =============================================================================

/**
 * Resource row for batch inserts
 */
interface ResourceRow {
  id: string;
  snapshot_hour: string;
  resource_type: string;
  resource_id: string;
  resource_name: string | null;
  project: string;
  requests: number | null;
  cpu_time_ms: number | null;
  wall_time_ms: number | null;
  duration_ms: number | null;
  gb_seconds: number | null;
  storage_bytes: number | null;
  reads: number | null;
  writes: number | null;
  deletes: number | null;
  rows_read: number | null;
  rows_written: number | null;
  class_a_ops: number | null;
  class_b_ops: number | null;
  egress_bytes: number | null;
  neurons: number | null;
  cost_usd: number | null;
  source: string;
  confidence: number;
  allocation_basis: string | null;
  ingested_at: string;
}

/**
 * Persist resource-level usage snapshots for multi-level aggregation.
 *
 * Stores per-resource metrics in resource_usage_snapshots table, enabling:
 * - Account-level aggregation (SUM all resources)
 * - Per-CF-tool aggregation (GROUP BY resource_type)
 * - Per-project aggregation (GROUP BY project)
 * - Per-project-per-tool aggregation (GROUP BY project, resource_type)
 *
 * @param env - Worker environment
 * @param snapshotHour - ISO datetime string for the hour
 * @param usage - AccountUsage from GraphQL
 * @param queuesData - Queues metrics
 * @param workflowsData - Workflows metrics with byWorkflow breakdown
 * @returns Number of D1 writes
 */
export async function persistResourceUsageSnapshots(
  env: Env,
  snapshotHour: string,
  usage: AccountUsage,
  queuesData: QueuesMetrics[],
  workflowsData: {
    byWorkflow: Array<{
      workflowName: string;
      executions: number;
      successes: number;
      failures: number;
      wallTimeMs: number;
      cpuTimeMs: number;
    }>;
  }
): Promise<number> {
  let writeCount = 0;
  const ingestedAt = new Date().toISOString();

  // Helper to generate unique ID
  const genId = (type: string, resourceId: string) =>
    `${snapshotHour.replace(/[:-]/g, '').slice(0, 13)}-${type}-${resourceId.slice(0, 50)}`;

  // Helper to identify project for a resource
  const getProject = (_resourceType: string, resourceId: string): string => {
    return identifyProject(resourceId) || 'unknown';
  };

  const rows: ResourceRow[] = [];

  // 1. Workers - per scriptName
  for (const w of usage.workers) {
    const project = getProject('worker', w.scriptName);
    rows.push({
      id: genId('worker', w.scriptName),
      snapshot_hour: snapshotHour,
      resource_type: 'worker',
      resource_id: w.scriptName,
      resource_name: w.scriptName,
      project,
      requests: w.requests,
      cpu_time_ms: w.cpuTimeMs,
      wall_time_ms: null,
      duration_ms: null,
      gb_seconds: null,
      storage_bytes: null,
      reads: null,
      writes: null,
      deletes: null,
      rows_read: null,
      rows_written: null,
      class_a_ops: null,
      class_b_ops: null,
      egress_bytes: null,
      neurons: null,
      cost_usd: null, // Cost calculated at project level
      source: 'live',
      confidence: 100,
      allocation_basis: null,
      ingested_at: ingestedAt,
    });
  }

  // 2. D1 - per databaseId
  for (const db of usage.d1) {
    const project = getProject('d1', db.databaseName);
    rows.push({
      id: genId('d1', db.databaseId),
      snapshot_hour: snapshotHour,
      resource_type: 'd1',
      resource_id: db.databaseId,
      resource_name: db.databaseName,
      project,
      requests: null,
      cpu_time_ms: null,
      wall_time_ms: null,
      duration_ms: null,
      gb_seconds: null,
      storage_bytes: db.storageBytes,
      reads: null,
      writes: null,
      deletes: null,
      rows_read: db.rowsRead,
      rows_written: db.rowsWritten,
      class_a_ops: null,
      class_b_ops: null,
      egress_bytes: null,
      neurons: null,
      cost_usd: null,
      source: 'live',
      confidence: 100,
      allocation_basis: null,
      ingested_at: ingestedAt,
    });
  }

  // 3. KV - per namespaceId
  for (const kv of usage.kv) {
    const project = getProject('kv', kv.namespaceName);
    rows.push({
      id: genId('kv', kv.namespaceId),
      snapshot_hour: snapshotHour,
      resource_type: 'kv',
      resource_id: kv.namespaceId,
      resource_name: kv.namespaceName,
      project,
      requests: null,
      cpu_time_ms: null,
      wall_time_ms: null,
      duration_ms: null,
      gb_seconds: null,
      storage_bytes: kv.storageBytes,
      reads: kv.reads,
      writes: kv.writes,
      deletes: kv.deletes,
      rows_read: null,
      rows_written: null,
      class_a_ops: null,
      class_b_ops: null,
      egress_bytes: null,
      neurons: null,
      cost_usd: null,
      source: 'live',
      confidence: 100,
      allocation_basis: null,
      ingested_at: ingestedAt,
    });
  }

  // 4. R2 - per bucketName
  for (const r2 of usage.r2) {
    const project = getProject('r2', r2.bucketName);
    rows.push({
      id: genId('r2', r2.bucketName),
      snapshot_hour: snapshotHour,
      resource_type: 'r2',
      resource_id: r2.bucketName,
      resource_name: r2.bucketName,
      project,
      requests: null,
      cpu_time_ms: null,
      wall_time_ms: null,
      duration_ms: null,
      gb_seconds: null,
      storage_bytes: r2.storageBytes,
      reads: null,
      writes: null,
      deletes: null,
      rows_read: null,
      rows_written: null,
      class_a_ops: r2.classAOperations,
      class_b_ops: r2.classBOperations,
      egress_bytes: r2.egressBytes,
      neurons: null,
      cost_usd: null,
      source: 'live',
      confidence: 100,
      allocation_basis: null,
      ingested_at: ingestedAt,
    });
  }

  // 5. Durable Objects - per scriptName (with proportional allocation for gbSeconds/storageBytes)
  // DO has byScript for requests, but gbSeconds/storageBytes are account-level
  const doByScript = usage.durableObjects.byScript || [];
  const totalDORequests = doByScript.reduce((sum, d) => sum + d.requests, 0);
  const accountGbSeconds = usage.durableObjects.gbSeconds;
  const accountStorageBytes = usage.durableObjects.storageBytes;

  for (const doScript of doByScript) {
    const project = getProject('do', doScript.scriptName);
    const proportion = totalDORequests > 0 ? doScript.requests / totalDORequests : 0;
    const allocatedGbSeconds = accountGbSeconds * proportion;
    const allocatedStorageBytes = accountStorageBytes * proportion;
    const isEstimated = totalDORequests > 0 && (accountGbSeconds > 0 || accountStorageBytes > 0);

    rows.push({
      id: genId('do', doScript.scriptName),
      snapshot_hour: snapshotHour,
      resource_type: 'do',
      resource_id: doScript.scriptName,
      resource_name: doScript.scriptName,
      project,
      requests: doScript.requests,
      cpu_time_ms: null,
      wall_time_ms: null,
      duration_ms: null,
      gb_seconds: allocatedGbSeconds,
      storage_bytes: Math.round(allocatedStorageBytes),
      reads: null,
      writes: null,
      deletes: null,
      rows_read: null,
      rows_written: null,
      class_a_ops: null,
      class_b_ops: null,
      egress_bytes: null,
      neurons: null,
      cost_usd: null,
      source: isEstimated ? 'estimated' : 'live',
      confidence: isEstimated ? 80 : 100,
      allocation_basis: isEstimated
        ? `proportional_by_requests (${(proportion * 100).toFixed(1)}%)`
        : null,
      ingested_at: ingestedAt,
    });
  }

  // 6. Vectorize - per index name
  for (const v of usage.vectorize) {
    const project = getProject('vectorize', v.name);
    rows.push({
      id: genId('vectorize', v.name),
      snapshot_hour: snapshotHour,
      resource_type: 'vectorize',
      resource_id: v.name,
      resource_name: v.name,
      project,
      requests: null, // VectorizeInfo doesn't have query counts, just storage info
      cpu_time_ms: null,
      wall_time_ms: null,
      duration_ms: null,
      gb_seconds: null,
      storage_bytes: v.vectorCount * v.dimensions * 4, // Approximate: float32 vectors
      reads: null,
      writes: null,
      deletes: null,
      rows_read: null,
      rows_written: null,
      class_a_ops: null,
      class_b_ops: null,
      egress_bytes: null,
      neurons: null,
      cost_usd: null,
      source: 'live',
      confidence: 100,
      allocation_basis: null,
      ingested_at: ingestedAt,
    });
  }

  // 7. Queues - per queueId
  for (const q of queuesData) {
    const project = getProject('queues', q.queueName);
    rows.push({
      id: genId('queues', q.queueId),
      snapshot_hour: snapshotHour,
      resource_type: 'queues',
      resource_id: q.queueId,
      resource_name: q.queueName,
      project,
      requests: q.messagesProduced + q.messagesConsumed,
      cpu_time_ms: null,
      wall_time_ms: null,
      duration_ms: null,
      gb_seconds: null,
      storage_bytes: null,
      reads: q.messagesConsumed,
      writes: q.messagesProduced,
      deletes: null,
      rows_read: null,
      rows_written: null,
      class_a_ops: null,
      class_b_ops: null,
      egress_bytes: null,
      neurons: null,
      cost_usd: null,
      source: 'live',
      confidence: 100,
      allocation_basis: null,
      ingested_at: ingestedAt,
    });
  }

  // 8. Workflows - per workflowName
  for (const wf of workflowsData.byWorkflow) {
    const project = getProject('workflows', wf.workflowName);
    rows.push({
      id: genId('workflows', wf.workflowName),
      snapshot_hour: snapshotHour,
      resource_type: 'workflows',
      resource_id: wf.workflowName,
      resource_name: wf.workflowName,
      project,
      requests: wf.executions,
      cpu_time_ms: wf.cpuTimeMs,
      wall_time_ms: wf.wallTimeMs,
      duration_ms: null,
      gb_seconds: null,
      storage_bytes: null,
      reads: null,
      writes: null,
      deletes: null,
      rows_read: null,
      rows_written: null,
      class_a_ops: null,
      class_b_ops: null,
      egress_bytes: null,
      neurons: null,
      cost_usd: null,
      source: 'live',
      confidence: 100,
      allocation_basis: null,
      ingested_at: ingestedAt,
    });
  }

  // 9. AI Gateway - per gatewayId
  for (const gw of usage.aiGateway) {
    const project = getProject('aigateway', gw.gatewayId);
    rows.push({
      id: genId('aigateway', gw.gatewayId),
      snapshot_hour: snapshotHour,
      resource_type: 'aigateway',
      resource_id: gw.gatewayId,
      resource_name: gw.gatewayId,
      project,
      requests: gw.totalRequests,
      cpu_time_ms: null,
      wall_time_ms: null,
      duration_ms: null,
      gb_seconds: null,
      storage_bytes: null,
      reads: null,
      writes: null,
      deletes: null,
      rows_read: null,
      rows_written: null,
      class_a_ops: null,
      class_b_ops: null,
      egress_bytes: null,
      neurons: null,
      cost_usd: null,
      source: 'live',
      confidence: 100,
      allocation_basis: null,
      ingested_at: ingestedAt,
    });
  }

  // 10. Pages - per project (from pages array)
  // PagesMetrics tracks deployments/builds, not requests/bandwidth
  for (const pg of usage.pages) {
    const project = getProject('pages', pg.projectName);
    rows.push({
      id: genId('pages', pg.projectName),
      snapshot_hour: snapshotHour,
      resource_type: 'pages',
      resource_id: pg.projectName,
      resource_name: pg.projectName,
      project,
      requests: pg.totalBuilds, // Use totalBuilds as a proxy for activity
      cpu_time_ms: null,
      wall_time_ms: null,
      duration_ms: null,
      gb_seconds: null,
      storage_bytes: null,
      reads: null,
      writes: pg.productionDeployments + pg.previewDeployments, // Total deployments
      deletes: null,
      rows_read: null,
      rows_written: null,
      class_a_ops: null,
      class_b_ops: null,
      egress_bytes: null, // Not available in PagesMetrics
      neurons: null,
      cost_usd: null,
      source: 'live',
      confidence: 100,
      allocation_basis: null,
      ingested_at: ingestedAt,
    });
  }

  // Batch insert using D1 batch API — reduces ~200 write transactions/hr to ~8
  const RESOURCE_UPSERT_SQL = `INSERT INTO resource_usage_snapshots (
    id, snapshot_hour, resource_type, resource_id, resource_name, project,
    requests, cpu_time_ms, wall_time_ms, duration_ms, gb_seconds, storage_bytes,
    reads, writes, deletes, rows_read, rows_written, class_a_ops, class_b_ops,
    egress_bytes, neurons, cost_usd, source, confidence, allocation_basis, ingested_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (snapshot_hour, resource_type, resource_id) DO UPDATE SET
    resource_name = excluded.resource_name,
    project = excluded.project,
    requests = COALESCE(excluded.requests, resource_usage_snapshots.requests),
    cpu_time_ms = COALESCE(excluded.cpu_time_ms, resource_usage_snapshots.cpu_time_ms),
    wall_time_ms = COALESCE(excluded.wall_time_ms, resource_usage_snapshots.wall_time_ms),
    duration_ms = COALESCE(excluded.duration_ms, resource_usage_snapshots.duration_ms),
    gb_seconds = COALESCE(excluded.gb_seconds, resource_usage_snapshots.gb_seconds),
    storage_bytes = COALESCE(excluded.storage_bytes, resource_usage_snapshots.storage_bytes),
    reads = COALESCE(excluded.reads, resource_usage_snapshots.reads),
    writes = COALESCE(excluded.writes, resource_usage_snapshots.writes),
    deletes = COALESCE(excluded.deletes, resource_usage_snapshots.deletes),
    rows_read = COALESCE(excluded.rows_read, resource_usage_snapshots.rows_read),
    rows_written = COALESCE(excluded.rows_written, resource_usage_snapshots.rows_written),
    class_a_ops = COALESCE(excluded.class_a_ops, resource_usage_snapshots.class_a_ops),
    class_b_ops = COALESCE(excluded.class_b_ops, resource_usage_snapshots.class_b_ops),
    egress_bytes = COALESCE(excluded.egress_bytes, resource_usage_snapshots.egress_bytes),
    neurons = COALESCE(excluded.neurons, resource_usage_snapshots.neurons),
    cost_usd = excluded.cost_usd,
    source = CASE
      WHEN excluded.confidence > resource_usage_snapshots.confidence THEN excluded.source
      ELSE resource_usage_snapshots.source
    END,
    confidence = MAX(resource_usage_snapshots.confidence, excluded.confidence),
    allocation_basis = excluded.allocation_basis,
    ingested_at = excluded.ingested_at`;

  const bindRow = (row: typeof rows[number]): D1PreparedStatement =>
    env.PLATFORM_DB.prepare(RESOURCE_UPSERT_SQL).bind(
      row.id, row.snapshot_hour, row.resource_type, row.resource_id,
      row.resource_name, row.project, row.requests, row.cpu_time_ms,
      row.wall_time_ms, row.duration_ms, row.gb_seconds, row.storage_bytes,
      row.reads, row.writes, row.deletes, row.rows_read, row.rows_written,
      row.class_a_ops, row.class_b_ops, row.egress_bytes, row.neurons,
      row.cost_usd, row.source, row.confidence, row.allocation_basis, row.ingested_at
    );

  const BATCH_SIZE = 25;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    try {
      const statements = chunk.map(bindRow);
      await env.PLATFORM_DB.batch(statements);
      writeCount += chunk.length;
    } catch (error) {
      // Fallback: try individual inserts for the failed batch
      const batchLog = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:resource-snapshot');
      batchLog.error(
        `Batch insert failed for ${chunk.length} rows, falling back to individual`,
        error instanceof Error ? error : new Error(String(error))
      );
      for (const row of chunk) {
        try {
          await bindRow(row).run();
          writeCount++;
        } catch (individualError) {
          batchLog.error(
            `Failed to insert ${row.resource_type}/${row.resource_id}`,
            individualError instanceof Error ? individualError : new Error(String(individualError))
          );
        }
      }
    }
  }

  const resourceLog = createLoggerFromEnv(
    env,
    'platform-usage',
    'platform:usage:resource-snapshot'
  );
  resourceLog.info(`Persisted ${writeCount} resource-level snapshots for ${snapshotHour}`, {
    tag: 'RESOURCE-SNAPSHOT',
  });
  return writeCount;
}

// =============================================================================
// EXTERNAL BILLING COLLECTORS (Re-exported from collectors module)
// =============================================================================

// Re-export the unified collector framework
// See workers/lib/usage/collectors/ for the collector interface and example
export {
  collectExternalMetrics,
  type ExternalMetrics,
  type ExternalCollector,
} from '../collectors';

// TODO: Add re-exports for your custom collectors here.
// See workers/lib/usage/collectors/example.ts for the collector template.

// THIRD-PARTY USAGE PERSISTENCE
// =============================================================================

/**
 * Persist third-party usage data (GitHub billing, etc.).
 */
export async function persistThirdPartyUsage(
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
// API TOKEN VALIDATION
// =============================================================================

/**
 * Validate Cloudflare API token by making a simple account API call.
 * Returns account name if valid, null if invalid.
 */
export async function validateCloudflareToken(env: Env): Promise<string | null> {
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:token');
  try {
    const response = await fetchWithRetry(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`,
      {
        headers: {
          Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    if (!response.ok) {
      const text = await response.text();
      log.error(`CF API token validation failed: ${response.status} - ${text}`);
      return null;
    }
    const data = (await response.json()) as { success: boolean; result?: { name?: string } };
    if (!data.success) {
      log.error('CF API returned success=false');
      return null;
    }
    const accountName = data.result?.name || 'Unknown';
    log.info('CF API token valid', { accountName });
    return accountName;
  } catch (error) {
    log.error('CF API token validation error', error);
    return null;
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

export {
  // Re-export types for consumers
  type GitHubPlanInclusions,
};
