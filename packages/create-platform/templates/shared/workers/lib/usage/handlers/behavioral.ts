/**
 * Behavioral Analysis Handlers for platform-usage
 *
 * Provides API endpoints for accessing file hotspots and SDK regression data.
 * Part of the Dashboard Enhancements initiative.
 *
 * Endpoints:
 * - GET /usage/audit/behavioral - Combined hotspots + regressions summary
 * - GET /usage/audit/behavioral/hotspots - File hotspots with risk scoring
 * - GET /usage/audit/behavioral/regressions - SDK regressions with acknowledgment status
 * - POST /usage/audit/behavioral/regressions/:id/acknowledge - Mark regression as acknowledged
 *
 * @module workers/lib/usage/handlers/behavioral
 * @created 2026-01-30
 */

import type { D1Database } from '@cloudflare/workers-types';

/**
 * Environment bindings for behavioral handlers
 */
export interface BehavioralHandlerEnv {
  PLATFORM_DB: D1Database;
}

/**
 * File hotspot data from D1
 */
interface FileHotspot {
  id: number;
  project: string;
  file_path: string;
  change_count: number;
  last_changed: string | null;
  authors: string | null;
  has_sdk_patterns: boolean;
  sdk_patterns_found: string | null;
  hotspot_score: number;
  audit_date: string;
}

/**
 * SDK regression data from D1
 */
interface SdkRegression {
  id: number;
  project: string;
  commit_sha: string;
  commit_message: string | null;
  commit_author: string | null;
  commit_date: string | null;
  file_path: string;
  regression_type: string;
  description: string | null;
  severity: string;
  acknowledged: boolean;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  audit_date: string;
}

/**
 * Handle GET /usage/audit/behavioral - Get combined behavioral analysis summary
 */
export async function handleGetBehavioral(
  request: Request,
  env: BehavioralHandlerEnv
): Promise<Response> {
  const url = new URL(request.url);
  const project = url.searchParams.get('project');

  try {
    // Get latest audit date for hotspots
    const latestHotspotResult = await env.PLATFORM_DB.prepare(
      `SELECT MAX(audit_date) as latest FROM audit_file_hotspots`
    ).first<{ latest: string | null }>();

    // Get latest audit date for regressions
    const latestRegressionResult = await env.PLATFORM_DB.prepare(
      `SELECT MAX(audit_date) as latest FROM audit_sdk_regressions`
    ).first<{ latest: string | null }>();

    // Build hotspots query
    let hotspotsQuery = `
      SELECT
        id, project, file_path, change_count, last_changed, authors,
        has_sdk_patterns, sdk_patterns_found, hotspot_score, audit_date
      FROM audit_file_hotspots
      WHERE audit_date = ?
    `;
    const hotspotsBindings: (string | number)[] = [latestHotspotResult?.latest ?? ''];

    if (project) {
      hotspotsQuery += ' AND project = ?';
      hotspotsBindings.push(project);
    }

    hotspotsQuery += ' ORDER BY hotspot_score DESC LIMIT 20';

    // Build regressions query
    let regressionsQuery = `
      SELECT
        id, project, commit_sha, commit_message, commit_author, commit_date,
        file_path, regression_type, description, severity, acknowledged,
        acknowledged_at, acknowledged_by, audit_date
      FROM audit_sdk_regressions
      WHERE acknowledged = FALSE
    `;
    const regressionsBindings: (string | number)[] = [];

    if (project) {
      regressionsQuery += ' AND project = ?';
      regressionsBindings.push(project);
    }

    regressionsQuery += ' ORDER BY CASE severity WHEN \'critical\' THEN 1 WHEN \'high\' THEN 2 WHEN \'medium\' THEN 3 ELSE 4 END, commit_date DESC LIMIT 20';

    // Execute queries in parallel
    const [hotspotsResult, regressionsResult] = await Promise.all([
      latestHotspotResult?.latest
        ? env.PLATFORM_DB.prepare(hotspotsQuery).bind(...hotspotsBindings).all<FileHotspot>()
        : Promise.resolve({ results: [] as FileHotspot[] }),
      env.PLATFORM_DB.prepare(regressionsQuery).bind(...regressionsBindings).all<SdkRegression>(),
    ]);

    // Build summary
    const hotspots = hotspotsResult.results ?? [];
    const regressions = regressionsResult.results ?? [];

    const summary = {
      hotspotsCount: hotspots.length,
      highRiskHotspots: hotspots.filter((h) => h.hotspot_score >= 10).length,
      regressionsCount: regressions.length,
      criticalRegressions: regressions.filter((r) => r.severity === 'critical').length,
      highRegressions: regressions.filter((r) => r.severity === 'high').length,
    };

    return Response.json({
      success: true,
      data: {
        summary,
        hotspots: hotspots.map(formatHotspot),
        regressions: regressions.map(formatRegression),
      },
      auditDates: {
        hotspots: latestHotspotResult?.latest ?? null,
        regressions: latestRegressionResult?.latest ?? null,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json(
      { success: false, error: 'Failed to get behavioral analysis', message },
      { status: 500 }
    );
  }
}

/**
 * Handle GET /usage/audit/behavioral/hotspots - Get file hotspots with risk scoring
 */
export async function handleGetHotspots(
  request: Request,
  env: BehavioralHandlerEnv
): Promise<Response> {
  const url = new URL(request.url);
  const project = url.searchParams.get('project');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
  const minScore = parseInt(url.searchParams.get('min_score') || '0', 10);

  try {
    // Get latest audit date
    const latestResult = await env.PLATFORM_DB.prepare(
      `SELECT MAX(audit_date) as latest FROM audit_file_hotspots`
    ).first<{ latest: string | null }>();

    if (!latestResult?.latest) {
      return Response.json({
        success: true,
        data: {
          auditDate: null,
          summary: { total: 0, highRisk: 0, withoutSdk: 0 },
          hotspots: [],
        },
        message: 'No behavioral analysis data available. Run platform-auditor to generate data.',
        timestamp: new Date().toISOString(),
      });
    }

    // Build query
    let query = `
      SELECT
        id, project, file_path, change_count, last_changed, authors,
        has_sdk_patterns, sdk_patterns_found, hotspot_score, audit_date
      FROM audit_file_hotspots
      WHERE audit_date = ? AND hotspot_score >= ?
    `;
    const bindings: (string | number)[] = [latestResult.latest, minScore];

    if (project) {
      query += ' AND project = ?';
      bindings.push(project);
    }

    query += ' ORDER BY hotspot_score DESC LIMIT ?';
    bindings.push(limit);

    const result = await env.PLATFORM_DB.prepare(query).bind(...bindings).all<FileHotspot>();

    const hotspots = result.results ?? [];

    // Build summary
    const summary = {
      total: hotspots.length,
      highRisk: hotspots.filter((h) => h.hotspot_score >= 10).length,
      withoutSdk: hotspots.filter((h) => !h.has_sdk_patterns).length,
    };

    return Response.json({
      success: true,
      data: {
        auditDate: latestResult.latest,
        summary,
        hotspots: hotspots.map(formatHotspot),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json(
      { success: false, error: 'Failed to get hotspots', message },
      { status: 500 }
    );
  }
}

/**
 * Handle GET /usage/audit/behavioral/regressions - Get SDK regressions
 */
export async function handleGetRegressions(
  request: Request,
  env: BehavioralHandlerEnv
): Promise<Response> {
  const url = new URL(request.url);
  const project = url.searchParams.get('project');
  const acknowledged = url.searchParams.get('acknowledged');
  const severity = url.searchParams.get('severity');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);

  try {
    // Build query
    let query = `
      SELECT
        id, project, commit_sha, commit_message, commit_author, commit_date,
        file_path, regression_type, description, severity, acknowledged,
        acknowledged_at, acknowledged_by, audit_date
      FROM audit_sdk_regressions
      WHERE 1=1
    `;
    const bindings: (string | number)[] = [];

    if (project) {
      query += ' AND project = ?';
      bindings.push(project);
    }

    if (acknowledged !== null) {
      query += ' AND acknowledged = ?';
      bindings.push(acknowledged === 'true' ? 1 : 0);
    }

    if (severity) {
      query += ' AND severity = ?';
      bindings.push(severity);
    }

    query += ` ORDER BY
      CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
      commit_date DESC
      LIMIT ?`;
    bindings.push(limit);

    const result = await env.PLATFORM_DB.prepare(query).bind(...bindings).all<SdkRegression>();

    const regressions = result.results ?? [];

    // Build summary
    const summary = {
      total: regressions.length,
      unacknowledged: regressions.filter((r) => !r.acknowledged).length,
      bySeverity: {
        critical: regressions.filter((r) => r.severity === 'critical').length,
        high: regressions.filter((r) => r.severity === 'high').length,
        medium: regressions.filter((r) => r.severity === 'medium').length,
        low: regressions.filter((r) => r.severity === 'low').length,
      },
    };

    return Response.json({
      success: true,
      data: {
        summary,
        regressions: regressions.map(formatRegression),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json(
      { success: false, error: 'Failed to get regressions', message },
      { status: 500 }
    );
  }
}

/**
 * Handle POST /usage/audit/behavioral/regressions/:id/acknowledge - Mark regression as acknowledged
 */
export async function handleAcknowledgeRegression(
  request: Request,
  env: BehavioralHandlerEnv,
  regressionId: string
): Promise<Response> {
  try {
    // Parse body for acknowledger info (optional)
    let acknowledgedBy = 'system';
    try {
      const body = await request.json() as { acknowledged_by?: string };
      if (body.acknowledged_by) {
        acknowledgedBy = body.acknowledged_by;
      }
    } catch {
      // Body is optional
    }

    const result = await env.PLATFORM_DB.prepare(
      `UPDATE audit_sdk_regressions
       SET acknowledged = TRUE,
           acknowledged_at = datetime('now'),
           acknowledged_by = ?
       WHERE id = ? AND acknowledged = FALSE`
    )
      .bind(acknowledgedBy, parseInt(regressionId, 10))
      .run();

    if (result.meta.changes === 0) {
      // Check if it exists
      const existing = await env.PLATFORM_DB.prepare(
        `SELECT id, acknowledged FROM audit_sdk_regressions WHERE id = ?`
      )
        .bind(parseInt(regressionId, 10))
        .first<{ id: number; acknowledged: boolean }>();

      if (!existing) {
        return Response.json(
          { success: false, error: 'Regression not found' },
          { status: 404 }
        );
      }

      if (existing.acknowledged) {
        return Response.json(
          { success: false, error: 'Regression already acknowledged' },
          { status: 409 }
        );
      }
    }

    return Response.json({
      success: true,
      message: 'Regression acknowledged',
      data: {
        id: parseInt(regressionId, 10),
        acknowledgedAt: new Date().toISOString(),
        acknowledgedBy,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json(
      { success: false, error: 'Failed to acknowledge regression', message },
      { status: 500 }
    );
  }
}

/**
 * Format hotspot for API response
 */
function formatHotspot(hotspot: FileHotspot) {
  return {
    id: hotspot.id,
    project: hotspot.project,
    filePath: hotspot.file_path,
    changeCount: hotspot.change_count,
    lastChanged: hotspot.last_changed,
    authors: hotspot.authors ? JSON.parse(hotspot.authors) : [],
    hasSdkPatterns: hotspot.has_sdk_patterns,
    sdkPatternsFound: hotspot.sdk_patterns_found ? JSON.parse(hotspot.sdk_patterns_found) : [],
    hotspotScore: hotspot.hotspot_score,
    riskLevel: hotspot.hotspot_score >= 15 ? 'critical' : hotspot.hotspot_score >= 10 ? 'high' : hotspot.hotspot_score >= 5 ? 'medium' : 'low',
    auditDate: hotspot.audit_date,
  };
}

/**
 * Format regression for API response
 */
function formatRegression(regression: SdkRegression) {
  return {
    id: regression.id,
    project: regression.project,
    commit: {
      sha: regression.commit_sha,
      message: regression.commit_message,
      author: regression.commit_author,
      date: regression.commit_date,
    },
    filePath: regression.file_path,
    regressionType: regression.regression_type,
    description: regression.description,
    severity: regression.severity,
    acknowledged: regression.acknowledged,
    acknowledgedAt: regression.acknowledged_at,
    acknowledgedBy: regression.acknowledged_by,
    auditDate: regression.audit_date,
  };
}
