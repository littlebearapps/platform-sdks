/**
 * Usage Admin Handlers
 *
 * Administrative handlers for circuit breaker management and data backfill.
 * Extracted from platform-usage.ts as part of handler modularisation.
 */

import type { Env, SamplingMode, DailyUsageMetrics } from '../shared';
import { SamplingMode as SamplingModeEnum, CB_KEYS, jsonResponse } from '../shared';
import { createLoggerFromEnv } from '@littlebearapps/platform-consumer-sdk';
import { CloudflareGraphQL, calculateDailyCosts } from '../../shared/cloudflare';

// =============================================================================
// RESET CIRCUIT BREAKER HANDLER
// =============================================================================

/**
 * Handle POST /usage/reset-circuit-breaker
 *
 * Manually resets circuit breaker state for any or all projects.
 * This allows immediate recovery after fixing issues, without waiting
 * for the 24-hour KV expiration.
 *
 * Request body:
 * - service: string - project ID to reset, or 'all' (default: 'all')
 * - resetSampling: boolean (default: true) - also reset platform-usage sampling to FULL
 */
export async function handleResetCircuitBreaker(request: Request, env: Env): Promise<Response> {
  const startTime = Date.now();

  try {
    const body = (await request.json().catch(() => ({}))) as {
      service?: string;
      resetSampling?: boolean;
    };

    const service = body.service ?? 'all';
    const resetSampling = body.resetSampling !== false; // Default true

    const resetActions: string[] = [];

    // Get registered projects from D1 to reset their circuit breakers
    // TODO: Populate project_registry with your projects, or hardcode project IDs here.
    const projectRows = await env.PLATFORM_DB.prepare(
      `SELECT project_id FROM project_registry WHERE project_id != 'all'`
    ).all<{ project_id: string }>();

    const registeredProjects = projectRows.results?.map((r) => r.project_id) ?? ['platform'];

    for (const projectId of registeredProjects) {
      if (service === projectId || service === 'all') {
        const cbKey = `PROJECT:${projectId.toUpperCase().replace(/-/g, '-')}:STATUS`;
        await env.PLATFORM_CACHE.delete(cbKey);
        resetActions.push(projectId);
      }
    }

    // Optionally reset platform-usage sampling mode to FULL
    if (resetSampling) {
      await env.PLATFORM_CACHE.put(CB_KEYS.USAGE_SAMPLING_MODE, SamplingModeEnum.FULL.toString());
      resetActions.push('sampling-mode');
    }

    // Log the reset event to D1 for audit trail
    try {
      const resetId = `cb-reset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await env.PLATFORM_DB.prepare(
        `
        INSERT INTO circuit_breaker_logs (id, event_type, service, reason, sampling_mode, created_at)
        VALUES (?, 'reset', ?, ?, ?, unixepoch())
      `
      )
        .bind(
          resetId,
          service,
          `Manual reset via API (services: ${resetActions.join(', ')})`,
          resetSampling ? 'FULL' : null
        )
        .run();
    } catch {
      // Don't fail the reset if logging fails
    }

    // Circuit breaker reset completed

    return jsonResponse({
      success: true,
      message: 'Circuit breaker(s) reset successfully',
      reset: resetActions,
      timestamp: new Date().toISOString(),
      responseTimeMs: Date.now() - startTime,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // Error resetting circuit breaker

    return jsonResponse(
      {
        success: false,
        error: 'Failed to reset circuit breaker',
        message: errorMessage,
      },
      500
    );
  }
}

// =============================================================================
// BACKFILL HANDLER
// =============================================================================

/**
 * Handle POST /usage/backfill
 *
 * Backfills daily_usage_rollups from Cloudflare GraphQL for historical data.
 * Required because the worker was just deployed and D1 tables are empty.
 *
 * Query params:
 * - startDate: YYYY-MM-DD (required)
 * - endDate: YYYY-MM-DD (required)
 *
 * Note: Cloudflare GraphQL supports up to 90 days lookback.
 */
export async function handleBackfill(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const startDateStr = url.searchParams.get('startDate');
  const endDateStr = url.searchParams.get('endDate');

  // Validate required params
  if (!startDateStr || !endDateStr) {
    return jsonResponse(
      { error: 'Missing required params: startDate and endDate (YYYY-MM-DD)' },
      400
    );
  }

  // Validate date format
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(startDateStr) || !dateRegex.test(endDateStr)) {
    return jsonResponse({ error: 'Invalid date format. Use YYYY-MM-DD.' }, 400);
  }

  const startDate = new Date(startDateStr);
  const endDate = new Date(endDateStr);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return jsonResponse({ error: 'Invalid date values' }, 400);
  }

  if (startDate > endDate) {
    return jsonResponse({ error: 'startDate must be before endDate' }, 400);
  }

  // Check max range (90 days - Cloudflare API limit)
  const daysDiff = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
  if (daysDiff > 90) {
    return jsonResponse(
      { error: `Date range too large: ${daysDiff} days. Maximum is 90 days.` },
      400
    );
  }

  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:backfill');
  log.info('Starting backfill', {
    startDate: startDateStr,
    endDate: endDateStr,
    days: daysDiff + 1,
  });

  // Create GraphQL client
  const client = new CloudflareGraphQL({
    CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
  });

  const results: Array<{ date: string; status: string; error?: string }> = [];
  let successCount = 0;
  let errorCount = 0;

  // Process each day
  const currentDate = new Date(startDate);
  while (currentDate <= endDate) {
    const dateStr = currentDate.toISOString().split('T')[0];

    try {
      // For single-day queries, Cloudflare GraphQL requires endDate > startDate
      // (date_leq appears to be exclusive). Use next day as endDate.
      const nextDay = new Date(currentDate);
      nextDay.setDate(nextDay.getDate() + 1);
      const nextDayStr = nextDay.toISOString().split('T')[0];

      log.info('Processing', { date: dateStr, queryRange: `${dateStr} to ${nextDayStr}` });

      // Fetch metrics from Cloudflare GraphQL for this single day
      const metrics = await client.getMetricsForDateRange({
        startDate: dateStr,
        endDate: nextDayStr,
      });

      // DEBUG: Log raw metrics structure to diagnose empty results
      log.info('Raw metrics', {
        date: dateStr,
        workersCount: metrics.workers?.length ?? 'undefined',
        d1Count: metrics.d1?.length ?? 'undefined',
        kvCount: metrics.kv?.length ?? 'undefined',
        r2Count: metrics.r2?.length ?? 'undefined',
        doExists: metrics.durableObjects ? 'yes' : 'no',
        vectorizeCount: metrics.vectorize?.length ?? 'undefined',
        aiGatewayCount: metrics.aiGateway?.length ?? 'undefined',
        pagesCount: metrics.pages?.length ?? 'undefined',
        firstWorker: metrics.workers?.[0]
          ? { name: metrics.workers[0].scriptName, requests: metrics.workers[0].requests }
          : 'none',
        doData: metrics.durableObjects
          ? {
              requests: metrics.durableObjects.requests,
              gbSeconds: metrics.durableObjects.gbSeconds,
            }
          : 'none',
      });

      // Aggregate Workers metrics
      const workersRequests = metrics.workers.reduce((sum, w) => sum + w.requests, 0);
      const workersErrors = metrics.workers.reduce((sum, w) => sum + w.errors, 0);
      const workersCpuTimeMs = metrics.workers.reduce((sum, w) => sum + w.cpuTimeMs, 0);
      const workersDurationP50 =
        metrics.workers.length > 0
          ? metrics.workers.reduce((sum, w) => sum + w.duration50thMs, 0) / metrics.workers.length
          : 0;
      const workersDurationP99 =
        metrics.workers.length > 0 ? Math.max(...metrics.workers.map((w) => w.duration99thMs)) : 0;

      // Aggregate D1 metrics
      const d1RowsRead = metrics.d1.reduce((sum, d) => sum + d.rowsRead, 0);
      const d1RowsWritten = metrics.d1.reduce((sum, d) => sum + d.rowsWritten, 0);

      // Aggregate KV metrics
      const kvReads = metrics.kv.reduce((sum, k) => sum + k.reads, 0);
      const kvWrites = metrics.kv.reduce((sum, k) => sum + k.writes, 0);
      const kvDeletes = metrics.kv.reduce((sum, k) => sum + k.deletes, 0);
      const kvLists = metrics.kv.reduce((sum, k) => sum + k.lists, 0);

      // Aggregate R2 metrics
      const r2ClassA = metrics.r2.reduce((sum, r) => sum + r.classAOperations, 0);
      const r2ClassB = metrics.r2.reduce((sum, r) => sum + r.classBOperations, 0);
      const r2StorageBytes = metrics.r2.reduce((sum, r) => sum + r.storageBytes, 0);
      const r2EgressBytes = metrics.r2.reduce((sum, r) => sum + r.egressBytes, 0);

      // Durable Objects metrics (single object, not array)
      const doRequests = metrics.durableObjects.requests ?? 0;
      const doGbSeconds = metrics.durableObjects.gbSeconds ?? 0;

      // Vectorize metrics
      // Note: VectorizeInfo from REST API doesn't include query counts
      // Query counts are collected via GraphQL (vectorizeV2QueriesAdaptiveGroups) in the scheduled cron
      const vectorizeQueries = 0; // Query data comes from hourly collection, not available in daily endpoint

      // AI Gateway metrics (array - aggregate all gateways)
      const aiGatewayRequests = metrics.aiGateway.reduce(
        (sum, g) => sum + (g.totalRequests ?? 0),
        0
      );
      const aiGatewayTokensIn = metrics.aiGateway.reduce((sum, g) => sum + (g.totalTokens ?? 0), 0);
      const aiGatewayTokensOut = 0; // Not available in AIGatewayMetrics interface
      const aiGatewayCachedRequests = metrics.aiGateway.reduce(
        (sum, g) => sum + (g.cachedRequests ?? 0),
        0
      );

      // Pages metrics (array - aggregate all projects)
      const pagesDeployments = metrics.pages.reduce((sum, p) => sum + (p.totalBuilds ?? 0), 0);
      const pagesBandwidth = 0; // Bandwidth not in PagesMetrics interface

      // Calculate costs using the shared cost calculation function
      const usage: DailyUsageMetrics = {
        workersRequests,
        workersCpuMs: workersCpuTimeMs,
        d1Reads: d1RowsRead,
        d1Writes: d1RowsWritten,
        kvReads,
        kvWrites,
        kvDeletes,
        kvLists,
        r2ClassA,
        r2ClassB,
        vectorizeQueries,
        aiGatewayRequests,
        durableObjectsRequests: doRequests,
        durableObjectsGbSeconds: doGbSeconds,
      };

      const costs = calculateDailyCosts(usage);

      // DEBUG: Log aggregated values before D1 insert
      log.info('Aggregated values', {
        date: dateStr,
        workersRequests,
        workersErrors,
        d1RowsRead,
        d1RowsWritten,
        kvReads,
        doRequests,
        doGbSeconds,
        totalCost: costs.total,
      });

      // Insert into daily_usage_rollups
      await env.PLATFORM_DB.prepare(
        `
        INSERT OR REPLACE INTO daily_usage_rollups (
          snapshot_date, project,
          workers_requests, workers_errors, workers_cpu_time_ms,
          workers_duration_p50_ms_avg, workers_duration_p99_ms_max, workers_cost_usd,
          d1_rows_read, d1_rows_written, d1_storage_bytes_max, d1_cost_usd,
          kv_reads, kv_writes, kv_deletes, kv_list_ops, kv_storage_bytes_max, kv_cost_usd,
          r2_class_a_ops, r2_class_b_ops, r2_storage_bytes_max, r2_egress_bytes, r2_cost_usd,
          do_requests, do_gb_seconds, do_websocket_connections, do_storage_reads,
          do_storage_writes, do_storage_deletes, do_cost_usd,
          vectorize_queries, vectorize_vectors_stored_max, vectorize_cost_usd,
          aigateway_requests, aigateway_tokens_in, aigateway_tokens_out,
          aigateway_cached_requests, aigateway_cost_usd,
          pages_deployments, pages_bandwidth_bytes, pages_cost_usd,
          queues_messages_produced, queues_messages_consumed, queues_cost_usd,
          workersai_requests, workersai_neurons, workersai_cost_usd,
          workflows_executions, workflows_successes, workflows_failures,
          workflows_wall_time_ms, workflows_cpu_time_ms, workflows_cost_usd,
          total_cost_usd, samples_count, rollup_version
        ) VALUES (
          ?, 'all',
          ?, ?, ?,
          ?, ?, ?,
          ?, ?, 0, ?,
          ?, ?, ?, ?, 0, ?,
          ?, ?, ?, ?, ?,
          ?, ?, 0, 0, 0, 0, ?,
          ?, 0, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?,
          0, 0, ?,
          0, 0, ?,
          0, 0, 0, 0, 0, 0,
          ?, 24, 2
        )
      `
      )
        .bind(
          dateStr,
          // Workers
          workersRequests,
          workersErrors,
          workersCpuTimeMs,
          workersDurationP50,
          workersDurationP99,
          costs.workers,
          // D1
          d1RowsRead,
          d1RowsWritten,
          costs.d1,
          // KV
          kvReads,
          kvWrites,
          kvDeletes,
          kvLists,
          costs.kv,
          // R2
          r2ClassA,
          r2ClassB,
          r2StorageBytes,
          r2EgressBytes,
          costs.r2,
          // DO
          doRequests,
          doGbSeconds,
          costs.durableObjects,
          // Vectorize
          vectorizeQueries,
          costs.vectorize,
          // AI Gateway
          aiGatewayRequests,
          aiGatewayTokensIn,
          aiGatewayTokensOut,
          aiGatewayCachedRequests,
          costs.aiGateway,
          // Pages
          pagesDeployments,
          pagesBandwidth,
          0, // Pages cost is always 0 on paid plan
          // Queues
          costs.queues,
          // Workers AI
          costs.workersAI,
          // Total
          costs.total
        )
        .run();

      results.push({ date: dateStr, status: 'ok' });
      successCount++;
      log.info('Backfill success', { date: dateStr, totalCost: costs.total });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      results.push({ date: dateStr, status: 'error', error: errorMsg });
      errorCount++;
      log.error(`Backfill error for ${dateStr}: ${errorMsg}`);
    }

    // Move to next day
    currentDate.setDate(currentDate.getDate() + 1);
  }

  log.info('Backfill complete', { success: successCount, errors: errorCount });

  return jsonResponse({
    success: errorCount === 0,
    message: `Backfilled ${successCount} days (${errorCount} errors)`,
    backfilled: successCount,
    errors: errorCount,
    dateRange: { start: startDateStr, end: endDateStr },
    results,
  });
}
