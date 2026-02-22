/**
 * Analytics Engine SQL API Helper
 *
 * Provides helpers for querying Analytics Engine via the SQL API.
 * Used by the daily rollup to aggregate SDK telemetry from PLATFORM_ANALYTICS.
 *
 * @module workers/lib/analytics-engine
 */

import { withExponentialBackoff } from '@littlebearapps/platform-sdk';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Analytics Engine SQL API response structure.
 *
 * The SQL API returns data in one of two formats:
 * 1. Direct format (success): { meta: [...], data: [...], rows: N }
 * 2. Wrapped format (via REST API): { success: true, result: { meta, data, rows } }
 * 3. Error format: { errors: [...] }
 */
interface AnalyticsEngineResponse {
  // Direct format (SQL API)
  meta?: Array<{ name: string; type: string }>;
  data?: unknown[];
  rows?: number;
  rows_before_limit_at_least?: number;

  // Wrapped format (REST API)
  success?: boolean;
  errors?: Array<{ code: number; message: string }>;
  result?: {
    data: unknown[];
    meta: Array<{ name: string; type: string }>;
    rows: number;
    rows_before_limit_at_least: number;
  };
}

/**
 * Daily usage aggregation from Analytics Engine
 */
export interface DailyUsageAggregation {
  project_id: string;
  feature_id: string;
  d1_reads: number;
  d1_writes: number;
  d1_rows_read: number;
  d1_rows_written: number;
  kv_reads: number;
  kv_writes: number;
  kv_deletes: number;
  kv_lists: number;
  ai_requests: number;
  ai_neurons: number;
  vectorize_queries: number;
  vectorize_inserts: number;
  vectorize_deletes: number;
  interaction_count: number;
}

// =============================================================================
// ANALYTICS ENGINE SQL API CLIENT
// =============================================================================

/**
 * Query Analytics Engine via the SQL API.
 *
 * @param accountId Cloudflare account ID
 * @param apiToken Cloudflare API token with Analytics Engine read access
 * @param sql SQL query to execute
 * @returns Query results
 */
export async function queryAnalyticsEngine<T>(
  accountId: string,
  apiToken: string,
  sql: string
): Promise<T[]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'text/plain',
    },
    body: sql,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Analytics Engine API error: ${response.status} - ${text}`);
  }

  const rawText = await response.text();
  let data: AnalyticsEngineResponse;
  try {
    data = JSON.parse(rawText) as AnalyticsEngineResponse;
  } catch {
    throw new Error(`Analytics Engine returned invalid JSON: ${rawText.slice(0, 500)}`);
  }

  // Check for error response
  if (data.errors && data.errors.length > 0) {
    const errorMessages = data.errors.map((e) => e.message).join(', ');
    throw new Error(`Analytics Engine query failed: ${errorMessages}`);
  }

  // Handle both response formats:
  // 1. Direct format: { meta, data, rows }
  // 2. Wrapped format: { success, result: { meta, data, rows } }
  const meta = data.meta ?? data.result?.meta;
  const resultData = data.data ?? data.result?.data;

  // Validate response structure
  if (!meta || !resultData) {
    throw new Error(
      `Analytics Engine response missing expected fields. ` +
        `Got keys: ${JSON.stringify(Object.keys(data))}`
    );
  }

  // Map the result data to typed objects using column metadata
  // Analytics Engine can return data in two formats:
  // 1. Array of arrays: [[val1, val2], [val1, val2]] - needs column mapping
  // 2. Array of objects: [{col1: val1, col2: val2}, ...] - already in object format
  const columns = meta.map((m) => m.name);

  return resultData.map((row) => {
    // If row is already an object (not an array), return it directly
    if (row !== null && typeof row === 'object' && !Array.isArray(row)) {
      return row as T;
    }

    // Row is an array - map using column metadata
    const rowArray = row as unknown[];
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      obj[col] = rowArray[i];
    });
    return obj as T;
  });
}

/**
 * Get daily usage aggregation from Analytics Engine.
 * Queries the PLATFORM_ANALYTICS dataset for yesterday's telemetry data.
 *
 * @param accountId Cloudflare account ID
 * @param apiToken Cloudflare API token
 * @param datasetName Analytics Engine dataset name (default: platform-analytics)
 * @returns Aggregated usage by project and feature
 */
export async function getDailyUsageFromAnalyticsEngine(
  accountId: string,
  apiToken: string,
  datasetName = 'platform-analytics'
): Promise<DailyUsageAggregation[]> {
  // Query for yesterday's data (00:00:00 to 23:59:59 UTC)
  // Analytics Engine uses blob1-20 and double1-20 naming convention
  //
  // Data schema from queue handler (platform-usage.ts):
  // blobs: [project, category, feature]  (feature_key is in indexes)
  // doubles: [d1Writes, d1Reads, kvReads, kvWrites, doRequests, doGbSeconds,
  //           r2ClassA, r2ClassB, aiNeurons, queueMessages, requests, cpuMs,
  //           d1RowsRead, d1RowsWritten, kvDeletes, kvLists, aiRequests,
  //           vectorizeQueries, vectorizeInserts, workflowInvocations]
  // indexes: [feature_key]
  //
  // NOTE: Table name must be quoted because it contains a hyphen
  const sql = `
    SELECT
      blob1 as project_id,
      index1 as feature_id,
      SUM(double2) as d1_reads,
      SUM(double1) as d1_writes,
      SUM(double13) as d1_rows_read,
      SUM(double14) as d1_rows_written,
      SUM(double3) as kv_reads,
      SUM(double4) as kv_writes,
      SUM(double15) as kv_deletes,
      SUM(double16) as kv_lists,
      SUM(double17) as ai_requests,
      SUM(double9) as ai_neurons,
      SUM(double18) as vectorize_queries,
      SUM(double19) as vectorize_inserts,
      0 as vectorize_deletes,
      count() as interaction_count
    FROM "${datasetName}"
    WHERE timestamp >= NOW() - INTERVAL '1' DAY
    GROUP BY project_id, feature_id
    ORDER BY project_id, feature_id
  `;

  return queryAnalyticsEngine<DailyUsageAggregation>(accountId, apiToken, sql);
}

/**
 * Get aggregated project-level usage from Analytics Engine.
 * Groups all features by project for higher-level reporting.
 *
 * @param accountId Cloudflare account ID
 * @param apiToken Cloudflare API token
 * @param datasetName Analytics Engine dataset name
 * @returns Aggregated usage by project
 */
export async function getProjectUsageFromAnalyticsEngine(
  accountId: string,
  apiToken: string,
  datasetName = 'platform-analytics'
): Promise<Omit<DailyUsageAggregation, 'feature_id'>[]> {
  // NOTE: Table name must be quoted because it contains a hyphen
  // Schema matches METRIC_FIELDS order from platform-sdk/constants.ts
  const sql = `
    SELECT
      blob1 as project_id,
      SUM(double2) as d1_reads,
      SUM(double1) as d1_writes,
      SUM(double13) as d1_rows_read,
      SUM(double14) as d1_rows_written,
      SUM(double3) as kv_reads,
      SUM(double4) as kv_writes,
      SUM(double15) as kv_deletes,
      SUM(double16) as kv_lists,
      SUM(double17) as ai_requests,
      SUM(double9) as ai_neurons,
      SUM(double18) as vectorize_queries,
      SUM(double19) as vectorize_inserts,
      0 as vectorize_deletes,
      count() as interaction_count
    FROM "${datasetName}"
    WHERE timestamp >= NOW() - INTERVAL '1' DAY
    GROUP BY project_id
    ORDER BY project_id
  `;

  return queryAnalyticsEngine<Omit<DailyUsageAggregation, 'feature_id'>>(accountId, apiToken, sql);
}

// =============================================================================
// TIME-BUCKETED QUERIES
// =============================================================================

/**
 * Time-bucketed usage data from Analytics Engine.
 * Aggregates metrics by time bucket (hour/day) and project.
 */
export interface TimeBucketedUsage {
  time_bucket: string;
  project_id: string;
  d1_writes: number;
  d1_reads: number;
  d1_rows_read: number;
  d1_rows_written: number;
  kv_reads: number;
  kv_writes: number;
  kv_deletes: number;
  kv_lists: number;
  do_requests: number;
  do_gb_seconds: number;
  r2_class_a: number;
  r2_class_b: number;
  ai_neurons: number;
  ai_requests: number;
  queue_messages: number;
  requests: number;
  cpu_ms: number;
  vectorize_queries: number;
  vectorize_inserts: number;
  workflow_invocations: number;
  interaction_count: number;
}

/**
 * Query parameters for time-bucketed usage.
 */
export interface TimeBucketQueryParams {
  period: '24h' | '7d' | '30d';
  groupBy: 'hour' | 'day';
  project?: string;
}

/**
 * Query usage by time bucket from Analytics Engine.
 * Returns aggregated metrics grouped by time interval (hour/day) and project.
 *
 * @param accountId Cloudflare account ID
 * @param apiToken Cloudflare API token
 * @param params Query parameters (period, groupBy, optional project filter)
 * @param datasetName Analytics Engine dataset name
 * @returns Time-bucketed usage data
 */
export async function queryUsageByTimeBucket(
  accountId: string,
  apiToken: string,
  params: TimeBucketQueryParams,
  datasetName = 'platform-analytics'
): Promise<TimeBucketedUsage[]> {
  // Determine interval based on groupBy
  const interval = params.groupBy === 'hour' ? 'HOUR' : 'DAY';

  // Map period to interval parts (number and unit must be separate for Analytics Engine)
  const periodMap: Record<string, { num: string; unit: string }> = {
    '24h': { num: '1', unit: 'DAY' },
    '7d': { num: '7', unit: 'DAY' },
    '30d': { num: '30', unit: 'DAY' },
  };
  const periodParts = periodMap[params.period] ?? { num: '1', unit: 'DAY' };

  // Build project filter clause
  const projectFilter = params.project ? `AND blob1 = '${params.project}'` : '';

  // NOTE: Table name must be quoted because it contains a hyphen
  // Analytics Engine columns map (from platform-sdk/constants.ts METRIC_FIELDS):
  // double1=d1Writes, double2=d1Reads, double3=kvReads, double4=kvWrites,
  // double5=doRequests, double6=doGbSeconds, double7=r2ClassA, double8=r2ClassB,
  // double9=aiNeurons, double10=queueMessages, double11=requests, double12=cpuMs,
  // double13=d1RowsRead, double14=d1RowsWritten, double15=kvDeletes, double16=kvLists,
  // double17=aiRequests, double18=vectorizeQueries, double19=vectorizeInserts,
  // double20=workflowInvocations
  // blobs: blob1=project, blob2=category, blob3=feature
  const sql = `
    SELECT
      toStartOfInterval(timestamp, INTERVAL '1' ${interval}) as time_bucket,
      blob1 as project_id,
      SUM(double1) as d1_writes,
      SUM(double2) as d1_reads,
      SUM(double13) as d1_rows_read,
      SUM(double14) as d1_rows_written,
      SUM(double3) as kv_reads,
      SUM(double4) as kv_writes,
      SUM(double15) as kv_deletes,
      SUM(double16) as kv_lists,
      SUM(double5) as do_requests,
      SUM(double6) as do_gb_seconds,
      SUM(double7) as r2_class_a,
      SUM(double8) as r2_class_b,
      SUM(double9) as ai_neurons,
      SUM(double17) as ai_requests,
      SUM(double10) as queue_messages,
      SUM(double11) as requests,
      SUM(double12) as cpu_ms,
      SUM(double18) as vectorize_queries,
      SUM(double19) as vectorize_inserts,
      SUM(double20) as workflow_invocations,
      count() as interaction_count
    FROM "${datasetName}"
    WHERE timestamp >= NOW() - INTERVAL '${periodParts.num}' ${periodParts.unit}
    ${projectFilter}
    GROUP BY time_bucket, project_id
    ORDER BY time_bucket ASC, project_id ASC
  `;

  return queryAnalyticsEngine<TimeBucketedUsage>(accountId, apiToken, sql);
}
