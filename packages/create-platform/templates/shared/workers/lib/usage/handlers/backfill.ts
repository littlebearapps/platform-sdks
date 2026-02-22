/**
 * Backfill Handler for Platform Usage
 *
 * Provides endpoints for:
 * - GET /usage/gaps - Current gap status
 * - GET /usage/gaps/history - Gap detection history
 * - POST /usage/gaps/backfill - Trigger backfill for date range
 *
 * @module workers/lib/usage/handlers/backfill
 * @created 2026-01-29
 */

import type { D1Database, KVNamespace } from '@cloudflare/workers-types';
import { PRICING_TIERS } from '@littlebearapps/platform-sdk';

/**
 * Environment bindings required for backfill
 */
export interface BackfillEnv {
  PLATFORM_DB: D1Database;
  PLATFORM_CACHE: KVNamespace;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN?: string;
}

/**
 * Backfill request payload
 */
export interface BackfillRequest {
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  projects?: string[]; // Specific projects or all
  dryRun?: boolean; // Preview without writing
}

/**
 * Backfill result
 */
export interface BackfillResult {
  id: string;
  startDate: string;
  endDate: string;
  projects: string[];
  hoursProcessed: number;
  hoursCreated: number;
  hoursUpdated: number;
  errors: Array<{ hour: string; project: string; error: string }>;
  averageConfidence: number;
  status: 'completed' | 'failed';
  dryRun: boolean;
}

/**
 * Gap status response
 */
export interface GapStatus {
  currentStatus: 'ok' | 'warning' | 'critical';
  lastCheck: string | null;
  missingHoursLast24h: number;
  staleProjects: string[];
  recentGaps: Array<{
    detectionTime: string;
    missingHours: number;
    staleProjects: number;
    severity: string;
  }>;
}

/**
 * Handle GET /usage/gaps - Current gap status
 */
export async function handleGapsStatus(env: BackfillEnv): Promise<Response> {
  try {
    // Get latest gap detection result
    const latest = await env.PLATFORM_DB.prepare(
      `
      SELECT detection_time, missing_hours_count, stale_projects_count, severity, report_json
      FROM gap_detection_log
      ORDER BY detection_time DESC
      LIMIT 1
    `
    ).first<{
      detection_time: string;
      missing_hours_count: number;
      stale_projects_count: number;
      severity: string;
      report_json: string;
    }>();

    // Get recent gap events (last 24h)
    const recentResult = await env.PLATFORM_DB.prepare(
      `
      SELECT detection_time, missing_hours_count, stale_projects_count, severity
      FROM gap_detection_log
      WHERE detection_time >= datetime('now', '-24 hours')
        AND severity != 'ok'
      ORDER BY detection_time DESC
      LIMIT 10
    `
    ).all<{
      detection_time: string;
      missing_hours_count: number;
      stale_projects_count: number;
      severity: string;
    }>();

    // Parse stale projects from latest report
    let staleProjects: string[] = [];
    if (latest?.report_json) {
      try {
        const report = JSON.parse(latest.report_json);
        staleProjects = report.staleProjects?.map((p: { project: string }) => p.project) ?? [];
      } catch {
        // Ignore parse errors
      }
    }

    const status: GapStatus = {
      currentStatus: (latest?.severity as 'ok' | 'warning' | 'critical') ?? 'ok',
      lastCheck: latest?.detection_time ?? null,
      missingHoursLast24h: latest?.missing_hours_count ?? 0,
      staleProjects,
      recentGaps:
        recentResult.results?.map((r) => ({
          detectionTime: r.detection_time,
          missingHours: r.missing_hours_count,
          staleProjects: r.stale_projects_count,
          severity: r.severity,
        })) ?? [],
    };

    return new Response(JSON.stringify({ success: true, data: status }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Handle GET /usage/gaps/history - Gap detection history
 */
export async function handleGapsHistory(env: BackfillEnv, url: URL): Promise<Response> {
  try {
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
    const severityFilter = url.searchParams.get('severity'); // 'ok' | 'warning' | 'critical'

    let query = `
      SELECT id, detection_time, missing_hours_count, stale_projects_count, severity
      FROM gap_detection_log
    `;
    const params: (string | number)[] = [];

    if (severityFilter) {
      query += ' WHERE severity = ?';
      params.push(severityFilter);
    }

    query += ' ORDER BY detection_time DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const result = await env.PLATFORM_DB.prepare(query)
      .bind(...params)
      .all<{
        id: string;
        detection_time: string;
        missing_hours_count: number;
        stale_projects_count: number;
        severity: string;
      }>();

    // Get total count
    let countQuery = 'SELECT COUNT(*) as total FROM gap_detection_log';
    if (severityFilter) {
      countQuery += ' WHERE severity = ?';
    }
    const countResult = await env.PLATFORM_DB.prepare(countQuery)
      .bind(...(severityFilter ? [severityFilter] : []))
      .first<{ total: number }>();

    return new Response(
      JSON.stringify({
        success: true,
        data: result.results ?? [],
        pagination: {
          total: countResult?.total ?? 0,
          limit,
          offset,
        },
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Handle POST /usage/gaps/backfill - Trigger backfill
 */
export async function handleGapsBackfill(request: Request, env: BackfillEnv): Promise<Response> {
  try {
    const body = (await request.json()) as BackfillRequest;

    // Validate request
    if (!body.startDate || !body.endDate) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'startDate and endDate are required',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Validate date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(body.startDate) || !dateRegex.test(body.endDate)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Dates must be in YYYY-MM-DD format',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Validate date range (max 30 days)
    const start = new Date(body.startDate);
    const end = new Date(body.endDate);
    const daysDiff = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);

    if (daysDiff < 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'endDate must be after startDate',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    if (daysDiff > 30) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Date range cannot exceed 30 days',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Execute backfill
    const result = await executeBackfill(env, body);

    return new Response(JSON.stringify({ success: true, data: result }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Execute backfill operation
 */
async function executeBackfill(
  env: BackfillEnv,
  options: BackfillRequest
): Promise<BackfillResult> {
  const id = crypto.randomUUID();
  // TODO: Add your project IDs here (must match project_registry in D1)
  const projects = options.projects ?? ['all', 'platform'];

  const result: BackfillResult = {
    id,
    startDate: options.startDate,
    endDate: options.endDate,
    projects,
    hoursProcessed: 0,
    hoursCreated: 0,
    hoursUpdated: 0,
    errors: [],
    averageConfidence: 75,
    status: 'completed',
    dryRun: options.dryRun ?? false,
  };

  // Log backfill start
  if (!options.dryRun) {
    await env.PLATFORM_DB.prepare(
      `
      INSERT INTO backfill_log (id, start_date, end_date, projects, triggered_by, status)
      VALUES (?, ?, ?, ?, 'manual', 'running')
    `
    )
      .bind(id, options.startDate, options.endDate, JSON.stringify(projects))
      .run();
  }

  try {
    // Get existing daily rollup data to use as source
    const dailyData = await env.PLATFORM_DB.prepare(
      `
      SELECT
        snapshot_date,
        project,
        workers_cost_usd,
        d1_cost_usd,
        kv_cost_usd,
        r2_cost_usd,
        do_cost_usd,
        vectorize_cost_usd,
        aigateway_cost_usd,
        pages_cost_usd,
        queues_cost_usd,
        workersai_cost_usd,
        total_cost_usd,
        workers_requests,
        workers_errors,
        workers_cpu_time_ms,
        d1_rows_read,
        d1_rows_written,
        kv_reads,
        kv_writes,
        r2_class_a_ops,
        r2_class_b_ops,
        do_requests,
        do_gb_seconds
      FROM daily_usage_rollups
      WHERE snapshot_date >= ? AND snapshot_date <= ?
        AND project IN (${projects.map(() => '?').join(',')})
      ORDER BY snapshot_date, project
    `
    )
      .bind(options.startDate, options.endDate, ...projects)
      .all();

    // Process each day
    for (const day of dailyData.results ?? []) {
      const date = day.snapshot_date as string;
      const project = day.project as string;

      // Create 24 hourly entries
      for (let hour = 0; hour < 24; hour++) {
        const snapshotHour = `${date}T${hour.toString().padStart(2, '0')}:00:00Z`;
        result.hoursProcessed++;

        try {
          // Check if already exists
          const existing = await env.PLATFORM_DB.prepare(
            `SELECT id, source, confidence FROM hourly_usage_snapshots WHERE snapshot_hour = ? AND project = ?`
          )
            .bind(snapshotHour, project)
            .first<{ id: string; source: string; confidence: number }>();

          // Skip if already exists with higher confidence
          if (existing && existing.confidence >= 75) {
            continue;
          }

          // Calculate hourly values (divide daily by 24)
          const hourlyData = {
            workers_cost_usd: ((day.workers_cost_usd as number) ?? 0) / 24,
            d1_cost_usd: ((day.d1_cost_usd as number) ?? 0) / 24,
            kv_cost_usd: ((day.kv_cost_usd as number) ?? 0) / 24,
            r2_cost_usd: ((day.r2_cost_usd as number) ?? 0) / 24,
            do_cost_usd: ((day.do_cost_usd as number) ?? 0) / 24,
            vectorize_cost_usd: ((day.vectorize_cost_usd as number) ?? 0) / 24,
            aigateway_cost_usd: ((day.aigateway_cost_usd as number) ?? 0) / 24,
            pages_cost_usd: ((day.pages_cost_usd as number) ?? 0) / 24,
            queues_cost_usd: ((day.queues_cost_usd as number) ?? 0) / 24,
            workersai_cost_usd: ((day.workersai_cost_usd as number) ?? 0) / 24,
            total_cost_usd: ((day.total_cost_usd as number) ?? 0) / 24,
            workers_requests: Math.round(((day.workers_requests as number) ?? 0) / 24),
            workers_errors: Math.round(((day.workers_errors as number) ?? 0) / 24),
            workers_cpu_time_ms: Math.round(((day.workers_cpu_time_ms as number) ?? 0) / 24),
            d1_rows_read: Math.round(((day.d1_rows_read as number) ?? 0) / 24),
            d1_rows_written: Math.round(((day.d1_rows_written as number) ?? 0) / 24),
            kv_reads: Math.round(((day.kv_reads as number) ?? 0) / 24),
            kv_writes: Math.round(((day.kv_writes as number) ?? 0) / 24),
            r2_class_a_ops: Math.round(((day.r2_class_a_ops as number) ?? 0) / 24),
            r2_class_b_ops: Math.round(((day.r2_class_b_ops as number) ?? 0) / 24),
            do_requests: Math.round(((day.do_requests as number) ?? 0) / 24),
            do_gb_seconds: ((day.do_gb_seconds as number) ?? 0) / 24,
          };

          if (!options.dryRun) {
            if (existing) {
              // Update existing with backfill data
              await env.PLATFORM_DB.prepare(
                `
                UPDATE hourly_usage_snapshots
                SET
                  workers_cost_usd = ?,
                  d1_cost_usd = ?,
                  kv_cost_usd = ?,
                  r2_cost_usd = ?,
                  do_cost_usd = ?,
                  total_cost_usd = ?,
                  source = 'backfill',
                  confidence = 75,
                  backfill_reason = 'gap_backfill'
                WHERE id = ?
              `
              )
                .bind(
                  hourlyData.workers_cost_usd,
                  hourlyData.d1_cost_usd,
                  hourlyData.kv_cost_usd,
                  hourlyData.r2_cost_usd,
                  hourlyData.do_cost_usd,
                  hourlyData.total_cost_usd,
                  existing.id
                )
                .run();
              result.hoursUpdated++;
            } else {
              // Insert new hourly snapshot
              const newId = crypto.randomUUID();
              await env.PLATFORM_DB.prepare(
                `
                INSERT INTO hourly_usage_snapshots (
                  id, snapshot_hour, project,
                  workers_cost_usd, d1_cost_usd, kv_cost_usd, r2_cost_usd, do_cost_usd,
                  vectorize_cost_usd, aigateway_cost_usd, pages_cost_usd, queues_cost_usd,
                  workersai_cost_usd, total_cost_usd,
                  workers_requests, workers_errors, workers_cpu_time_ms,
                  d1_rows_read, d1_rows_written,
                  kv_reads, kv_writes,
                  r2_class_a_ops, r2_class_b_ops,
                  do_requests, do_gb_seconds,
                  source, confidence, backfill_reason,
                  collection_timestamp, sampling_mode
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'backfill', 75, 'gap_backfill', ?, 'normal')
              `
              )
                .bind(
                  newId,
                  snapshotHour,
                  project,
                  hourlyData.workers_cost_usd,
                  hourlyData.d1_cost_usd,
                  hourlyData.kv_cost_usd,
                  hourlyData.r2_cost_usd,
                  hourlyData.do_cost_usd,
                  hourlyData.vectorize_cost_usd,
                  hourlyData.aigateway_cost_usd,
                  hourlyData.pages_cost_usd,
                  hourlyData.queues_cost_usd,
                  hourlyData.workersai_cost_usd,
                  hourlyData.total_cost_usd,
                  hourlyData.workers_requests,
                  hourlyData.workers_errors,
                  hourlyData.workers_cpu_time_ms,
                  hourlyData.d1_rows_read,
                  hourlyData.d1_rows_written,
                  hourlyData.kv_reads,
                  hourlyData.kv_writes,
                  hourlyData.r2_class_a_ops,
                  hourlyData.r2_class_b_ops,
                  hourlyData.do_requests,
                  hourlyData.do_gb_seconds,
                  new Date().toISOString()
                )
                .run();
              result.hoursCreated++;
            }
          } else {
            // Dry run - just count
            if (existing) {
              result.hoursUpdated++;
            } else {
              result.hoursCreated++;
            }
          }
        } catch (error) {
          result.errors.push({
            hour: snapshotHour,
            project,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }
    }

    // Update backfill log
    if (!options.dryRun) {
      await env.PLATFORM_DB.prepare(
        `
        UPDATE backfill_log
        SET
          hours_processed = ?,
          hours_created = ?,
          hours_updated = ?,
          errors_count = ?,
          errors_json = ?,
          average_confidence = ?,
          status = 'completed',
          completed_at = datetime('now')
        WHERE id = ?
      `
      )
        .bind(
          result.hoursProcessed,
          result.hoursCreated,
          result.hoursUpdated,
          result.errors.length,
          result.errors.length > 0 ? JSON.stringify(result.errors) : null,
          result.averageConfidence,
          id
        )
        .run();
    }
  } catch (error) {
    result.status = 'failed';

    if (!options.dryRun) {
      await env.PLATFORM_DB.prepare(
        `
        UPDATE backfill_log
        SET status = 'failed', completed_at = datetime('now')
        WHERE id = ?
      `
      )
        .bind(id)
        .run();
    }

    throw error;
  }

  return result;
}

/**
 * Handle GET /usage/gaps/backfill/history - Backfill history
 */
export async function handleBackfillHistory(env: BackfillEnv, url: URL): Promise<Response> {
  try {
    const limit = parseInt(url.searchParams.get('limit') ?? '20', 10);
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);

    const result = await env.PLATFORM_DB.prepare(
      `
      SELECT
        id, start_date, end_date, projects,
        hours_processed, hours_created, hours_updated, errors_count,
        average_confidence, triggered_by, status,
        started_at, completed_at
      FROM backfill_log
      ORDER BY started_at DESC
      LIMIT ? OFFSET ?
    `
    )
      .bind(limit, offset)
      .all();

    const countResult = await env.PLATFORM_DB.prepare(
      'SELECT COUNT(*) as total FROM backfill_log'
    ).first<{ total: number }>();

    return new Response(
      JSON.stringify({
        success: true,
        data: result.results ?? [],
        pagination: {
          total: countResult?.total ?? 0,
          limit,
          offset,
        },
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Project health status
 */
export interface ProjectHealth {
  project: string;
  coveragePct: number;
  hoursWithData: number;
  expectedHours: number;
  status: 'healthy' | 'warning' | 'critical';
  lastDataHour: string | null;
  resourceBreakdown?: Array<{
    resourceType: string;
    hoursWithData: number;
    coveragePct: number;
  }>;
}

/**
 * Handle GET /usage/gaps/projects - Per-project health status
 *
 * Returns coverage percentage for ALL projects (not just those below threshold).
 * Used by dashboard to show per-project health scores.
 */
export async function handleProjectsHealth(env: BackfillEnv): Promise<Response> {
  try {
    // Query resource-based coverage per project from resource_usage_snapshots.
    // Measures: how many distinct resources have data in the last 24h vs total known resources.
    // This gives genuinely different numbers per project (each project has different resource counts)
    // unlike hour-based counting which is identical for all
    // because the central collector runs for everyone simultaneously.
    const coverageResult = await env.PLATFORM_DB.prepare(
      `
      WITH recent AS (
        SELECT project, resource_type, resource_id
        FROM resource_usage_snapshots
        WHERE snapshot_hour >= datetime('now', '-24 hours')
          AND project IS NOT NULL
          AND project NOT IN ('unknown', 'all')
      ),
      known AS (
        SELECT project, resource_type, resource_id
        FROM resource_usage_snapshots
        WHERE project IS NOT NULL
          AND project NOT IN ('unknown', 'all')
      )
      SELECT
        k.project,
        COUNT(DISTINCT k.resource_type || ':' || k.resource_id) as expected_resources,
        COUNT(DISTINCT r.resource_type || ':' || r.resource_id) as active_resources,
        ROUND(
          COUNT(DISTINCT r.resource_type || ':' || r.resource_id) * 100.0 /
          MAX(COUNT(DISTINCT k.resource_type || ':' || k.resource_id), 1),
          1
        ) as coverage_pct,
        MAX(r.snapshot_hour) as last_data_hour
      FROM known k
      LEFT JOIN recent r
        ON k.project = r.project
        AND k.resource_type = r.resource_type
        AND k.resource_id = r.resource_id
      GROUP BY k.project
      ORDER BY coverage_pct ASC, k.project ASC
    `
    ).all<{
      project: string;
      expected_resources: number;
      active_resources: number;
      coverage_pct: number;
      last_data_hour: string | null;
    }>();

    const projects: ProjectHealth[] = [];

    for (const row of coverageResult.results ?? []) {
      // Determine status based on coverage percentage
      let status: 'healthy' | 'warning' | 'critical';
      if (row.coverage_pct >= 90) {
        status = 'healthy';
      } else if (row.coverage_pct >= 70) {
        status = 'warning';
      } else {
        status = 'critical';
      }

      // Get resource-level breakdown: distinct resources per type
      let resourceBreakdown: ProjectHealth['resourceBreakdown'];
      try {
        const resourceResult = await env.PLATFORM_DB.prepare(
          `
          WITH recent AS (
            SELECT resource_type, resource_id
            FROM resource_usage_snapshots
            WHERE snapshot_hour >= datetime('now', '-24 hours')
              AND project = ?
          ),
          known AS (
            SELECT resource_type, resource_id
            FROM resource_usage_snapshots
            WHERE project = ?
          )
          SELECT
            k.resource_type,
            COUNT(DISTINCT k.resource_id) as total_resources,
            COUNT(DISTINCT r.resource_id) as active_resources,
            ROUND(
              COUNT(DISTINCT r.resource_id) * 100.0 /
              MAX(COUNT(DISTINCT k.resource_id), 1),
              1
            ) as coverage_pct
          FROM known k
          LEFT JOIN recent r
            ON k.resource_type = r.resource_type
            AND k.resource_id = r.resource_id
          GROUP BY k.resource_type
          ORDER BY coverage_pct ASC
        `
        )
          .bind(row.project, row.project)
          .all<{ resource_type: string; total_resources: number; active_resources: number; coverage_pct: number }>();

        if (resourceResult.results && resourceResult.results.length > 0) {
          resourceBreakdown = resourceResult.results.map((r) => ({
            resourceType: r.resource_type,
            hoursWithData: r.active_resources,
            coveragePct: r.coverage_pct,
          }));
        }
      } catch {
        // Ignore resource breakdown errors
      }

      projects.push({
        project: row.project,
        coveragePct: row.coverage_pct,
        hoursWithData: row.active_resources,
        expectedHours: row.expected_resources,
        status,
        lastDataHour: row.last_data_hour,
        resourceBreakdown,
      });
    }

    // Also get projects from project_registry that may have 0 data
    const registryResult = await env.PLATFORM_DB.prepare(
      `
      SELECT project_id, display_name, status
      FROM project_registry
      WHERE status = 'active'
        AND project_id NOT IN (${projects.map(() => '?').join(',') || "''"})
    `
    )
      .bind(...projects.map((p) => p.project))
      .all<{ project_id: string; display_name: string; status: string }>();

    // Add projects with 0 coverage
    for (const row of registryResult.results ?? []) {
      projects.push({
        project: row.project_id,
        coveragePct: 0,
        hoursWithData: 0,
        expectedHours: 24,
        status: 'critical',
        lastDataHour: null,
      });
    }

    // Sort: critical first, then warning, then healthy
    projects.sort((a, b) => {
      const statusOrder = { critical: 0, warning: 1, healthy: 2 };
      return statusOrder[a.status] - statusOrder[b.status] || a.project.localeCompare(b.project);
    });

    // Calculate summary stats
    const healthyCount = projects.filter((p) => p.status === 'healthy').length;
    const warningCount = projects.filter((p) => p.status === 'warning').length;
    const criticalCount = projects.filter((p) => p.status === 'critical').length;
    const avgCoverage =
      projects.length > 0
        ? Math.round((projects.reduce((sum, p) => sum + p.coveragePct, 0) / projects.length) * 10) /
          10
        : 0;

    return new Response(
      JSON.stringify({
        success: true,
        data: {
          projects,
          summary: {
            total: projects.length,
            healthy: healthyCount,
            warning: warningCount,
            critical: criticalCount,
            averageCoverage: avgCoverage,
          },
        },
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
