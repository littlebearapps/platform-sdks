/**
 * Audit Handlers for platform-usage
 *
 * Provides API endpoints for accessing audit reports.
 * Part of Phase 2 Usage Capture Audit.
 *
 * Endpoints:
 * - GET /usage/audit - Latest comprehensive audit report
 * - GET /usage/audit/history - Comprehensive audit history
 * - GET /usage/audit/attribution - Latest attribution report
 * - GET /usage/audit/features - Latest feature coverage report
 *
 * @module workers/lib/usage/handlers/audit
 * @created 2026-01-29
 */

import type { D1Database, KVNamespace } from '@cloudflare/workers-types';

/**
 * Environment bindings for audit handlers
 */
export interface AuditHandlerEnv {
  PLATFORM_DB: D1Database;
  PLATFORM_CACHE: KVNamespace;
}

/**
 * Handle GET /usage/audit - Get latest comprehensive audit report
 */
export async function handleGetAudit(env: AuditHandlerEnv): Promise<Response> {
  try {
    const result = await env.PLATFORM_DB.prepare(
      `
      SELECT report_json, generated_at
      FROM comprehensive_audit_reports
      ORDER BY generated_at DESC
      LIMIT 1
    `
    ).first<{ report_json: string; generated_at: string }>();

    if (!result) {
      return Response.json(
        {
          success: false,
          error: 'No comprehensive audit reports found',
          message: 'Run platform-auditor to generate a report',
        },
        { status: 404 }
      );
    }

    const report = JSON.parse(result.report_json);

    return Response.json({
      success: true,
      data: report,
      generatedAt: result.generated_at,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json(
      { success: false, error: 'Failed to get audit report', message },
      { status: 500 }
    );
  }
}

/**
 * Handle GET /usage/audit/history - Get comprehensive audit history
 */
export async function handleGetAuditHistory(
  request: Request,
  env: AuditHandlerEnv
): Promise<Response> {
  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get('limit') || '10', 10);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  try {
    const result = await env.PLATFORM_DB.prepare(
      `
      SELECT
        id,
        generated_at,
        gap_events_count,
        total_missing_hours,
        average_gap_severity,
        total_resources,
        attributed_count,
        unattributed_count,
        defined_features_count,
        active_features_count,
        dormant_features_count,
        undefined_features_count,
        ai_judge_avg_score,
        action_items_count,
        critical_items_count
      FROM comprehensive_audit_reports
      ORDER BY generated_at DESC
      LIMIT ? OFFSET ?
    `
    )
      .bind(limit, offset)
      .all<{
        id: string;
        generated_at: string;
        gap_events_count: number;
        total_missing_hours: number;
        average_gap_severity: string;
        total_resources: number;
        attributed_count: number;
        unattributed_count: number;
        defined_features_count: number;
        active_features_count: number;
        dormant_features_count: number;
        undefined_features_count: number;
        ai_judge_avg_score: number | null;
        action_items_count: number;
        critical_items_count: number;
      }>();

    // Get total count
    const countResult = await env.PLATFORM_DB.prepare(
      `SELECT COUNT(*) as count FROM comprehensive_audit_reports`
    ).first<{ count: number }>();

    return Response.json({
      success: true,
      data: result.results ?? [],
      pagination: {
        limit,
        offset,
        total: countResult?.count ?? 0,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json(
      { success: false, error: 'Failed to get audit history', message },
      { status: 500 }
    );
  }
}

/**
 * Handle GET /usage/audit/attribution - Get latest attribution report
 */
export async function handleGetAttribution(env: AuditHandlerEnv): Promise<Response> {
  try {
    const result = await env.PLATFORM_DB.prepare(
      `
      SELECT
        id,
        discovery_time,
        total_resources,
        attributed_count,
        unattributed_count,
        report_json
      FROM attribution_reports
      ORDER BY discovery_time DESC
      LIMIT 1
    `
    ).first<{
      id: string;
      discovery_time: string;
      total_resources: number;
      attributed_count: number;
      unattributed_count: number;
      report_json: string;
    }>();

    if (!result) {
      return Response.json(
        {
          success: false,
          error: 'No attribution reports found',
          message: 'platform-mapper has not yet run or attribution checking is not enabled',
        },
        { status: 404 }
      );
    }

    const report = JSON.parse(result.report_json);

    return Response.json({
      success: true,
      data: {
        id: result.id,
        discoveryTime: result.discovery_time,
        summary: {
          totalResources: result.total_resources,
          attributedCount: result.attributed_count,
          unattributedCount: result.unattributed_count,
          attributionRate:
            result.total_resources > 0
              ? Math.round((result.attributed_count / result.total_resources) * 100)
              : 100,
        },
        unattributed: report.unattributed ?? [],
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json(
      { success: false, error: 'Failed to get attribution report', message },
      { status: 500 }
    );
  }
}

/**
 * Handle GET /usage/audit/features - Get latest feature coverage report
 */
export async function handleGetFeatureCoverage(
  request: Request,
  env: AuditHandlerEnv
): Promise<Response> {
  const url = new URL(request.url);
  const project = url.searchParams.get('project');
  const status = url.searchParams.get('status');

  try {
    // Get latest audit time
    const latestResult = await env.PLATFORM_DB.prepare(
      `SELECT MAX(audit_time) as latest FROM feature_coverage_audit`
    ).first<{ latest: string | null }>();

    if (!latestResult?.latest) {
      return Response.json(
        {
          success: false,
          error: 'No feature coverage audits found',
          message: 'platform-auditor has not yet run feature coverage audit',
        },
        { status: 404 }
      );
    }

    // Build query with optional filters
    let query = `
      SELECT
        project,
        feature,
        status,
        last_heartbeat,
        events_last_7d,
        defined_budget,
        budget_unit
      FROM feature_coverage_audit
      WHERE audit_time = ?
    `;
    const bindings: (string | number)[] = [latestResult.latest];

    if (project) {
      query += ' AND project = ?';
      bindings.push(project);
    }

    if (status) {
      query += ' AND status = ?';
      bindings.push(status);
    }

    query += ' ORDER BY project, feature';

    const result = await env.PLATFORM_DB.prepare(query)
      .bind(...bindings)
      .all<{
        project: string;
        feature: string;
        status: string;
        last_heartbeat: string | null;
        events_last_7d: number;
        defined_budget: number | null;
        budget_unit: string | null;
      }>();

    // Build summary
    const entries = result.results ?? [];
    const summary = {
      active: entries.filter((e) => e.status === 'active').length,
      dormant: entries.filter((e) => e.status === 'dormant').length,
      undefined: entries.filter((e) => e.status === 'undefined').length,
      total: entries.length,
    };

    return Response.json({
      success: true,
      data: {
        auditTime: latestResult.latest,
        summary,
        features: entries,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json(
      { success: false, error: 'Failed to get feature coverage', message },
      { status: 500 }
    );
  }
}
