/**
 * Feature Usage Handlers
 *
 * Handlers for feature-level usage endpoints including circuit breakers,
 * budgets, history, and Workers AI metrics.
 *
 * Extracted from platform-usage.ts as part of Phase B migration.
 */

import { createLoggerFromEnv } from '@littlebearapps/platform-consumer-sdk';
import { CloudflareGraphQL } from '../../shared/cloudflare';
import {
  queryUsageByTimeBucket,
  type TimeBucketedUsage,
  type TimeBucketQueryParams,
} from '../../analytics-engine';
import type { Env, FeatureUsageData, WorkersAIResponse, WorkersAISummary } from '../shared';
import { FEATURE_KV_KEYS, FEATURE_METRIC_FIELDS, jsonResponse, parseQueryParams } from '../shared';
import { queryAIGatewayMetrics } from './data-queries';

// =============================================================================
// HELPER: D1 FALLBACK FOR ANALYTICS ENGINE
// =============================================================================

/**
 * Query D1 daily_usage_rollups as fallback when Analytics Engine has insufficient data.
 * Transforms D1 columns to match TimeBucketedUsage interface.
 *
 * Analytics Engine has 7-day retention (free tier), so historical queries
 * beyond that window need to fall back to D1 which stores 90 days of daily rollups.
 *
 * @param db D1 database binding
 * @param params Query parameters
 * @returns Time-bucketed usage data from D1
 */
async function queryUsageFromD1(
  db: D1Database,
  params: TimeBucketQueryParams
): Promise<TimeBucketedUsage[]> {
  // Calculate date range based on period
  const now = new Date();
  const daysBack = params.period === '24h' ? 1 : params.period === '7d' ? 7 : 30;
  const startDate = new Date(now);
  startDate.setUTCDate(startDate.getUTCDate() - daysBack);
  const startDateStr = startDate.toISOString().split('T')[0];
  const endDateStr = now.toISOString().split('T')[0];

  // Build project filter
  const projectFilter = params.project ? `AND project = ?` : `AND project != 'all'`;
  const bindParams = params.project
    ? [startDateStr, endDateStr, params.project]
    : [startDateStr, endDateStr];

  // Query D1 - groupBy 'hour' not supported in D1 (only daily data), fall back to day
  const query = `
    SELECT
      snapshot_date || 'T00:00:00Z' as time_bucket,
      project as project_id,
      0 as d1_writes,
      0 as d1_reads,
      COALESCE(d1_rows_read, 0) as d1_rows_read,
      COALESCE(d1_rows_written, 0) as d1_rows_written,
      COALESCE(kv_reads, 0) as kv_reads,
      COALESCE(kv_writes, 0) as kv_writes,
      COALESCE(kv_deletes, 0) as kv_deletes,
      COALESCE(kv_list_ops, 0) as kv_lists,
      COALESCE(do_requests, 0) as do_requests,
      COALESCE(do_gb_seconds, 0) as do_gb_seconds,
      COALESCE(r2_class_a_ops, 0) as r2_class_a,
      COALESCE(r2_class_b_ops, 0) as r2_class_b,
      COALESCE(workersai_neurons, 0) as ai_neurons,
      COALESCE(workersai_requests, 0) as ai_requests,
      COALESCE(queues_messages_produced, 0) as queue_messages,
      COALESCE(workers_requests, 0) as requests,
      COALESCE(workers_cpu_time_ms, 0) as cpu_ms,
      COALESCE(vectorize_queries, 0) as vectorize_queries,
      0 as vectorize_inserts,
      COALESCE(workflows_executions, 0) as workflow_invocations,
      COALESCE(samples_count, 1) as interaction_count
    FROM daily_usage_rollups
    WHERE snapshot_date >= ?
      AND snapshot_date <= ?
      ${projectFilter}
    ORDER BY snapshot_date ASC, project ASC
  `;

  const result = await db
    .prepare(query)
    .bind(...bindParams)
    .all<TimeBucketedUsage>();
  return result.results ?? [];
}

// =============================================================================
// HANDLERS
// =============================================================================

/**
 * Handle GET /usage/features
 *
 * Returns feature-level usage from Analytics Engine with circuit breaker status.
 * Query params:
 * - period: 'hour' | 'day' (default: 'hour')
 * - feature: optional specific feature key to filter
 */
export async function handleFeatures(url: URL, env: Env): Promise<Response> {
  const reqStartTime = Date.now();
  const period = url.searchParams.get('period') ?? 'hour';
  const featureFilter = url.searchParams.get('feature');

  try {
    // Calculate time range for query
    const now = new Date();
    let queryStartTime: Date;
    if (period === 'day') {
      queryStartTime = new Date(now);
      queryStartTime.setUTCHours(0, 0, 0, 0);
    } else {
      queryStartTime = new Date(now);
      queryStartTime.setMinutes(0, 0, 0);
    }

    // =========================================================================
    // Step 1: Fetch ALL registered features from D1 feature_registry
    // =========================================================================
    // This ensures features appear even when idle (no AE activity)
    let registeredFeatures: Array<{
      feature_key: string;
      project_id: string;
      category: string;
      feature: string;
      display_name: string;
      circuit_breaker_enabled: number;
      daily_limits_json: string | null;
    }> = [];

    // Also fetch heartbeat data from system_health_checks
    const heartbeatMap = new Map<string, { lastHeartbeat: string; status: string }>();
    try {
      const healthResult = await env.PLATFORM_DB.prepare(
        `SELECT project_id, feature_id, last_heartbeat, status FROM system_health_checks`
      ).all<{ project_id: string; feature_id: string; last_heartbeat: number; status: string }>();

      for (const row of healthResult.results ?? []) {
        // feature_id is stored as the full feature_key
        heartbeatMap.set(row.feature_id, {
          lastHeartbeat: new Date(row.last_heartbeat * 1000).toISOString(),
          status: row.status,
        });
      }
    } catch (err) {
      // system_health_checks may not have data yet - continue without heartbeat info
      const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:features');
      log.debug('Could not query system_health_checks', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      let registryQuery = `
        SELECT feature_key, project_id, category, feature, display_name,
               circuit_breaker_enabled, daily_limits_json
        FROM feature_registry
      `;
      if (featureFilter) {
        registryQuery += ` WHERE feature_key = ?`;
        const stmt = env.PLATFORM_DB.prepare(registryQuery).bind(featureFilter);
        const registryResult = await stmt.all();
        registeredFeatures = (registryResult.results ?? []) as typeof registeredFeatures;
      } else {
        const registryResult = await env.PLATFORM_DB.prepare(registryQuery).all();
        registeredFeatures = (registryResult.results ?? []) as typeof registeredFeatures;
      }
      const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:features');
      log.info('Loaded features from registry', { count: registeredFeatures.length });
    } catch (err) {
      // feature_registry may not exist in some environments - proceed with AE only
      const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:features');
      log.warn('Could not query feature_registry', err instanceof Error ? err : undefined);
    }

    // =========================================================================
    // Step 2: Query Analytics Engine for features with activity
    // =========================================================================
    const sumClauses = FEATURE_METRIC_FIELDS.map(
      (field, i) => `SUM(double${i + 1}) as ${field}`
    ).join(', ');

    // Analytics Engine toDateTime() requires 'YYYY-MM-DD HH:MM:SS' format
    // (no 'T' separator, no milliseconds, no timezone suffix)
    const formattedStartTime = queryStartTime
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, '');
    let whereClause = `timestamp >= toDateTime('${formattedStartTime}')`;
    if (featureFilter) {
      whereClause += ` AND index1 = '${featureFilter.replace(/'/g, "''")}'`;
    }

    const query = `
      SELECT
        index1 as feature_key,
        blob1 as project,
        blob2 as category,
        blob3 as feature,
        ${sumClauses}
      FROM "platform-analytics"
      WHERE ${whereClause}
      GROUP BY index1, blob1, blob2, blob3
      ORDER BY feature_key
      FORMAT JSON
    `;

    // Build a map of AE data for quick lookup
    const aeDataMap = new Map<
      string,
      {
        project: string;
        category: string;
        feature: string;
        metrics: Record<string, number>;
      }
    >();

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/analytics_engine/sql`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
          'Content-Type': 'text/plain',
        },
        body: query,
      }
    );

    if (response.ok) {
      const result = (await response.json()) as {
        data: Array<{
          feature_key: string;
          project: string;
          category: string;
          feature: string;
          [key: string]: string | number;
        }>;
      };

      for (const row of result.data ?? []) {
        const metrics: Record<string, number> = {};
        for (const field of FEATURE_METRIC_FIELDS) {
          metrics[field] = typeof row[field] === 'number' ? row[field] : 0;
        }
        aeDataMap.set(row.feature_key, {
          project: row.project,
          category: row.category,
          feature: row.feature,
          metrics,
        });
      }
      const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:features');
      log.info('Loaded features from Analytics Engine', { count: aeDataMap.size });
    } else {
      const errorText = await response.text();
      const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:features');
      // Handle empty dataset - not an error, just no activity yet
      if (!errorText.includes('unable to find type of column')) {
        log.error('Analytics Engine query failed', undefined, {
          status: response.status,
          errorText,
        });
      } else {
        log.info('No data in platform-analytics dataset yet');
      }
    }

    // =========================================================================
    // Step 3: Merge registered features with AE data
    // =========================================================================
    // Build zero metrics object for features without activity
    const zeroMetrics: Record<string, number> = {};
    for (const field of FEATURE_METRIC_FIELDS) {
      zeroMetrics[field] = 0;
    }

    // Create a Set of feature keys we've already processed
    const processedKeys = new Set<string>();
    const features: FeatureUsageData[] = [];

    // Process registered features first (ensures all appear)
    for (const reg of registeredFeatures) {
      const featureKey = reg.feature_key;
      processedKeys.add(featureKey);

      const aeData = aeDataMap.get(featureKey);

      // Get circuit breaker state from KV
      const [enabledStr, disabledReason, disabledAt, autoResetAt] = await Promise.all([
        env.PLATFORM_CACHE.get(FEATURE_KV_KEYS.enabled(featureKey)),
        env.PLATFORM_CACHE.get(FEATURE_KV_KEYS.disabledReason(featureKey)),
        env.PLATFORM_CACHE.get(FEATURE_KV_KEYS.disabledAt(featureKey)),
        env.PLATFORM_CACHE.get(FEATURE_KV_KEYS.autoResetAt(featureKey)),
      ]);

      // Get heartbeat info for this feature
      const heartbeat = heartbeatMap.get(featureKey);

      features.push({
        featureKey,
        project: aeData?.project ?? reg.project_id,
        category: aeData?.category ?? reg.category,
        feature: aeData?.feature ?? reg.feature,
        metrics: aeData?.metrics ?? { ...zeroMetrics },
        circuitBreaker: {
          enabled: enabledStr !== 'false',
          disabledReason: disabledReason ?? undefined,
          disabledAt: disabledAt ?? undefined,
          autoResetAt: autoResetAt ?? undefined,
        },
        // Include budget info from registry
        budget: reg.daily_limits_json ? JSON.parse(reg.daily_limits_json) : undefined,
        circuitBreakerEnabled: reg.circuit_breaker_enabled === 1,
        hasActivity: !!aeData,
        // Heartbeat info from system_health_checks
        lastHeartbeat: heartbeat?.lastHeartbeat,
        healthStatus: heartbeat?.status,
      });
    }

    // Add any AE features not in registry (shouldn't happen, but be safe)
    for (const [featureKey, aeData] of aeDataMap) {
      if (processedKeys.has(featureKey)) continue;

      const [enabledStr, disabledReason, disabledAt, autoResetAt] = await Promise.all([
        env.PLATFORM_CACHE.get(FEATURE_KV_KEYS.enabled(featureKey)),
        env.PLATFORM_CACHE.get(FEATURE_KV_KEYS.disabledReason(featureKey)),
        env.PLATFORM_CACHE.get(FEATURE_KV_KEYS.disabledAt(featureKey)),
        env.PLATFORM_CACHE.get(FEATURE_KV_KEYS.autoResetAt(featureKey)),
      ]);

      // Get heartbeat info for this feature
      const heartbeat = heartbeatMap.get(featureKey);

      features.push({
        featureKey,
        project: aeData.project,
        category: aeData.category,
        feature: aeData.feature,
        metrics: aeData.metrics,
        circuitBreaker: {
          enabled: enabledStr !== 'false',
          disabledReason: disabledReason ?? undefined,
          disabledAt: disabledAt ?? undefined,
          autoResetAt: autoResetAt ?? undefined,
        },
        hasActivity: true,
        // Heartbeat info from system_health_checks
        lastHeartbeat: heartbeat?.lastHeartbeat,
        healthStatus: heartbeat?.status,
      });
    }

    // Sort by feature key for consistent ordering
    features.sort((a, b) => a.featureKey.localeCompare(b.featureKey));

    return jsonResponse({
      success: true,
      period,
      queryStartTime: queryStartTime.toISOString(),
      features,
      registeredCount: registeredFeatures.length,
      activeCount: aeDataMap.size,
      timestamp: new Date().toISOString(),
      responseTimeMs: Date.now() - reqStartTime,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:features');
    log.error('Error fetching feature usage', error instanceof Error ? error : undefined, {
      errorMessage,
    });

    return jsonResponse(
      { success: false, error: 'Failed to fetch feature usage', message: errorMessage },
      500
    );
  }
}

/**
 * Handle GET /usage/query
 *
 * Returns time-bucketed aggregated usage data from Analytics Engine,
 * with D1 fallback for historical data beyond AE retention (7 days).
 * Supports period (24h/7d/30d), groupBy (hour/day), and optional project filter.
 *
 * Query params:
 * - period: '24h' | '7d' | '30d' (default: '24h')
 * - groupBy: 'hour' | 'day' (default: 'hour')
 * - project: optional project ID filter
 *
 * Response format:
 * {
 *   success: true,
 *   data: [{ time_bucket: "2026-01-20T14:00:00Z", project_id: "my-app", ... }],
 *   meta: { period: "24h", groupBy: "hour", rowCount: 24, queryTimeMs: 45, source: "ae" | "d1" },
 *   timestamp: "2026-01-20T15:30:00Z"
 * }
 */
export async function handleUsageQuery(url: URL, env: Env): Promise<Response> {
  const startTime = Date.now();

  // Parse and validate query params
  const periodParam = url.searchParams.get('period') ?? '24h';
  const groupByParam = url.searchParams.get('groupBy') ?? 'hour';
  const projectParam = url.searchParams.get('project') ?? undefined;

  // Validate period
  const validPeriods = ['24h', '7d', '30d'] as const;
  if (!validPeriods.includes(periodParam as (typeof validPeriods)[number])) {
    return jsonResponse(
      {
        success: false,
        error: 'Invalid period parameter',
        code: 'INVALID_PERIOD',
        message: `period must be one of: ${validPeriods.join(', ')}`,
      },
      400
    );
  }

  // Validate groupBy
  const validGroupBy = ['hour', 'day'] as const;
  if (!validGroupBy.includes(groupByParam as (typeof validGroupBy)[number])) {
    return jsonResponse(
      {
        success: false,
        error: 'Invalid groupBy parameter',
        code: 'INVALID_GROUP_BY',
        message: `groupBy must be one of: ${validGroupBy.join(', ')}`,
      },
      400
    );
  }

  const period = periodParam as TimeBucketQueryParams['period'];
  const groupBy = groupByParam as TimeBucketQueryParams['groupBy'];

  // Determine expected data points based on period and groupBy
  // Analytics Engine has ~7 day retention (free tier)
  const expectedDays = period === '24h' ? 1 : period === '7d' ? 7 : 30;
  const aeRetentionDays = 7; // Free tier Analytics Engine retention

  let data: TimeBucketedUsage[] = [];
  let source: 'ae' | 'd1' | 'ae+d1' = 'ae';

  try {
    // Try Analytics Engine first (real-time SDK telemetry)
    data = await queryUsageByTimeBucket(
      env.CLOUDFLARE_ACCOUNT_ID,
      env.CLOUDFLARE_API_TOKEN,
      { period, groupBy, project: projectParam },
      'platform-analytics'
    );

    // Check if AE returned sufficient data for the requested period
    // For periods beyond AE retention, fall back to D1
    const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:query');
    if (expectedDays > aeRetentionDays && data.length === 0) {
      // AE has no data, use D1 exclusively
      log.info('AE returned 0 rows, falling back to D1 daily_usage_rollups', { period });
      data = await queryUsageFromD1(env.PLATFORM_DB, { period, groupBy, project: projectParam });
      source = 'd1';
    } else if (expectedDays > aeRetentionDays) {
      // AE has partial data, supplement with D1 for older dates
      // Get unique dates from AE data
      const aeDates = new Set(data.map((r) => r.time_bucket.split('T')[0]));

      // Query D1 for the full period
      const d1Data = await queryUsageFromD1(env.PLATFORM_DB, {
        period,
        groupBy: 'day', // D1 only has daily granularity
        project: projectParam,
      });

      // Filter D1 data to only include dates not in AE
      const d1OnlyData = d1Data.filter((r) => {
        const date = r.time_bucket.split('T')[0];
        return !aeDates.has(date);
      });

      if (d1OnlyData.length > 0) {
        log.info('Supplementing AE rows with D1 rows', {
          aeRows: data.length,
          d1Rows: d1OnlyData.length,
        });
        // Combine D1 historical + AE recent, sorted by time
        data = [...d1OnlyData, ...data].sort((a, b) => a.time_bucket.localeCompare(b.time_bucket));
        source = 'ae+d1';
      }
    }

    const queryTimeMs = Date.now() - startTime;

    // Return response with 5-minute cache header (Analytics Engine eventual consistency)
    return new Response(
      JSON.stringify({
        success: true,
        data,
        meta: {
          period,
          groupBy,
          project: projectParam ?? 'all',
          rowCount: data.length,
          queryTimeMs,
          source,
        },
        timestamp: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300',
        },
      }
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const logQuery = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:query');
    logQuery.error('Usage query error', error instanceof Error ? error : undefined, {
      errorMessage,
    });

    // Handle empty dataset case gracefully - try D1 fallback
    if (errorMessage.includes('unable to find type of column')) {
      logQuery.info('AE empty dataset error, trying D1 fallback');
      try {
        data = await queryUsageFromD1(env.PLATFORM_DB, { period, groupBy, project: projectParam });
        source = 'd1';

        return jsonResponse({
          success: true,
          data,
          meta: {
            period,
            groupBy,
            project: projectParam ?? 'all',
            rowCount: data.length,
            queryTimeMs: Date.now() - startTime,
            source,
          },
          note:
            data.length === 0
              ? 'No usage data found. Data will appear after features report usage.'
              : 'Data from D1 daily_usage_rollups (Analytics Engine empty)',
          timestamp: new Date().toISOString(),
        });
      } catch (d1Error) {
        logQuery.error('D1 fallback also failed', d1Error instanceof Error ? d1Error : undefined);
        return jsonResponse({
          success: true,
          data: [],
          meta: {
            period,
            groupBy,
            project: projectParam ?? 'all',
            rowCount: 0,
            queryTimeMs: Date.now() - startTime,
            source: 'none',
          },
          note: 'No telemetry data collected yet. Data will appear after features report usage.',
          timestamp: new Date().toISOString(),
        });
      }
    }

    // For other errors, try D1 as a fallback before returning error
    try {
      logQuery.info('AE error, trying D1 fallback', { errorMessage });
      data = await queryUsageFromD1(env.PLATFORM_DB, { period, groupBy, project: projectParam });
      source = 'd1';

      return jsonResponse({
        success: true,
        data,
        meta: {
          period,
          groupBy,
          project: projectParam ?? 'all',
          rowCount: data.length,
          queryTimeMs: Date.now() - startTime,
          source,
        },
        note: 'Data from D1 daily_usage_rollups (Analytics Engine unavailable)',
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Both AE and D1 failed
      return jsonResponse(
        {
          success: false,
          error: 'Failed to query usage data',
          code: 'QUERY_ERROR',
          message: errorMessage,
        },
        500
      );
    }
  }
}

/**
 * Handle GET /usage/features/circuit-breakers
 *
 * Returns all feature-level circuit breaker states from KV.
 */
export async function handleGetFeatureCircuitBreakers(env: Env): Promise<Response> {
  const startTime = Date.now();

  try {
    // List all FEATURE:* keys from KV
    const { keys } = await env.PLATFORM_CACHE.list({ prefix: 'FEATURE:' });

    // Group by feature key
    const features: Record<
      string,
      { enabled?: boolean; disabledReason?: string; disabledAt?: string; autoResetAt?: string }
    > = {};

    for (const key of keys) {
      // Parse key: FEATURE:{project}:{category}:{feature}:{field}
      const match = key.name.match(/^FEATURE:([^:]+:[^:]+:[^:]+):(.+)$/);
      if (match) {
        const [, featureKey, field] = match;
        if (!features[featureKey]) features[featureKey] = {};

        const value = await env.PLATFORM_CACHE.get(key.name);
        if (field === 'enabled') features[featureKey].enabled = value !== 'false';
        if (field === 'disabled_reason') features[featureKey].disabledReason = value ?? undefined;
        if (field === 'disabled_at') features[featureKey].disabledAt = value ?? undefined;
        if (field === 'auto_reset_at') features[featureKey].autoResetAt = value ?? undefined;
      }
    }

    return jsonResponse({
      success: true,
      circuitBreakers: features,
      timestamp: new Date().toISOString(),
      responseTimeMs: Date.now() - startTime,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:features');
    log.error('Error fetching circuit breakers', error instanceof Error ? error : undefined, {
      tag: 'CB_FETCH_ERROR',
      errorMessage,
    });

    return jsonResponse(
      { success: false, error: 'Failed to fetch circuit breakers', message: errorMessage },
      500
    );
  }
}

/**
 * Handle PUT /usage/features/circuit-breakers
 *
 * Toggle a feature circuit breaker.
 * Body: { featureKey: string, enabled: boolean }
 */
export async function handlePutFeatureCircuitBreakers(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = (await request.json()) as { featureKey?: string; enabled?: boolean };

    if (!body.featureKey) {
      return jsonResponse({ success: false, error: 'Missing featureKey' }, 400);
    }
    if (typeof body.enabled !== 'boolean') {
      return jsonResponse({ success: false, error: 'Missing or invalid enabled (boolean)' }, 400);
    }

    const featureKey = body.featureKey;

    if (body.enabled) {
      // Re-enable: delete all disable-related keys
      await Promise.all([
        env.PLATFORM_CACHE.delete(FEATURE_KV_KEYS.enabled(featureKey)),
        env.PLATFORM_CACHE.delete(FEATURE_KV_KEYS.disabledReason(featureKey)),
        env.PLATFORM_CACHE.delete(FEATURE_KV_KEYS.disabledAt(featureKey)),
        env.PLATFORM_CACHE.delete(FEATURE_KV_KEYS.autoResetAt(featureKey)),
      ]);

      const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:features');
      log.info('Manually enabled feature', { tag: 'FEATURE_ENABLED', featureKey });
    } else {
      // Disable: set enabled=false with manual reason
      const now = new Date().toISOString();
      await Promise.all([
        env.PLATFORM_CACHE.put(FEATURE_KV_KEYS.enabled(featureKey), 'false'),
        env.PLATFORM_CACHE.put(
          FEATURE_KV_KEYS.disabledReason(featureKey),
          'Manually disabled via dashboard'
        ),
        env.PLATFORM_CACHE.put(FEATURE_KV_KEYS.disabledAt(featureKey), now),
        // No auto-reset for manual disables
        env.PLATFORM_CACHE.delete(FEATURE_KV_KEYS.autoResetAt(featureKey)),
      ]);

      const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:features');
      log.info('Manually disabled feature', { tag: 'FEATURE_DISABLED', featureKey });
    }

    return jsonResponse({
      success: true,
      featureKey,
      enabled: body.enabled,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:features');
    log.error('Error toggling circuit breaker', error instanceof Error ? error : undefined, {
      tag: 'CB_TOGGLE_ERROR',
      errorMessage,
    });

    return jsonResponse(
      { success: false, error: 'Failed to toggle circuit breaker', message: errorMessage },
      500
    );
  }
}

/**
 * Handle GET /usage/features/circuit-breaker-events
 *
 * Returns recent circuit breaker events from D1.
 * Query params:
 * - limit: max events to return (default: 50, max: 200)
 * - featureKey: filter by feature key (optional)
 * - eventType: filter by event type: 'trip', 'reset', 'manual_disable', 'manual_enable' (optional)
 */
export async function handleGetCircuitBreakerEvents(url: URL, env: Env): Promise<Response> {
  const startTime = Date.now();

  try {
    const limitParam = url.searchParams.get('limit');
    const limit = Math.min(Math.max(parseInt(limitParam ?? '50', 10) || 50, 1), 200);
    const featureKey = url.searchParams.get('featureKey');
    const eventType = url.searchParams.get('eventType');

    // Build dynamic query based on filters
    let query = `
      SELECT
        id,
        feature_key,
        event_type,
        reason,
        violated_resource,
        current_value,
        budget_limit,
        auto_reset,
        alert_sent,
        datetime(created_at, 'unixepoch') as created_at_iso
      FROM feature_circuit_breaker_events
    `;
    const params: (string | number)[] = [];

    const conditions: string[] = [];
    if (featureKey) {
      conditions.push('feature_key = ?');
      params.push(featureKey);
    }
    if (eventType) {
      conditions.push('event_type = ?');
      params.push(eventType);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }

    query += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    const { results } = await env.PLATFORM_DB.prepare(query)
      .bind(...params)
      .all<{
        id: string;
        feature_key: string;
        event_type: string;
        reason: string | null;
        violated_resource: string | null;
        current_value: number | null;
        budget_limit: number | null;
        auto_reset: number;
        alert_sent: number;
        created_at_iso: string;
      }>();

    // Transform to camelCase
    const events = (results ?? []).map((row) => ({
      id: row.id,
      featureKey: row.feature_key,
      eventType: row.event_type,
      reason: row.reason,
      violatedResource: row.violated_resource,
      currentValue: row.current_value,
      budgetLimit: row.budget_limit,
      autoReset: row.auto_reset === 1,
      alertSent: row.alert_sent === 1,
      createdAt: row.created_at_iso,
    }));

    const duration = Date.now() - startTime;
    const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:features');
    log.info('Fetched circuit breaker events', {
      tag: 'CB_EVENTS_FETCHED',
      eventCount: events.length,
      durationMs: duration,
    });

    return jsonResponse({
      success: true,
      events,
      count: events.length,
      limit,
      filters: { featureKey, eventType },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:features');
    log.error('Error fetching circuit breaker events', error instanceof Error ? error : undefined, {
      tag: 'CB_EVENTS_ERROR',
      errorMessage,
    });

    return jsonResponse(
      { success: false, error: 'Failed to fetch circuit breaker events', message: errorMessage },
      500
    );
  }
}

/**
 * Handle GET /usage/features/budgets
 *
 * Returns the feature budgets configuration.
 * Primary: KV FEATURE_KV_KEYS.BUDGETS
 * Fallback: Build from feature_registry.daily_limits_json
 */
export async function handleGetFeatureBudgets(env: Env): Promise<Response> {
  const startTime = Date.now();

  try {
    const budgetsJson = await env.PLATFORM_CACHE.get(FEATURE_KV_KEYS.BUDGETS);

    if (budgetsJson) {
      const budgets = JSON.parse(budgetsJson);
      return jsonResponse({
        success: true,
        budgets,
        source: 'kv',
        timestamp: new Date().toISOString(),
        responseTimeMs: Date.now() - startTime,
      });
    }

    // =========================================================================
    // Fallback: Build budgets from feature_registry if KV is empty
    // =========================================================================
    const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:features');
    log.info('KV budgets empty, building from feature_registry', { tag: 'BUDGETS_FALLBACK' });

    // Default budget limits (match budgets.yaml defaults)
    const defaults: Record<string, { hourly: number; daily?: number }> = {
      d1Writes: { hourly: 10000, daily: 100000 },
      d1Reads: { hourly: 100000, daily: 1000000 },
      kvReads: { hourly: 50000, daily: 500000 },
      kvWrites: { hourly: 5000, daily: 50000 },
      requests: { hourly: 50000, daily: 500000 },
    };

    const features: Record<string, Record<string, { hourly?: number; daily?: number }>> = {};

    try {
      const registryResult = await env.PLATFORM_DB.prepare(
        `
        SELECT feature_key, daily_limits_json
        FROM feature_registry
        WHERE daily_limits_json IS NOT NULL
      `
      ).all();

      for (const row of registryResult.results ?? []) {
        const featureKey = row.feature_key as string;
        const limitsJson = row.daily_limits_json as string;
        if (limitsJson) {
          try {
            const limits = JSON.parse(limitsJson);
            // Transform daily_limits_json format to budgets format
            // Registry format: { d1_writes: 5000, kv_reads: 10000, ... }
            // Budgets format: { d1Writes: { hourly: 5000 }, ... }
            const featureBudget: Record<string, { hourly?: number; daily?: number }> = {};
            for (const [key, value] of Object.entries(limits)) {
              // Convert snake_case to camelCase
              const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
              if (typeof value === 'number') {
                featureBudget[camelKey] = { hourly: value };
              } else if (typeof value === 'object' && value !== null) {
                featureBudget[camelKey] = value as { hourly?: number; daily?: number };
              }
            }
            if (Object.keys(featureBudget).length > 0) {
              features[featureKey] = featureBudget;
            }
          } catch {
            log.warn('Invalid JSON in daily_limits_json', undefined, {
              tag: 'INVALID_LIMITS_JSON',
              featureKey,
            });
          }
        }
      }

      log.info('Built budgets from registry', {
        tag: 'BUDGETS_BUILT',
        featureCount: Object.keys(features).length,
      });
    } catch (err) {
      log.warn('Could not query feature_registry for budgets', undefined, {
        tag: 'REGISTRY_QUERY_ERROR',
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const budgets = { _defaults: defaults, features };

    return jsonResponse({
      success: true,
      budgets,
      source: 'registry',
      timestamp: new Date().toISOString(),
      responseTimeMs: Date.now() - startTime,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const logErr = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:features');
    logErr.error('Error fetching budgets', error instanceof Error ? error : undefined, {
      tag: 'BUDGETS_FETCH_ERROR',
      errorMessage,
    });

    return jsonResponse(
      { success: false, error: 'Failed to fetch budgets', message: errorMessage },
      500
    );
  }
}

/**
 * Handle PUT /usage/features/budgets
 *
 * Updates the feature budgets configuration in KV.
 * Body: { _defaults: {...}, features: {...} }
 */
export async function handlePutFeatureBudgets(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json()) as {
      _defaults?: Record<string, { hourly?: number; daily?: number }>;
      features?: Record<string, Record<string, { hourly?: number; daily?: number }>>;
    };

    // Validate structure
    if (!body._defaults && !body.features) {
      return jsonResponse(
        { success: false, error: 'Body must contain _defaults or features' },
        400
      );
    }

    // Load existing budgets to merge
    const existingJson = await env.PLATFORM_CACHE.get(FEATURE_KV_KEYS.BUDGETS);
    const existing = existingJson ? JSON.parse(existingJson) : { _defaults: {}, features: {} };

    // Merge updates
    const updated = {
      _defaults: body._defaults ?? existing._defaults,
      features: body.features ? { ...existing.features, ...body.features } : existing.features,
    };

    // Save to KV
    await env.PLATFORM_CACHE.put(FEATURE_KV_KEYS.BUDGETS, JSON.stringify(updated));

    const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:features');
    log.info('Updated budgets config', { tag: 'BUDGETS_UPDATED' });

    return jsonResponse({
      success: true,
      budgets: updated,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:features');
    log.error('Error updating budgets', error instanceof Error ? error : undefined, {
      tag: 'BUDGETS_UPDATE_ERROR',
      errorMessage,
    });

    return jsonResponse(
      { success: false, error: 'Failed to update budgets', message: errorMessage },
      500
    );
  }
}

/**
 * Handle GET /usage/features/history
 *
 * Returns historical feature usage data from D1 for sparkline charts.
 * Query params:
 * - days: number of days (default: 7, max: 90)
 * - featureKey: optional, filter by feature key
 */
export async function handleGetFeatureHistory(url: URL, env: Env): Promise<Response> {
  const startTime = Date.now();

  try {
    // Parse query params
    const daysParam = url.searchParams.get('days');
    const days = Math.min(Math.max(parseInt(daysParam ?? '7', 10) || 7, 1), 90);
    const featureKey = url.searchParams.get('featureKey');

    // Calculate date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setUTCDate(startDate.getUTCDate() - days);

    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];

    // Build query
    let query = `
      SELECT
        feature_key,
        usage_date,
        d1_writes,
        d1_reads,
        kv_reads,
        kv_writes,
        do_requests,
        do_gb_seconds,
        r2_class_a,
        r2_class_b,
        ai_neurons,
        queue_messages,
        requests,
        times_disabled
      FROM feature_usage_daily
      WHERE usage_date >= ? AND usage_date <= ?
    `;

    const params: (string | number)[] = [startDateStr, endDateStr];

    if (featureKey) {
      query += ' AND feature_key = ?';
      params.push(featureKey);
    }

    query += ' ORDER BY feature_key, usage_date ASC';

    const result = await env.PLATFORM_DB.prepare(query)
      .bind(...params)
      .all();

    if (!result.success) {
      throw new Error('D1 query failed');
    }

    // Group by feature_key for sparkline data
    const byFeature: Record<
      string,
      Array<{
        date: string;
        d1Writes: number;
        d1Reads: number;
        kvReads: number;
        kvWrites: number;
        doRequests: number;
        doGbSeconds: number;
        r2ClassA: number;
        r2ClassB: number;
        aiNeurons: number;
        queueMessages: number;
        requests: number;
        timesDisabled: number;
      }>
    > = {};

    for (const row of result.results ?? []) {
      const key = row.feature_key as string;
      if (!byFeature[key]) byFeature[key] = [];

      byFeature[key].push({
        date: row.usage_date as string,
        d1Writes: row.d1_writes as number,
        d1Reads: row.d1_reads as number,
        kvReads: row.kv_reads as number,
        kvWrites: row.kv_writes as number,
        doRequests: row.do_requests as number,
        doGbSeconds: row.do_gb_seconds as number,
        r2ClassA: row.r2_class_a as number,
        r2ClassB: row.r2_class_b as number,
        aiNeurons: row.ai_neurons as number,
        queueMessages: row.queue_messages as number,
        requests: row.requests as number,
        timesDisabled: row.times_disabled as number,
      });
    }

    return jsonResponse({
      success: true,
      days,
      startDate: startDateStr,
      endDate: endDateStr,
      features: byFeature,
      timestamp: new Date().toISOString(),
      responseTimeMs: Date.now() - startTime,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:features');
    log.error('Error fetching history', error instanceof Error ? error : undefined, {
      tag: 'HISTORY_FETCH_ERROR',
      errorMessage,
    });

    return jsonResponse(
      { success: false, error: 'Failed to fetch history', message: errorMessage },
      500
    );
  }
}

/**
 * Handle GET /usage/workersai
 *
 * Returns Workers AI usage metrics from Analytics Engine.
 * Aggregates data from all registered projects.
 *
 * Query params:
 * - period: '24h' | '7d' | '30d' (default: '7d')
 */
export async function handleWorkersAI(url: URL, env: Env): Promise<Response> {
  const startTime = Date.now();
  const { period } = parseQueryParams(url);
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:workersai');

  // Use 15-minute cache (shorter than main usage cache since AI usage changes more frequently)
  const cacheKey = `workersai:${period}:${Math.floor(Date.now() / 900000)}`;

  // Check cache first
  try {
    const cached = (await env.PLATFORM_CACHE.get(cacheKey, 'json')) as WorkersAIResponse | null;
    if (cached) {
      log.info('Workers AI cache hit', { tag: 'CACHE_HIT', cacheKey });
      return jsonResponse({
        ...cached,
        cached: true,
        responseTimeMs: Date.now() - startTime,
      });
    }
  } catch (error) {
    log.error('Workers AI cache read error', error instanceof Error ? error : undefined, {
      tag: 'CACHE_READ_ERROR',
      cacheKey,
    });
  }

  log.info('Workers AI cache miss, fetching from Analytics Engine', {
    tag: 'CACHE_MISS',
    cacheKey,
  });

  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
    return jsonResponse(
      {
        success: false,
        error: 'Configuration Error',
        message: 'Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN',
      },
      500
    );
  }

  try {
    // Fetch Workers AI metrics from Analytics Engine AND AI Gateway data from D1 in parallel
    const client = new CloudflareGraphQL(env);
    const [metrics, aiGatewayData] = await Promise.all([
      client.getWorkersAIMetrics(period),
      queryAIGatewayMetrics(env, period),
    ]);

    // Merge AI Gateway data into the response if available
    const metricsWithGateway: WorkersAISummary = {
      ...metrics,
      aiGateway: aiGatewayData ?? undefined,
    };

    const response: WorkersAIResponse = {
      success: true,
      period,
      data: metricsWithGateway,
      cached: false,
      timestamp: new Date().toISOString(),
    };

    // Cache for 15 minutes
    try {
      await env.PLATFORM_CACHE.put(cacheKey, JSON.stringify(response), { expirationTtl: 900 });
      log.info('Workers AI cached response', { tag: 'CACHE_WRITE', cacheKey });
    } catch (error) {
      log.error('Workers AI cache write error', error instanceof Error ? error : undefined, {
        tag: 'CACHE_WRITE_ERROR',
        cacheKey,
      });
    }

    const duration = Date.now() - startTime;
    log.info('Workers AI data fetched', {
      tag: 'DATA_FETCHED',
      durationMs: duration,
      hasAiGateway: !!aiGatewayData,
    });

    return jsonResponse({
      ...response,
      responseTimeMs: duration,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('Error fetching Workers AI metrics', error instanceof Error ? error : undefined, {
      tag: 'WORKERSAI_ERROR',
      errorMessage,
    });

    return jsonResponse(
      {
        success: false,
        error: 'Failed to fetch Workers AI metrics',
        message: errorMessage,
      },
      500
    );
  }
}
