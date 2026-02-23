/**
 * Health Trends Handler
 *
 * API endpoints for querying project health trends from the health_trends table.
 * Part of Phase 2 AI Judge enhancements - Dashboard Trends.
 *
 * @see docs/plans/ai-judge-enhancements.md
 */

import type { Env } from '../shared';
import { jsonResponse } from '../shared';

/**
 * Health trend record from D1
 */
interface HealthTrendRecord {
  id: number;
  project: string;
  audit_id: string;
  audit_date: string;
  composite_score: number;
  sdk_score: number | null;
  observability_score: number | null;
  cost_score: number | null;
  security_score: number | null;
  trend: 'improving' | 'stable' | 'declining';
  score_delta: number;
  created_at: string;
}

/**
 * API response for health trends
 */
interface HealthTrendsResponse {
  success: boolean;
  data: {
    project: string;
    trends: {
      date: string;
      compositeScore: number;
      rubricScores: {
        sdk: number | null;
        observability: number | null;
        cost: number | null;
        security: number | null;
      };
      trend: 'improving' | 'stable' | 'declining';
      delta: number;
    }[];
    latestScore: number | null;
    latestTrend: 'improving' | 'stable' | 'declining' | null;
  }[];
  period: {
    days: number;
    from: string;
    to: string;
  };
}

/**
 * Handle GET /usage/health-trends
 *
 * Query params:
 * - project: 'all' | <your-project-ids> (default: 'all')
 * - days: number (default: 90)
 *
 * Returns health trends for the specified project(s) over the given period.
 */
export async function handleGetHealthTrends(url: URL, env: Env): Promise<Response> {
  const project = url.searchParams.get('project') || 'all';
  const days = parseInt(url.searchParams.get('days') || '90', 10);

  // Calculate date range
  const now = new Date();
  const fromDate = new Date(now);
  fromDate.setDate(fromDate.getDate() - days);
  const fromDateStr = fromDate.toISOString().split('T')[0];
  const toDateStr = now.toISOString().split('T')[0];

  try {
    // Build query based on project filter
    let query: string;
    let params: unknown[];

    if (project === 'all') {
      query = `
        SELECT * FROM health_trends
        WHERE audit_date >= ?
        ORDER BY project, audit_date DESC
      `;
      params = [fromDateStr];
    } else {
      query = `
        SELECT * FROM health_trends
        WHERE project = ? AND audit_date >= ?
        ORDER BY audit_date DESC
      `;
      params = [project, fromDateStr];
    }

    const results = await env.PLATFORM_DB.prepare(query)
      .bind(...params)
      .all<HealthTrendRecord>();

    if (!results.success) {
      return jsonResponse({ success: false, error: 'Database query failed' }, 500);
    }

    // Group results by project
    const projectMap = new Map<string, HealthTrendRecord[]>();
    for (const record of results.results) {
      const existing = projectMap.get(record.project) || [];
      existing.push(record);
      projectMap.set(record.project, existing);
    }

    // Format response
    const data: HealthTrendsResponse['data'] = [];
    for (const [projectName, records] of projectMap) {
      const trends = records.map((r) => ({
        date: r.audit_date,
        compositeScore: r.composite_score,
        rubricScores: {
          sdk: r.sdk_score,
          observability: r.observability_score,
          cost: r.cost_score,
          security: r.security_score,
        },
        trend: r.trend,
        delta: r.score_delta,
      }));

      const latest = records[0]; // Already sorted DESC
      data.push({
        project: projectName,
        trends,
        latestScore: latest?.composite_score ?? null,
        latestTrend: latest?.trend ?? null,
      });
    }

    const response: HealthTrendsResponse = {
      success: true,
      data,
      period: {
        days,
        from: fromDateStr,
        to: toDateStr,
      },
    };

    return jsonResponse(response, 200);
  } catch (error) {
    console.error('Failed to query health trends:', error);
    return jsonResponse(
      {
        success: false,
        error: 'Failed to query health trends',
        details: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
}

/**
 * Handle GET /usage/health-trends/latest
 *
 * Returns only the most recent health score for each project.
 * Useful for dashboard summary view.
 */
export async function handleGetLatestHealthTrends(env: Env): Promise<Response> {
  try {
    // Use the view we created for latest health per project
    const results = await env.PLATFORM_DB.prepare(
      `
      SELECT * FROM v_project_health_latest
      ORDER BY project
    `
    ).all<HealthTrendRecord & { previous_score: number | null }>();

    if (!results.success) {
      return jsonResponse({ success: false, error: 'Database query failed' }, 500);
    }

    const data = results.results.map(
      (r: HealthTrendRecord & { previous_score: number | null }) => ({
        project: r.project,
        compositeScore: r.composite_score,
        previousScore: r.previous_score,
        rubricScores: {
          sdk: r.sdk_score,
          observability: r.observability_score,
          cost: r.cost_score,
          security: r.security_score,
        },
        trend: r.trend,
        delta: r.score_delta,
        auditDate: r.audit_date,
      })
    );

    return jsonResponse(
      {
        success: true,
        data,
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (error) {
    console.error('Failed to query latest health trends:', error);
    return jsonResponse(
      {
        success: false,
        error: 'Failed to query latest health trends',
        details: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
}
