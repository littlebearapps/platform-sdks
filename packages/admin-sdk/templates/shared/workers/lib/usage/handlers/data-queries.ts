/**
 * Data Query Functions for Usage Handlers
 *
 * D1 and KV access functions used by handler modules.
 * Extracted from platform-usage.ts as part of Phase B migration.
 */

import type { Env, TimePeriod, ProjectedBurn, DailyCostData, CostBreakdown } from '../shared';
import type { AIGatewaySummary } from '../../shared/cloudflare';

// =============================================================================
// PRICING VERSION CACHE
// =============================================================================

// In-memory cache for pricing version ID (per-request lifetime)
let cachedPricingVersionId: number | null = null;

/**
 * Get current pricing version ID from D1.
 * Caches result for the lifetime of the request.
 */
export async function getCurrentPricingVersionId(env: Env): Promise<number | null> {
  if (cachedPricingVersionId !== null) {
    return cachedPricingVersionId;
  }

  try {
    const result = await env.PLATFORM_DB.prepare(
      `SELECT id FROM pricing_versions WHERE effective_to IS NULL ORDER BY effective_from DESC LIMIT 1`
    ).first<{ id: number }>();

    cachedPricingVersionId = result?.id ?? null;
    return cachedPricingVersionId;
  } catch {
    return null;
  }
}

/**
 * Reset cached pricing version ID.
 */
export function resetPricingVersionCache(): void {
  cachedPricingVersionId = null;
}

// =============================================================================
// D1 USAGE DATA QUERIES
// =============================================================================

/**
 * Query D1 for aggregated usage data over a time period.
 * Uses hourly snapshots for 24h period, daily rollups for 7d/30d.
 */
export async function queryD1UsageData(
  env: Env,
  period: TimePeriod,
  project: string
): Promise<{ costs: CostBreakdown; rowCount: number } | null> {
  try {
    const isHourly = period === '24h';
    const table = isHourly ? 'hourly_usage_snapshots' : 'daily_usage_rollups';
    const dateCol = isHourly ? 'snapshot_hour' : 'snapshot_date';

    const now = new Date();
    let startFilter: string;

    if (period === '24h') {
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      startFilter = yesterday.toISOString().slice(0, 13) + ':00:00Z';
    } else if (period === '7d') {
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      startFilter = weekAgo.toISOString().slice(0, 10);
    } else {
      const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      startFilter = monthAgo.toISOString().slice(0, 10);
    }

    const result = await env.PLATFORM_DB.prepare(
      `
      SELECT
        SUM(workers_cost_usd) as workers_cost,
        SUM(d1_cost_usd) as d1_cost,
        SUM(kv_cost_usd) as kv_cost,
        SUM(r2_cost_usd) as r2_cost,
        SUM(do_cost_usd) as do_cost,
        SUM(vectorize_cost_usd) as vectorize_cost,
        SUM(aigateway_cost_usd) as aigateway_cost,
        SUM(pages_cost_usd) as pages_cost,
        SUM(queues_cost_usd) as queues_cost,
        SUM(workersai_cost_usd) as workersai_cost,
        SUM(total_cost_usd) as total_cost,
        COUNT(*) as row_count
      FROM ${table}
      WHERE ${dateCol} >= ?
        AND project = ?
    `
    )
      .bind(startFilter, project)
      .first<{
        workers_cost: number | null;
        d1_cost: number | null;
        kv_cost: number | null;
        r2_cost: number | null;
        do_cost: number | null;
        vectorize_cost: number | null;
        aigateway_cost: number | null;
        pages_cost: number | null;
        queues_cost: number | null;
        workersai_cost: number | null;
        total_cost: number | null;
        row_count: number;
      }>();

    if (!result || result.row_count === 0) {
      return null;
    }

    return {
      costs: {
        workers: result.workers_cost ?? 0,
        d1: result.d1_cost ?? 0,
        kv: result.kv_cost ?? 0,
        r2: result.r2_cost ?? 0,
        durableObjects: result.do_cost ?? 0,
        vectorize: result.vectorize_cost ?? 0,
        aiGateway: result.aigateway_cost ?? 0,
        pages: result.pages_cost ?? 0,
        queues: result.queues_cost ?? 0,
        workersAI: result.workersai_cost ?? 0,
        workflows: 0,
        total: result.total_cost ?? 0,
      },
      rowCount: result.row_count,
    };
  } catch {
    return null;
  }
}

/**
 * Query D1 for daily cost breakdown (for charts).
 */
export async function queryD1DailyCosts(
  env: Env,
  period: TimePeriod | { start: string; end: string },
  project: string = 'all'
): Promise<DailyCostData | null> {
  try {
    let startDate: string;
    let endDate: string;

    if (typeof period === 'object') {
      startDate = period.start;
      endDate = period.end;
    } else {
      const now = new Date();
      endDate = now.toISOString().slice(0, 10);

      if (period === '24h') {
        startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      } else if (period === '7d') {
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      } else {
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      }
    }

    // When project is 'all', sum across individual projects instead of using the 'all' row
    // This ensures we get complete data even if the 'all' rollup row is missing for some dates
    const isAllProjects = project === 'all';
    const query = isAllProjects
      ? `
      SELECT
        snapshot_date as date,
        SUM(workers_cost_usd) as workers,
        SUM(d1_cost_usd) as d1,
        SUM(kv_cost_usd) as kv,
        SUM(r2_cost_usd) as r2,
        SUM(do_cost_usd) as durableObjects,
        SUM(vectorize_cost_usd) as vectorize,
        SUM(aigateway_cost_usd) as aiGateway,
        SUM(pages_cost_usd) as pages,
        SUM(queues_cost_usd) as queues,
        SUM(workersai_cost_usd) as workersAI,
        SUM(total_cost_usd) as total,
        MAX(COALESCE(rollup_version, 1)) as rollupVersion
      FROM daily_usage_rollups
      WHERE snapshot_date >= ?
        AND snapshot_date <= ?
        AND project NOT IN ('all', '_unattributed')
      GROUP BY snapshot_date
      ORDER BY snapshot_date ASC
    `
      : `
      SELECT
        snapshot_date as date,
        workers_cost_usd as workers,
        d1_cost_usd as d1,
        kv_cost_usd as kv,
        r2_cost_usd as r2,
        do_cost_usd as durableObjects,
        vectorize_cost_usd as vectorize,
        aigateway_cost_usd as aiGateway,
        pages_cost_usd as pages,
        queues_cost_usd as queues,
        workersai_cost_usd as workersAI,
        total_cost_usd as total,
        COALESCE(rollup_version, 1) as rollupVersion
      FROM daily_usage_rollups
      WHERE snapshot_date >= ?
        AND snapshot_date <= ?
        AND project = ?
      ORDER BY snapshot_date ASC
    `;

    const result = await env.PLATFORM_DB.prepare(query)
      .bind(startDate, endDate, ...(isAllProjects ? [] : [project]))
      .all<{
        date: string;
        workers: number;
        d1: number;
        kv: number;
        r2: number;
        durableObjects: number;
        vectorize: number;
        aiGateway: number;
        pages: number;
        queues: number;
        workersAI: number;
        total: number;
        rollupVersion: number;
      }>();

    if (!result.results || result.results.length === 0) {
      return null;
    }

    const days = result.results.map((r) => ({
      date: r.date,
      workers: r.workers ?? 0,
      d1: r.d1 ?? 0,
      kv: r.kv ?? 0,
      r2: r.r2 ?? 0,
      durableObjects: r.durableObjects ?? 0,
      vectorize: r.vectorize ?? 0,
      aiGateway: r.aiGateway ?? 0,
      workersAI: r.workersAI ?? 0,
      pages: 0,
      queues: r.queues ?? 0,
      workflows: 0,
      total: r.total ?? 0,
      rollupVersion: r.rollupVersion ?? 1,
    }));

    const hasLegacyData = result.results.some((r) => (r.rollupVersion ?? 1) === 1);

    const totals = {
      workers: days.reduce((sum, d) => sum + d.workers, 0),
      d1: days.reduce((sum, d) => sum + d.d1, 0),
      kv: days.reduce((sum, d) => sum + d.kv, 0),
      r2: days.reduce((sum, d) => sum + d.r2, 0),
      durableObjects: days.reduce((sum, d) => sum + d.durableObjects, 0),
      vectorize: days.reduce((sum, d) => sum + d.vectorize, 0),
      aiGateway: days.reduce((sum, d) => sum + d.aiGateway, 0),
      workersAI: days.reduce((sum, d) => sum + d.workersAI, 0),
      pages: 0,
      queues: days.reduce((sum, d) => sum + d.queues, 0),
      workflows: 0,
      total: days.reduce((sum, d) => sum + d.total, 0),
    };

    return {
      days,
      totals,
      period: { start: startDate, end: endDate },
      hasLegacyData,
    };
  } catch {
    return null;
  }
}

/**
 * Calculate projected monthly burn based on current month's data.
 */
export async function calculateProjectedBurn(
  env: Env,
  project: string = 'all'
): Promise<ProjectedBurn> {
  const now = new Date();
  const currentMonth = now.toISOString().slice(0, 7);
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

  try {
    const currentMonthResult = await env.PLATFORM_DB.prepare(
      `
      SELECT
        SUM(total_cost_usd) as total_cost,
        COUNT(*) as days_count
      FROM daily_usage_rollups
      WHERE snapshot_date LIKE ?
        AND project = ?
    `
    )
      .bind(`${currentMonth}%`, project)
      .first<{ total_cost: number | null; days_count: number }>();

    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthStr = lastMonth.toISOString().slice(0, 7);
    const lastMonthResult = await env.PLATFORM_DB.prepare(
      `
      SELECT SUM(total_cost_usd) as total_cost
      FROM daily_usage_rollups
      WHERE snapshot_date LIKE ?
        AND project = ?
    `
    )
      .bind(`${lastMonthStr}%`, project)
      .first<{ total_cost: number | null }>();

    const currentDays = currentMonthResult?.days_count ?? 0;
    const currentCost = currentMonthResult?.total_cost ?? 0;
    const lastMonthCost = lastMonthResult?.total_cost ?? null;

    const dailyBurnRate = currentDays > 0 ? currentCost / currentDays : 0;
    const daysRemaining = daysInMonth - dayOfMonth;
    const projectedMonthlyCost = currentCost + dailyBurnRate * daysRemaining;

    let projectedVsLastMonthPct: number | null = null;
    if (lastMonthCost && lastMonthCost > 0) {
      projectedVsLastMonthPct = ((projectedMonthlyCost - lastMonthCost) / lastMonthCost) * 100;
    }

    let confidence: 'low' | 'medium' | 'high';
    if (currentDays >= 20) {
      confidence = 'high';
    } else if (currentDays >= 10) {
      confidence = 'medium';
    } else {
      confidence = 'low';
    }

    return {
      currentPeriodDays: currentDays,
      currentPeriodCost: currentCost,
      dailyBurnRate,
      projectedMonthlyCost,
      projectedVsLastMonthPct,
      lastMonthCost,
      confidence,
    };
  } catch {
    return {
      currentPeriodDays: 0,
      currentPeriodCost: 0,
      dailyBurnRate: 0,
      projectedMonthlyCost: 0,
      projectedVsLastMonthPct: null,
      lastMonthCost: null,
      confidence: 'low',
    };
  }
}

/**
 * Query AI Gateway aggregated metrics from D1.
 */
export async function queryAIGatewayMetrics(
  env: Env,
  period: TimePeriod
): Promise<AIGatewaySummary | null> {
  try {
    const now = new Date();
    let startDate: string;

    switch (period) {
      case '24h':
        startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        break;
      case '7d':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        break;
      case '30d':
      default:
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        break;
    }
    const endDate = now.toISOString().slice(0, 10);

    const totalsResult = await env.PLATFORM_DB.prepare(
      `
      SELECT
        COALESCE(SUM(requests), 0) as total_requests,
        COALESCE(SUM(cached_requests), 0) as total_cached,
        COALESCE(SUM(tokens_in), 0) as tokens_in,
        COALESCE(SUM(tokens_out), 0) as tokens_out,
        COALESCE(SUM(cost_usd), 0) as total_cost
      FROM aigateway_model_daily
      WHERE snapshot_date >= ? AND snapshot_date <= ?
    `
    )
      .bind(startDate, endDate)
      .first<{
        total_requests: number;
        total_cached: number;
        tokens_in: number;
        tokens_out: number;
        total_cost: number;
      }>();

    if (!totalsResult || totalsResult.total_requests === 0) {
      return null;
    }

    const byProviderResult = await env.PLATFORM_DB.prepare(
      `
      SELECT
        provider,
        SUM(requests) as requests,
        SUM(cached_requests) as cached_requests,
        SUM(tokens_in) as tokens_in,
        SUM(tokens_out) as tokens_out,
        SUM(cost_usd) as cost_usd
      FROM aigateway_model_daily
      WHERE snapshot_date >= ? AND snapshot_date <= ?
      GROUP BY provider
      ORDER BY requests DESC
    `
    )
      .bind(startDate, endDate)
      .all<{
        provider: string;
        requests: number;
        cached_requests: number;
        tokens_in: number;
        tokens_out: number;
        cost_usd: number;
      }>();

    const byModelResult = await env.PLATFORM_DB.prepare(
      `
      SELECT
        model,
        SUM(requests) as requests,
        SUM(cached_requests) as cached_requests,
        SUM(tokens_in) as tokens_in,
        SUM(tokens_out) as tokens_out,
        SUM(cost_usd) as cost_usd
      FROM aigateway_model_daily
      WHERE snapshot_date >= ? AND snapshot_date <= ?
      GROUP BY model
      ORDER BY requests DESC
      LIMIT 20
    `
    )
      .bind(startDate, endDate)
      .all<{
        model: string;
        requests: number;
        cached_requests: number;
        tokens_in: number;
        tokens_out: number;
        cost_usd: number;
      }>();

    const byProvider: AIGatewaySummary['byProvider'] = {};
    for (const row of byProviderResult.results ?? []) {
      byProvider[row.provider] = {
        requests: row.requests,
        cachedRequests: row.cached_requests,
        tokensIn: row.tokens_in,
        tokensOut: row.tokens_out,
        costUsd: row.cost_usd,
      };
    }

    const byModel: AIGatewaySummary['byModel'] = {};
    for (const row of byModelResult.results ?? []) {
      byModel[row.model] = {
        requests: row.requests,
        cachedRequests: row.cached_requests,
        tokensIn: row.tokens_in,
        tokensOut: row.tokens_out,
        costUsd: row.cost_usd,
      };
    }

    const cacheHitRate =
      totalsResult.total_requests > 0
        ? (totalsResult.total_cached / totalsResult.total_requests) * 100
        : 0;

    return {
      totalRequests: totalsResult.total_requests,
      totalCachedRequests: totalsResult.total_cached,
      cacheHitRate: Math.round(cacheHitRate * 100) / 100,
      tokensIn: totalsResult.tokens_in,
      tokensOut: totalsResult.tokens_out,
      totalCostUsd: totalsResult.total_cost,
      byProvider,
      byModel,
    };
  } catch {
    return null;
  }
}
