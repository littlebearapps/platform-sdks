/**
 * Usage Metrics Handler Module
 *
 * Handles usage metrics endpoints for the platform-usage worker.
 * Extracted from platform-usage.ts as part of Phase B migration.
 *
 * Endpoints handled:
 * - GET /usage - Get usage metrics with cost breakdown
 * - GET /usage/costs - Get cost breakdown only
 * - GET /usage/thresholds - Get threshold warnings only
 * - GET /usage/enhanced - Get enhanced usage metrics with sparklines and trends
 * - GET /usage/compare - Get period comparison (task-17.3, 17.4)
 * - GET /usage/daily - Get daily cost breakdown for chart/table (task-18)
 * - GET /usage/status - Project status for unified dashboard
 * - GET /usage/projects - Project list with resource counts
 * - GET /usage/anomalies - Detected usage anomalies
 * - GET /usage/utilization - Burn rate and per-project utilization
 */

import {
  CloudflareGraphQL,
  calculateMonthlyCosts,
  calculateProjectCosts,
  analyseThresholds,
  formatCurrency,
  getProjects,
  type TimePeriod,
  type DateRange,
  type CompareMode,
  type AccountUsage,
  type CostBreakdown,
  type ProjectCostBreakdown,
  type Project,
} from '../../shared/cloudflare';
import {
  CF_SIMPLE_ALLOWANCES,
  type SimpleAllowanceType,
} from '../../shared/allowances';
import { createLoggerFromEnv } from '@littlebearapps/platform-sdk';
import { queryD1UsageData, queryD1DailyCosts, calculateProjectedBurn } from './data-queries';
import {
  type Env,
  type UsageResponse,
  type EnhancedUsageResponse,
  type ComparisonResponse,
  type DailyCostResponse,
  type BurnRateResponse,
  type ProjectUtilizationData,
  type GitHubUsageResponse,
  type ResourceMetricData,
  type ProviderHealthData,
  type ServiceUtilizationStatus,
  type AnomalyRecord,
  type AnomaliesResponse,
  type ProjectedBurn,
  type DailyCostData,
  type TimePeriod as SharedTimePeriod,
  getCacheKey,
  parseQueryParams,
  parseQueryParamsWithRegistry,
  jsonResponse,
  buildProjectLookupCache,
  filterByProject,
  filterByProjectWithRegistry,
  calculateSummary,
  calcTrend,
  getBudgetThresholds,
  getServiceUtilizationStatus,
  CB_KEYS,
  CF_OVERAGE_PRICING,
  FALLBACK_PROJECT_CONFIGS,
} from '../shared';
import { getUtilizationStatus } from '../../platform-settings';

// =============================================================================
// LOCAL TYPE DEFINITIONS
// =============================================================================

/**
 * Projected cost calculation based on MTD usage
 */
interface ProjectedCost {
  /** Current month-to-date cost in USD */
  currentCost: number;
  /** Number of days elapsed this month */
  daysPassed: number;
  /** Total days in the current month */
  daysInMonth: number;
  /** Projected end-of-month cost based on current burn rate */
  projectedMonthlyCost: number;
}

/**
 * Service allowance definition for API response
 */
interface AllowanceInfo {
  limit: number;
  unit: string;
}

/**
 * Project list response type
 */
interface ProjectListResponse {
  success: boolean;
  projects: Array<Project & { resourceCount: number }>;
  totalResources: number;
  timestamp: string;
  cached: boolean;
  /** Cloudflare account-level service allowances */
  allowances: {
    workers: AllowanceInfo;
    d1_writes: AllowanceInfo;
    kv_writes: AllowanceInfo;
    r2_storage: AllowanceInfo;
    durableObjects: AllowanceInfo;
    vectorize: AllowanceInfo;
    github_actions_minutes: AllowanceInfo;
  };
  /** Projected monthly cost based on MTD burn rate */
  projectedCost: ProjectedCost;
}

// =============================================================================
// CLOUDFLARE ALLOWANCES ALIAS
// =============================================================================

const CF_ALLOWANCES = CF_SIMPLE_ALLOWANCES;

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get project config from D1 registry or fallback to hardcoded config.
 * Once migration 009 is applied, this will primarily use D1.
 */
function getProjectConfig(
  project: Project
): { name: string; primaryResource: SimpleAllowanceType; customLimit?: number } | null {
  // Use D1 registry values if available
  if (project.primaryResource) {
    const primaryResource = project.primaryResource as SimpleAllowanceType;
    if (CF_ALLOWANCES[primaryResource]) {
      return {
        name: project.displayName,
        primaryResource,
        customLimit: project.customLimit ?? undefined,
      };
    }
  }

  // Fallback to hardcoded config
  return FALLBACK_PROJECT_CONFIGS[project.projectId] ?? null;
}

/**
 * Query GitHub usage data from D1 third_party_usage table.
 * Returns MTD aggregated data for display in the dashboard.
 */
async function queryGitHubUsage(env: Env): Promise<GitHubUsageResponse | null> {
  try {
    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth();
    const mtdStartDate = new Date(Date.UTC(currentYear, currentMonth, 1))
      .toISOString()
      .slice(0, 10);

    // Query all GitHub metrics for the current month
    const result = await env.PLATFORM_DB.prepare(
      `
      SELECT resource_type, usage_value, cost_usd, usage_unit,
             MAX(snapshot_date) as latest_date,
             MAX(collection_timestamp) as latest_ts
      FROM third_party_usage
      WHERE provider = 'github'
        AND snapshot_date >= ?
      GROUP BY resource_type
      `
    )
      .bind(mtdStartDate)
      .all<{
        resource_type: string;
        usage_value: number;
        cost_usd: number;
        usage_unit: string;
        latest_date: string;
        latest_ts: number;
      }>();

    if (!result.results || result.results.length === 0) {
      const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:github');
      log.info('No GitHub data found for current month', { tag: 'GITHUB_NO_DATA' });
      return null;
    }

    // Build lookup map
    const metrics: Record<string, { value: number; cost: number; unit: string }> = {};
    let latestTimestamp: number | null = null;

    for (const row of result.results) {
      metrics[row.resource_type] = {
        value: row.usage_value,
        cost: row.cost_usd,
        unit: row.usage_unit,
      };
      if (row.latest_ts && (latestTimestamp === null || row.latest_ts > latestTimestamp)) {
        latestTimestamp = row.latest_ts;
      }
    }

    // Check if data is stale (older than 24 hours)
    const twentyFourHoursAgo = Date.now() / 1000 - 24 * 60 * 60;
    const isStale = latestTimestamp ? latestTimestamp < twentyFourHoursAgo : true;

    // Extract values with defaults
    const actionsMinutes = metrics['actions_minutes']?.value ?? 0;
    const actionsMinutesIncluded = metrics['actions_minutes_included']?.value ?? 50000; // Default to Enterprise
    const actionsMinutesUsagePct =
      metrics['actions_minutes_usage_pct']?.value ??
      (actionsMinutesIncluded > 0 ? (actionsMinutes / actionsMinutesIncluded) * 100 : 0);
    const actionsStorageGbHours = metrics['actions_storage_gb_hours']?.value ?? 0;
    const actionsStorageGbIncluded = metrics['actions_storage_gb_included']?.value ?? 50; // Default to Enterprise
    const ghecUserMonths = metrics['ghec_user_months']?.value ?? 0;
    const ghasCodeSecuritySeats = metrics['ghas_code_security_user_months']?.value ?? 0;
    const ghasSecretProtectionSeats = metrics['ghas_secret_protection_user_months']?.value ?? 0;
    const totalCost = metrics['total_net_cost']?.value ?? 0;

    // Plan info
    const planName = metrics['plan_name']?.unit ?? 'unknown'; // plan_name stores the name in usage_unit
    const filledSeats = metrics['filled_seats']?.value ?? 0;
    const totalSeats = metrics['total_seats']?.value ?? 0;

    const response: GitHubUsageResponse = {
      mtdUsage: {
        actionsMinutes: Math.round(actionsMinutes),
        actionsMinutesIncluded: Math.round(actionsMinutesIncluded),
        actionsMinutesUsagePct: Math.round(actionsMinutesUsagePct * 10) / 10,
        actionsStorageGbHours: Math.round(actionsStorageGbHours * 100) / 100,
        actionsStorageGbIncluded: actionsStorageGbIncluded,
        ghecUserMonths: Math.round(ghecUserMonths * 100) / 100,
        ghasCodeSecuritySeats: Math.round(ghasCodeSecuritySeats),
        ghasSecretProtectionSeats: Math.round(ghasSecretProtectionSeats),
        totalCost: Math.round(totalCost * 100) / 100,
      },
      plan: {
        name: planName,
        filledSeats: Math.round(filledSeats),
        totalSeats: Math.round(totalSeats),
      },
      lastUpdated: latestTimestamp ? new Date(latestTimestamp * 1000).toISOString() : null,
      isStale,
    };

    const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:github');
    log.info(
      `GitHub data: ${response.mtdUsage.actionsMinutes}/${response.mtdUsage.actionsMinutesIncluded} mins (${response.mtdUsage.actionsMinutesUsagePct}%), $${response.mtdUsage.totalCost}`,
      { tag: 'USAGE' }
    );

    return response;
  } catch (error) {
    const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:github');
    log.error(
      'Error querying GitHub usage',
      error instanceof Error ? error : new Error(String(error))
    );
    return null;
  }
}

/**
 * Build service-level utilization metrics from D1 totals.
 * Returns CloudFlare service utilization data for the usage overview.
 */
function buildCloudflareServiceMetrics(
  totals: DailyCostData['totals'],
  dayOfMonth: number
): ResourceMetricData[] {
  const metrics: ResourceMetricData[] = [];

  // Workers Requests (estimated from cost)
  const workersRequests = totals.workers > 0 ? Math.round((totals.workers / 0.3) * 1_000_000) : 0;
  const workersLimit = CF_ALLOWANCES.workers.limit;
  const workersPct = workersLimit > 0 ? (workersRequests / workersLimit) * 100 : 0;
  const workersOverage = Math.max(0, workersRequests - workersLimit);
  metrics.push({
    id: 'cf-workers',
    label: 'Workers Requests',
    provider: 'cloudflare',
    current: workersRequests,
    limit: workersLimit,
    unit: 'requests',
    percentage: Math.round(workersPct * 10) / 10,
    costEstimate: totals.workers,
    status: getServiceUtilizationStatus(workersPct),
    overage: workersOverage,
    overageCost: workersOverage * (CF_OVERAGE_PRICING.workers ?? 0),
  });

  // D1 Writes (estimated from cost)
  const d1Writes = totals.d1 > 0 ? Math.round(totals.d1 * 1_000_000) : 0;
  const d1Limit = CF_ALLOWANCES.d1.limit;
  const d1Pct = d1Limit > 0 ? (d1Writes / d1Limit) * 100 : 0;
  const d1Overage = Math.max(0, d1Writes - d1Limit);
  metrics.push({
    id: 'cf-d1',
    label: 'D1 Writes',
    provider: 'cloudflare',
    current: d1Writes,
    limit: d1Limit,
    unit: 'rows',
    percentage: Math.round(d1Pct * 10) / 10,
    costEstimate: totals.d1,
    status: getServiceUtilizationStatus(d1Pct),
    overage: d1Overage,
    overageCost: d1Overage * (CF_OVERAGE_PRICING.d1 ?? 0),
  });

  // KV Writes (estimated from cost)
  const kvWrites = totals.kv > 0 ? Math.round((totals.kv / 5) * 1_000_000) : 0;
  const kvLimit = CF_ALLOWANCES.kv.limit;
  const kvPct = kvLimit > 0 ? (kvWrites / kvLimit) * 100 : 0;
  const kvOverage = Math.max(0, kvWrites - kvLimit);
  metrics.push({
    id: 'cf-kv',
    label: 'KV Writes',
    provider: 'cloudflare',
    current: kvWrites,
    limit: kvLimit,
    unit: 'writes',
    percentage: Math.round(kvPct * 10) / 10,
    costEstimate: totals.kv,
    status: getServiceUtilizationStatus(kvPct),
    overage: kvOverage,
    overageCost: kvOverage * (CF_OVERAGE_PRICING.kv ?? 0),
  });

  // R2 Storage (estimated - assuming cost reflects storage)
  const r2Bytes = totals.r2 > 0 ? Math.round((totals.r2 / 0.015) * 1_000_000_000) : 0;
  const r2Limit = CF_ALLOWANCES.r2.limit;
  const r2Pct = r2Limit > 0 ? (r2Bytes / r2Limit) * 100 : 0;
  const r2Overage = Math.max(0, r2Bytes - r2Limit);
  metrics.push({
    id: 'cf-r2',
    label: 'R2 Storage',
    provider: 'cloudflare',
    current: r2Bytes,
    limit: r2Limit,
    unit: 'bytes',
    percentage: Math.round(r2Pct * 10) / 10,
    costEstimate: totals.r2,
    status: getServiceUtilizationStatus(r2Pct),
    overage: r2Overage,
    overageCost: (r2Overage / 1_000_000_000) * (CF_OVERAGE_PRICING.r2 ?? 0),
  });

  // Durable Objects Requests
  const doRequests = totals.durableObjects > 0 ? Math.round(totals.durableObjects * 1_000_000) : 0;
  const doLimit = CF_ALLOWANCES.durableObjects.limit;
  const doPct = doLimit > 0 ? (doRequests / doLimit) * 100 : 0;
  const doOverage = Math.max(0, doRequests - doLimit);
  metrics.push({
    id: 'cf-do',
    label: 'Durable Objects',
    provider: 'cloudflare',
    current: doRequests,
    limit: doLimit,
    unit: 'requests',
    percentage: Math.round(doPct * 10) / 10,
    costEstimate: totals.durableObjects,
    status: getServiceUtilizationStatus(doPct),
    overage: doOverage,
    overageCost: doOverage * (CF_OVERAGE_PRICING.durableObjects ?? 0),
  });

  // Vectorize Dimensions
  const vectorizeDims =
    totals.vectorize > 0 ? Math.round((totals.vectorize / 0.01) * 1_000_000) : 0;
  const vectorizeLimit = CF_ALLOWANCES.vectorize.limit;
  const vectorizePct = vectorizeLimit > 0 ? (vectorizeDims / vectorizeLimit) * 100 : 0;
  const vectorizeOverage = Math.max(0, vectorizeDims - vectorizeLimit);
  metrics.push({
    id: 'cf-vectorize',
    label: 'Vectorize Dimensions',
    provider: 'cloudflare',
    current: vectorizeDims,
    limit: vectorizeLimit,
    unit: 'dimensions',
    percentage: Math.round(vectorizePct * 10) / 10,
    costEstimate: totals.vectorize,
    status: getServiceUtilizationStatus(vectorizePct),
    overage: vectorizeOverage,
    overageCost: vectorizeOverage * (CF_OVERAGE_PRICING.vectorize ?? 0),
  });

  // Workers AI Neurons
  const aiNeurons = totals.workersAI > 0 ? Math.round((totals.workersAI / 0.011) * 1000) : 0;
  const aiLimit = CF_ALLOWANCES.workersAI.limit * dayOfMonth; // Daily limit x days
  const aiPct = aiLimit > 0 ? (aiNeurons / aiLimit) * 100 : 0;
  const aiOverage = Math.max(0, aiNeurons - aiLimit);
  metrics.push({
    id: 'cf-workers-ai',
    label: 'Workers AI',
    provider: 'cloudflare',
    current: aiNeurons,
    limit: aiLimit,
    unit: 'neurons',
    percentage: Math.round(aiPct * 10) / 10,
    costEstimate: totals.workersAI,
    status: getServiceUtilizationStatus(aiPct),
    overage: aiOverage,
    overageCost: (aiOverage / 1000) * (CF_OVERAGE_PRICING.workersAI ?? 0),
  });

  // Queues Messages
  const queuesMsgs = totals.queues > 0 ? Math.round((totals.queues / 0.4) * 1_000_000) : 0;
  const queuesLimit = CF_ALLOWANCES.queues.limit;
  const queuesPct = queuesLimit > 0 ? (queuesMsgs / queuesLimit) * 100 : 0;
  const queuesOverage = Math.max(0, queuesMsgs - queuesLimit);
  metrics.push({
    id: 'cf-queues',
    label: 'Queues Messages',
    provider: 'cloudflare',
    current: queuesMsgs,
    limit: queuesLimit,
    unit: 'messages',
    percentage: Math.round(queuesPct * 10) / 10,
    costEstimate: totals.queues,
    status: getServiceUtilizationStatus(queuesPct),
    overage: queuesOverage,
    overageCost: queuesOverage * (CF_OVERAGE_PRICING.queues ?? 0),
  });

  // AI Gateway (unlimited, just show usage)
  metrics.push({
    id: 'cf-ai-gateway',
    label: 'AI Gateway',
    provider: 'cloudflare',
    current: 0, // Not tracked in rollups
    limit: null, // Unlimited
    unit: 'requests',
    percentage: 0,
    costEstimate: totals.aiGateway,
    status: 'ok',
    overage: 0,
    overageCost: 0,
  });

  return metrics.filter((m) => m.current > 0 || m.costEstimate > 0);
}

/**
 * Build GitHub service metrics from third_party_usage data.
 */
function buildGitHubServiceMetrics(github: GitHubUsageResponse | null): ResourceMetricData[] {
  if (!github) return [];

  const metrics: ResourceMetricData[] = [];
  const usage = github.mtdUsage;

  // Actions Minutes
  const actionsLimit = usage.actionsMinutesIncluded || 50000;
  const actionsPct = actionsLimit > 0 ? (usage.actionsMinutes / actionsLimit) * 100 : 0;
  const actionsOverage = Math.max(0, usage.actionsMinutes - actionsLimit);
  metrics.push({
    id: 'gh-actions-minutes',
    label: 'Actions Minutes',
    provider: 'github',
    current: usage.actionsMinutes,
    limit: actionsLimit,
    unit: 'minutes',
    percentage: Math.round(actionsPct * 10) / 10,
    costEstimate: actionsOverage * 0.008, // Overage at $0.008/min
    status: getServiceUtilizationStatus(actionsPct),
    overage: actionsOverage,
    overageCost: actionsOverage * 0.008,
  });

  // Actions Storage
  const storageLimit = usage.actionsStorageGbIncluded || 50;
  const storageGb = usage.actionsStorageGbHours / 24; // Convert to GB (approx)
  const storagePct = storageLimit > 0 ? (storageGb / storageLimit) * 100 : 0;
  const storageOverage = Math.max(0, storageGb - storageLimit);
  metrics.push({
    id: 'gh-actions-storage',
    label: 'Actions Storage',
    provider: 'github',
    current: Math.round(storageGb * 100) / 100,
    limit: storageLimit,
    unit: 'GB',
    percentage: Math.round(storagePct * 10) / 10,
    costEstimate: storageOverage * 0.25, // Overage at $0.25/GB
    status: getServiceUtilizationStatus(storagePct),
    overage: storageOverage,
    overageCost: storageOverage * 0.25,
  });

  // GHAS Code Security (subscription, not utilization-based)
  if (usage.ghasCodeSecuritySeats > 0) {
    metrics.push({
      id: 'gh-ghas-code',
      label: 'GHAS Code Security',
      provider: 'github',
      current: usage.ghasCodeSecuritySeats,
      limit: null, // Subscription-based
      unit: 'seats',
      percentage: 100, // Fixed subscription
      costEstimate: usage.ghasCodeSecuritySeats * 49,
      status: 'ok',
      overage: 0,
      overageCost: 0,
    });
  }

  // GHAS Secret Protection
  if (usage.ghasSecretProtectionSeats > 0) {
    metrics.push({
      id: 'gh-ghas-secrets',
      label: 'GHAS Secret Protection',
      provider: 'github',
      current: usage.ghasSecretProtectionSeats,
      limit: null, // Subscription-based
      unit: 'seats',
      percentage: 100,
      costEstimate: usage.ghasSecretProtectionSeats * 31,
      status: 'ok',
      overage: 0,
      overageCost: 0,
    });
  }

  // GHEC Users
  if (usage.ghecUserMonths > 0) {
    metrics.push({
      id: 'gh-ghec',
      label: 'GHEC Seats',
      provider: 'github',
      current: usage.ghecUserMonths,
      limit: null, // Subscription-based
      unit: 'users',
      percentage: 100,
      costEstimate: usage.ghecUserMonths * 21,
      status: 'ok',
      overage: 0,
      overageCost: 0,
    });
  }

  return metrics;
}

/**
 * Calculate provider health summary from service metrics.
 */
function calculateProviderHealth(
  metrics: ResourceMetricData[],
  provider: 'cloudflare' | 'github'
): ProviderHealthData {
  const utilizationMetrics = metrics.filter((m) => m.limit !== null && m.limit > 0);

  if (utilizationMetrics.length === 0) {
    return { provider, percentage: 0, warnings: 0, status: 'ok' };
  }

  // Calculate weighted average by cost, or simple max
  const maxPct = Math.max(...utilizationMetrics.map((m) => m.percentage));
  const warnings = utilizationMetrics.filter(
    (m) => m.status === 'warning' || m.status === 'critical' || m.status === 'overage'
  ).length;

  return {
    provider,
    percentage: Math.round(maxPct),
    warnings,
    status: getServiceUtilizationStatus(maxPct),
  };
}

// =============================================================================
// HANDLER FUNCTIONS
// =============================================================================

/**
 * Handle GET /usage
 *
 * Primary data source: D1 (hourly/daily rollups)
 * Fallback: Live GraphQL API if D1 data is missing
 * Added: Projected monthly burn calculation
 */
export async function handleUsage(url: URL, env: Env): Promise<Response> {
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:handle');
  const startTime = Date.now();
  const { period, project } = await parseQueryParamsWithRegistry(url, env);
  const cacheKey = getCacheKey('usage', period, project);

  // Build project lookup cache for filtering (used in GraphQL fallback)
  const projectLookupCache = await buildProjectLookupCache(env);

  // Check KV cache first
  try {
    const cached = (await env.PLATFORM_CACHE.get(cacheKey, 'json')) as
      | (UsageResponse & { dataSource?: string; projectedBurn?: ProjectedBurn })
      | null;
    if (cached) {
      log.info('Cache hit', { tag: 'USAGE', cacheKey });
      return jsonResponse({
        ...cached,
        cached: true,
        responseTimeMs: Date.now() - startTime,
      });
    }
  } catch (error) {
    log.error('Cache read error', error as Error, { tag: 'USAGE', cacheKey });
  }

  log.info('Cache miss, fetching fresh data', { tag: 'USAGE', cacheKey });

  // Try D1 first as primary data source
  const d1Data = await queryD1UsageData(env, period, project);
  const projectedBurn = await calculateProjectedBurn(env, project);

  if (d1Data && d1Data.rowCount > 0) {
    // D1 has data - use it as primary source
    log.info('Using D1 data source', { tag: 'USAGE', rowCount: d1Data.rowCount });

    const costs = d1Data.costs;
    const response = {
      success: true,
      period,
      project,
      timestamp: new Date().toISOString(),
      cached: false,
      dataSource: 'd1' as const,
      data: {
        // D1 doesn't store per-resource details, provide summary only
        workers: [] as AccountUsage['workers'],
        d1: [] as AccountUsage['d1'],
        kv: [] as AccountUsage['kv'],
        r2: [] as AccountUsage['r2'],
        durableObjects: {
          requests: 0,
          responseBodySize: 0,
          gbSeconds: 0,
          storageReadUnits: 0,
          storageWriteUnits: 0,
          storageDeleteUnits: 0,
        } as AccountUsage['durableObjects'],
        vectorize: [] as AccountUsage['vectorize'],
        aiGateway: [] as AccountUsage['aiGateway'],
        pages: [] as AccountUsage['pages'],
        summary: {
          totalWorkers: 0,
          totalD1Databases: 0,
          totalKVNamespaces: 0,
          totalR2Buckets: 0,
          totalVectorizeIndexes: 0,
          totalAIGateways: 0,
          totalPagesProjects: 0,
          totalRequests: 0,
          totalRowsRead: 0,
          totalRowsWritten: 0,
        },
      },
      costs: {
        ...costs,
        formatted: {
          workers: formatCurrency(costs.workers),
          d1: formatCurrency(costs.d1),
          kv: formatCurrency(costs.kv),
          r2: formatCurrency(costs.r2),
          durableObjects: formatCurrency(costs.durableObjects),
          vectorize: formatCurrency(costs.vectorize),
          aiGateway: formatCurrency(costs.aiGateway),
          pages: formatCurrency(costs.pages),
          queues: formatCurrency(costs.queues),
          workersAI: formatCurrency(costs.workersAI),
          total: formatCurrency(costs.total),
        },
      },
      projectCosts: [] as ProjectCostBreakdown[],
      thresholds: {
        workers: { level: 'normal' as const, percentage: 0 },
        d1: { level: 'normal' as const, percentage: 0 },
        kv: { level: 'normal' as const, percentage: 0 },
        r2: { level: 'normal' as const, percentage: 0 },
        durableObjects: { level: 'normal' as const, percentage: 0 },
        vectorize: { level: 'normal' as const, percentage: 0 },
        aiGateway: { level: 'normal' as const, percentage: 0 },
        pages: { level: 'normal' as const, percentage: 0 },
      },
      projectedBurn,
    };

    // Cache the response in KV (1hr TTL)
    try {
      await env.PLATFORM_CACHE.put(cacheKey, JSON.stringify(response), { expirationTtl: 1800 });
      log.info('Cached D1 response', { tag: 'USAGE', cacheKey });
    } catch (error) {
      log.error('Cache write error', error as Error, { tag: 'USAGE', cacheKey });
    }

    const duration = Date.now() - startTime;
    log.info('Fetched D1 data', { tag: 'USAGE', durationMs: duration });

    return jsonResponse({
      ...response,
      responseTimeMs: duration,
    });
  }

  // Fallback to live GraphQL if D1 is empty
  log.info('D1 empty, falling back to GraphQL', { tag: 'USAGE' });

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
    const client = new CloudflareGraphQL(env);
    const allMetrics = await client.getAllMetrics(period);
    // Use D1 registry-backed filtering with pattern fallback
    const filteredMetrics = filterByProjectWithRegistry(allMetrics, project, projectLookupCache);
    const costs = calculateMonthlyCosts(filteredMetrics);
    const projectCosts = calculateProjectCosts(allMetrics);
    const thresholds = analyseThresholds(allMetrics);

    const response = {
      success: true,
      period,
      project,
      timestamp: new Date().toISOString(),
      cached: false,
      dataSource: 'graphql' as const,
      data: {
        workers: filteredMetrics.workers,
        d1: filteredMetrics.d1,
        kv: filteredMetrics.kv,
        r2: filteredMetrics.r2,
        durableObjects: filteredMetrics.durableObjects,
        vectorize: filteredMetrics.vectorize,
        aiGateway: filteredMetrics.aiGateway,
        pages: filteredMetrics.pages,
        summary: calculateSummary(filteredMetrics),
      },
      costs: {
        ...costs,
        formatted: {
          workers: formatCurrency(costs.workers),
          d1: formatCurrency(costs.d1),
          kv: formatCurrency(costs.kv),
          r2: formatCurrency(costs.r2),
          durableObjects: formatCurrency(costs.durableObjects),
          vectorize: formatCurrency(costs.vectorize),
          aiGateway: formatCurrency(costs.aiGateway),
          pages: formatCurrency(costs.pages),
          queues: formatCurrency(costs.queues),
          workflows: formatCurrency(costs.workflows),
          total: formatCurrency(costs.total),
        },
      },
      projectCosts,
      thresholds,
      projectedBurn,
    };

    // Cache the response in KV (1hr TTL)
    try {
      await env.PLATFORM_CACHE.put(cacheKey, JSON.stringify(response), { expirationTtl: 1800 });
      log.info('Cached GraphQL response', { tag: 'USAGE', cacheKey });
    } catch (error) {
      log.error('Cache write error', error as Error, { tag: 'USAGE', cacheKey });
    }

    const duration = Date.now() - startTime;
    log.info('Fetched GraphQL data', { tag: 'USAGE', durationMs: duration });

    return jsonResponse({
      ...response,
      responseTimeMs: duration,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('Error fetching usage data', error as Error, { tag: 'USAGE' });

    return jsonResponse(
      {
        success: false,
        error: 'Failed to fetch usage data',
        message: errorMessage,
      },
      500
    );
  }
}

/**
 * Handle GET /usage/costs
 */
export async function handleCosts(url: URL, env: Env): Promise<Response> {
  const startTime = Date.now();
  const { period } = parseQueryParams(url);
  const cacheKey = getCacheKey('costs', period, 'all');

  try {
    const cached = (await env.PLATFORM_CACHE.get(cacheKey, 'json')) as Record<
      string,
      unknown
    > | null;
    if (cached) {
      return jsonResponse({
        success: true,
        cached: true,
        ...cached,
        responseTimeMs: Date.now() - startTime,
      });
    }
  } catch {
    // Continue with fresh fetch
  }

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
    const client = new CloudflareGraphQL(env);
    const metrics = await client.getAllMetrics(period);
    const costs = calculateMonthlyCosts(metrics);
    const projectCosts = calculateProjectCosts(metrics);

    const response = {
      period,
      timestamp: new Date().toISOString(),
      costs: {
        ...costs,
        formatted: {
          workers: formatCurrency(costs.workers),
          d1: formatCurrency(costs.d1),
          kv: formatCurrency(costs.kv),
          r2: formatCurrency(costs.r2),
          durableObjects: formatCurrency(costs.durableObjects),
          vectorize: formatCurrency(costs.vectorize),
          aiGateway: formatCurrency(costs.aiGateway),
          pages: formatCurrency(costs.pages),
          queues: formatCurrency(costs.queues),
          workflows: formatCurrency(costs.workflows),
          total: formatCurrency(costs.total),
        },
      },
      projectCosts,
    };

    try {
      await env.PLATFORM_CACHE.put(cacheKey, JSON.stringify(response), { expirationTtl: 1800 });
    } catch {
      // Continue without caching
    }

    return jsonResponse({
      success: true,
      cached: false,
      ...response,
      responseTimeMs: Date.now() - startTime,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return jsonResponse(
      {
        success: false,
        error: 'Failed to fetch cost data',
        message: errorMessage,
      },
      500
    );
  }
}

/**
 * Handle GET /usage/thresholds
 */
export async function handleThresholds(url: URL, env: Env): Promise<Response> {
  const startTime = Date.now();
  const { period } = parseQueryParams(url);

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
    const client = new CloudflareGraphQL(env);
    const metrics = await client.getAllMetrics(period);
    const thresholds = analyseThresholds(metrics);

    return jsonResponse({
      success: true,
      period,
      timestamp: new Date().toISOString(),
      thresholds,
      responseTimeMs: Date.now() - startTime,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return jsonResponse(
      {
        success: false,
        error: 'Failed to analyse thresholds',
        message: errorMessage,
      },
      500
    );
  }
}

/**
 * Handle GET /usage/enhanced
 */
export async function handleEnhanced(url: URL, env: Env): Promise<Response> {
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:enhanced');
  const startTime = Date.now();
  const { period, project } = await parseQueryParamsWithRegistry(url, env);
  const cacheKey = getCacheKey('enhanced', period, project);

  try {
    const cached = (await env.PLATFORM_CACHE.get(cacheKey, 'json')) as EnhancedUsageResponse | null;
    if (cached) {
      log.info('Enhanced cache hit', { tag: 'USAGE', cacheKey });
      return jsonResponse({
        ...cached,
        cached: true,
        responseTimeMs: Date.now() - startTime,
      });
    }
  } catch (error) {
    log.error('Enhanced cache read error', error as Error, { tag: 'USAGE', cacheKey });
  }

  log.info('Enhanced cache miss, fetching fresh data', { tag: 'USAGE', cacheKey });

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

  // Build project lookup cache for D1 registry-backed filtering
  const projectLookupCache = await buildProjectLookupCache(env);

  try {
    const client = new CloudflareGraphQL(env);
    const enhancedMetrics = await client.getAllEnhancedMetrics(period);
    const filteredMetrics = filterByProjectWithRegistry(
      enhancedMetrics,
      project,
      projectLookupCache
    );
    const costs = calculateMonthlyCosts(filteredMetrics);
    const projectCosts = calculateProjectCosts(enhancedMetrics);
    const thresholds = analyseThresholds(enhancedMetrics);
    const totalErrors = filteredMetrics.workers.reduce((sum, w) => sum + w.errors, 0);

    const response: EnhancedUsageResponse = {
      success: true,
      period,
      project,
      timestamp: new Date().toISOString(),
      cached: false,
      data: {
        workers: filteredMetrics.workers,
        d1: filteredMetrics.d1,
        kv: filteredMetrics.kv,
        r2: filteredMetrics.r2,
        durableObjects: filteredMetrics.durableObjects,
        vectorize: filteredMetrics.vectorize,
        aiGateway: filteredMetrics.aiGateway,
        pages: filteredMetrics.pages,
        summary: {
          ...calculateSummary(filteredMetrics),
          totalErrors,
        } as UsageResponse['data']['summary'] & { totalErrors: number },
      },
      sparklines: enhancedMetrics.sparklines,
      errorBreakdown: enhancedMetrics.errorBreakdown,
      queues: enhancedMetrics.queues,
      cache: enhancedMetrics.cache,
      comparison: enhancedMetrics.comparison,
      costs: {
        ...costs,
        formatted: {
          workers: formatCurrency(costs.workers),
          d1: formatCurrency(costs.d1),
          kv: formatCurrency(costs.kv),
          r2: formatCurrency(costs.r2),
          durableObjects: formatCurrency(costs.durableObjects),
          vectorize: formatCurrency(costs.vectorize),
          aiGateway: formatCurrency(costs.aiGateway),
          pages: formatCurrency(costs.pages),
          queues: formatCurrency(costs.queues),
          workflows: formatCurrency(costs.workflows),
          total: formatCurrency(costs.total),
        },
      },
      projectCosts,
      thresholds,
    };

    try {
      await env.PLATFORM_CACHE.put(cacheKey, JSON.stringify(response), { expirationTtl: 1800 });
      log.info('Enhanced cached response', { tag: 'USAGE', cacheKey });
    } catch (error) {
      log.error('Enhanced cache write error', error as Error, { tag: 'USAGE', cacheKey });
    }

    const duration = Date.now() - startTime;
    log.info('Enhanced usage data fetched', { tag: 'USAGE', durationMs: duration });

    return jsonResponse({
      ...response,
      responseTimeMs: duration,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('Enhanced error fetching usage data', error as Error, { tag: 'USAGE' });

    return jsonResponse(
      {
        success: false,
        error: 'Failed to fetch enhanced usage data',
        message: errorMessage,
      },
      500
    );
  }
}

/**
 * Handle GET /usage/compare (task-17.3, 17.4)
 *
 * Query params:
 * - compare: 'lastMonth' | 'custom' (required)
 * - period: '24h' | '7d' | '30d' (for compare=lastMonth)
 * - startDate, endDate: YYYY-MM-DD (for compare=custom)
 * - priorStartDate, priorEndDate: YYYY-MM-DD (optional, for compare=custom)
 * - project: 'all' | <your-project-ids> (from project_registry)
 */
export async function handleCompare(url: URL, env: Env): Promise<Response> {
  const startTime = Date.now();
  const compareParam = url.searchParams.get('compare') as CompareMode | null;
  const { period, project } = parseQueryParams(url);

  // Validate compare mode
  if (!compareParam || (compareParam !== 'lastMonth' && compareParam !== 'custom')) {
    return jsonResponse(
      {
        success: false,
        error: 'Invalid compare mode',
        message: "compare parameter must be 'lastMonth' or 'custom'",
      },
      400
    );
  }

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
    const client = new CloudflareGraphQL(env);
    let currentRange: DateRange;
    let priorRange: DateRange;

    if (compareParam === 'lastMonth') {
      // Use period to determine date range, then get same period last month
      const now = new Date();
      const endDate = now.toISOString().split('T')[0]!;

      const startDate = new Date(now);
      switch (period) {
        case '24h':
          startDate.setDate(startDate.getDate() - 1);
          break;
        case '7d':
          startDate.setDate(startDate.getDate() - 7);
          break;
        case '30d':
          startDate.setDate(startDate.getDate() - 30);
          break;
      }

      currentRange = {
        startDate: startDate.toISOString().split('T')[0]!,
        endDate,
      };

      priorRange = CloudflareGraphQL.getSamePeriodLastMonth(
        currentRange.startDate,
        currentRange.endDate
      );
    } else {
      // Custom date range
      const startDate = url.searchParams.get('startDate');
      const endDate = url.searchParams.get('endDate');
      const priorStartDate = url.searchParams.get('priorStartDate') ?? undefined;
      const priorEndDate = url.searchParams.get('priorEndDate') ?? undefined;

      if (!startDate || !endDate) {
        return jsonResponse(
          {
            success: false,
            error: 'Missing date parameters',
            message: 'startDate and endDate are required for compare=custom',
          },
          400
        );
      }

      const validation = CloudflareGraphQL.validateCustomDateRange({
        startDate,
        endDate,
        priorStartDate,
        priorEndDate,
      });

      if ('error' in validation) {
        return jsonResponse(
          {
            success: false,
            error: 'Invalid date range',
            message: validation.error,
          },
          400
        );
      }

      currentRange = validation.current;
      priorRange = validation.prior;
    }

    // Fetch metrics for both periods in parallel
    const [currentMetricsRaw, priorMetricsRaw] = await Promise.all([
      client.getMetricsForDateRange(currentRange),
      client.getMetricsForDateRange(priorRange),
    ]);

    // Filter by project
    const currentMetrics = filterByProject(currentMetricsRaw, project);
    const priorMetrics = filterByProject(priorMetricsRaw, project);

    // Calculate costs and summaries
    const currentCosts = calculateMonthlyCosts(currentMetrics);
    const priorCosts = calculateMonthlyCosts(priorMetrics);
    const currentSummary = calculateSummary(currentMetrics);
    const priorSummary = calculateSummary(priorMetrics);

    // Calculate comparisons
    const currentRequests = currentMetrics.workers.reduce((s, w) => s + w.requests, 0);
    const priorRequests = priorMetrics.workers.reduce((s, w) => s + w.requests, 0);
    const currentErrors = currentMetrics.workers.reduce((s, w) => s + w.errors, 0);
    const priorErrors = priorMetrics.workers.reduce((s, w) => s + w.errors, 0);
    const currentD1Rows = currentMetrics.d1.reduce((s, d) => s + d.rowsRead, 0);
    const priorD1Rows = priorMetrics.d1.reduce((s, d) => s + d.rowsRead, 0);

    const response: ComparisonResponse = {
      success: true,
      compareMode: compareParam,
      current: {
        dateRange: currentRange,
        summary: currentSummary,
        costs: currentCosts,
        data: currentMetrics,
      },
      prior: {
        dateRange: priorRange,
        summary: priorSummary,
        costs: priorCosts,
        data: priorMetrics,
      },
      comparison: {
        workersRequests: {
          current: currentRequests,
          previous: priorRequests,
          ...calcTrend(currentRequests, priorRequests),
        },
        workersErrors: {
          current: currentErrors,
          previous: priorErrors,
          ...calcTrend(currentErrors, priorErrors),
        },
        d1RowsRead: {
          current: currentD1Rows,
          previous: priorD1Rows,
          ...calcTrend(currentD1Rows, priorD1Rows),
        },
        totalCost: {
          current: currentCosts.total,
          previous: priorCosts.total,
          ...calcTrend(currentCosts.total, priorCosts.total),
        },
      },
      timestamp: new Date().toISOString(),
      cached: false,
    };

    const duration = Date.now() - startTime;
    const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:compare');
    log.info('Comparison data fetched', { tag: 'COMPARE_FETCHED', durationMs: duration });

    return jsonResponse({
      ...response,
      responseTimeMs: duration,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:compare');
    log.error('Error fetching comparison data', error instanceof Error ? error : undefined, {
      tag: 'COMPARE_ERROR',
      errorMessage,
    });

    return jsonResponse(
      {
        success: false,
        error: 'Failed to fetch comparison data',
        message: errorMessage,
      },
      500
    );
  }
}

/**
 * Handle GET /usage/daily (task-18)
 *
 * Returns daily cost breakdown for interactive chart and table.
 * Supports period-based or custom date range queries.
 *
 * Query params:
 * - period: '24h' | '7d' | '30d' | 'custom' (default: '30d')
 * - startDate: YYYY-MM-DD (required for period=custom)
 * - endDate: YYYY-MM-DD (required for period=custom)
 */
export async function handleDaily(url: URL, env: Env): Promise<Response> {
  const startTime = Date.now();
  const periodParam = url.searchParams.get('period') ?? '30d';
  const startDateParam = url.searchParams.get('startDate');
  const endDateParam = url.searchParams.get('endDate');
  const projectParam = url.searchParams.get('project') ?? 'all';

  // Build cache key (include project in key for per-project caching)
  let cacheKeyPart: string;
  if (periodParam === 'custom' && startDateParam && endDateParam) {
    cacheKeyPart = `custom:${startDateParam}:${endDateParam}`;
  } else {
    const validPeriods: SharedTimePeriod[] = ['24h', '7d', '30d'];
    const period: SharedTimePeriod = validPeriods.includes(periodParam as SharedTimePeriod)
      ? (periodParam as SharedTimePeriod)
      : '30d';
    cacheKeyPart = period;
  }

  const hourTimestamp = Math.floor(Date.now() / (60 * 60 * 1000));
  const cacheKey = `daily:${projectParam}:${cacheKeyPart}:${hourTimestamp}`;

  // Check for cache bypass parameter
  const noCache = url.searchParams.get('nocache') === 'true';
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:daily');

  // Check cache first (unless nocache=true)
  if (!noCache) {
    try {
      const cached = (await env.PLATFORM_CACHE.get(cacheKey, 'json')) as DailyCostResponse | null;
      if (cached) {
        log.info('Daily cache hit', { tag: 'CACHE_HIT', cacheKey });
        return jsonResponse({
          ...cached,
          cached: true,
          responseTimeMs: Date.now() - startTime,
        });
      }
    } catch (error) {
      log.error('Daily cache read error', error instanceof Error ? error : undefined, {
        tag: 'CACHE_READ_ERROR',
        cacheKey,
      });
    }
  } else {
    log.info('Daily cache bypassed', { tag: 'CACHE_BYPASS', cacheKey });
  }

  log.info('Daily cache miss, fetching fresh data', { tag: 'CACHE_MISS', cacheKey });

  // Parse period for D1 query
  let d1Period: SharedTimePeriod | { start: string; end: string };
  let periodDisplay: string;

  if (periodParam === 'custom' && startDateParam && endDateParam) {
    // Validate date range (max 90 days)
    const startDate = new Date(startDateParam);
    const endDate = new Date(endDateParam);
    const diffDays = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));

    if (diffDays > 90) {
      return jsonResponse(
        {
          success: false,
          error: 'Invalid date range',
          message: 'Date range cannot exceed 90 days',
        },
        400
      );
    }

    if (diffDays < 1) {
      return jsonResponse(
        {
          success: false,
          error: 'Invalid date range',
          message: 'End date must be after start date',
        },
        400
      );
    }

    d1Period = { start: startDateParam, end: endDateParam };
    periodDisplay = `${startDateParam} to ${endDateParam}`;
  } else {
    // Standard period-based query
    const validPeriods: SharedTimePeriod[] = ['24h', '7d', '30d'];
    d1Period = validPeriods.includes(periodParam as SharedTimePeriod)
      ? (periodParam as SharedTimePeriod)
      : '30d';
    periodDisplay = periodParam;
  }

  try {
    // Try D1 Data Warehouse first (pass project filter)
    const d1Data = await queryD1DailyCosts(env, d1Period, projectParam);

    if (d1Data && d1Data.days.length > 0) {
      log.info('Daily data from D1', {
        tag: 'D1_DATA',
        dayCount: d1Data.days.length,
        project: projectParam,
      });

      const response: DailyCostResponse & { dataSource: string; project: string } = {
        success: true,
        period: periodDisplay,
        project: projectParam,
        dataSource: 'd1',
        data: d1Data,
        cached: false,
        timestamp: new Date().toISOString(),
      };

      // Cache for 1 hour
      try {
        await env.PLATFORM_CACHE.put(cacheKey, JSON.stringify(response), { expirationTtl: 1800 });
        log.info('Daily cached D1 response', { tag: 'CACHE_WRITE', cacheKey });
      } catch (error) {
        log.error('Daily cache write error', error instanceof Error ? error : undefined, {
          tag: 'CACHE_WRITE_ERROR',
          cacheKey,
        });
      }

      const duration = Date.now() - startTime;
      log.info('Daily data from D1', { tag: 'D1_COMPLETE', durationMs: duration });

      return jsonResponse({
        ...response,
        responseTimeMs: duration,
      });
    }

    // D1 is empty - return no_data response (GraphQL fallback disabled)
    log.info('D1 empty - returning no_data response (GraphQL fallback disabled)', {
      tag: 'D1_EMPTY',
    });

    const emptyTotals: DailyCostData['totals'] = {
      workers: 0,
      d1: 0,
      kv: 0,
      r2: 0,
      durableObjects: 0,
      vectorize: 0,
      aiGateway: 0,
      workersAI: 0,
      pages: 0,
      queues: 0,
      workflows: 0,
      total: 0,
    };

    const emptyData: DailyCostData = {
      days: [],
      totals: emptyTotals,
      period: {
        start: typeof d1Period === 'object' ? d1Period.start : '',
        end: typeof d1Period === 'object' ? d1Period.end : '',
      },
    };

    const response: DailyCostResponse & {
      dataSource: string;
      dataAvailability: string;
      message: string;
    } = {
      success: true,
      period: periodDisplay,
      dataSource: 'none',
      dataAvailability: 'no_data',
      message:
        'Daily rollups not yet available. Data collection started recently and will populate after midnight UTC.',
      data: emptyData,
      cached: false,
      timestamp: new Date().toISOString(),
    };

    const duration = Date.now() - startTime;
    log.info('Returning empty daily data', { tag: 'EMPTY_RESPONSE', durationMs: duration });

    return jsonResponse({
      ...response,
      responseTimeMs: duration,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('Error fetching daily data', error instanceof Error ? error : undefined, {
      tag: 'DAILY_ERROR',
      errorMessage,
    });

    return jsonResponse(
      {
        success: false,
        error: 'Failed to fetch daily cost data',
        message: errorMessage,
      },
      500
    );
  }
}

/**
 * Handle GET /usage/status
 *
 * Returns project status data for the unified dashboard including:
 * - Circuit breaker state per project
 * - MTD spend and cap
 * - Usage percentage
 * - Operational status (RUN/WARN/STOP)
 *
 * Supports ?period parameter for different time ranges.
 */
export async function handleStatus(url: URL, env: Env): Promise<Response> {
  const startTime = Date.now();

  try {
    // Get period param (default 30d for MTD)
    const period = url.searchParams.get('period') || '30d';

    // Get projects from D1 registry
    const allProjects = await getProjects(env.PLATFORM_DB);
    const projectsWithConfig = allProjects
      .map((p: Project) => ({ project: p, config: getProjectConfig(p) }))
      .filter(
        (p: {
          project: Project;
          config: ReturnType<typeof getProjectConfig>;
        }): p is { project: Project; config: NonNullable<ReturnType<typeof getProjectConfig>> } =>
          p.config !== null
      );

    // Get date range based on period
    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth();
    const mtdStartDate = new Date(Date.UTC(currentYear, currentMonth, 1))
      .toISOString()
      .slice(0, 10);
    const mtdEndDate = now.toISOString().slice(0, 10);

    // Query per-project MTD costs
    const projectIds = projectsWithConfig.map(
      (p: { project: Project; config: NonNullable<ReturnType<typeof getProjectConfig>> }) =>
        p.project.projectId
    );
    const projectCostPromises = projectIds.map(async (projectId: string) => {
      const projectData = await queryD1DailyCosts(
        env,
        { start: mtdStartDate, end: mtdEndDate },
        projectId
      );
      return { projectId, mtdCost: projectData?.totals?.total ?? 0 };
    });
    const projectCostResults = await Promise.all(projectCostPromises);
    const perProjectCosts: Record<string, number> = {};
    for (const result of projectCostResults) {
      perProjectCosts[result.projectId] = result.mtdCost;
    }

    // Get circuit breaker status from KV for all registered projects
    // TODO: Add your project IDs to project_registry in D1
    const cbStatuses: Record<string, string> = {};
    {
      const projectRows = await env.PLATFORM_DB.prepare(
        `SELECT project_id FROM project_registry WHERE project_id != 'all'`
      ).all<{ project_id: string }>();
      const projectIds = projectRows.results?.map((r) => r.project_id) ?? ['platform'];
      const cbResults = await Promise.all(
        projectIds.map(async (pid) => {
          const cbKey = `PROJECT:${pid.toUpperCase().replace(/-/g, '-')}:STATUS`;
          const status = await env.PLATFORM_CACHE.get(cbKey);
          return { pid, status };
        })
      );
      for (const { pid, status } of cbResults) {
        cbStatuses[pid] = status ?? 'active';
      }
    }

    // Query feature_registry to find which projects have CB-enabled features
    const projectsWithCBEnabled = new Set<string>();
    try {
      const cbEnabledResult = await env.PLATFORM_DB.prepare(
        `
        SELECT DISTINCT project_id
        FROM feature_registry
        WHERE circuit_breaker_enabled = 1
      `
      ).all();
      for (const row of cbEnabledResult.results ?? []) {
        projectsWithCBEnabled.add(row.project_id as string);
      }
    } catch {
      // Fallback: add all known projects from cbStatuses
      for (const pid of Object.keys(cbStatuses)) {
        projectsWithCBEnabled.add(pid);
      }
    }

    // Build project status map
    const projects: Record<
      string,
      {
        status: 'RUN' | 'WARN' | 'STOP';
        spend: number;
        cap: number;
        percentage: number;
        circuitBreaker: 'active' | 'tripped' | 'disabled';
        lastSeen?: string;
      }
    > = {};

    // Get budget thresholds
    const { softBudgetLimit, warningThreshold } = await getBudgetThresholds(env);

    for (const { project, config } of projectsWithConfig) {
      const projectId = project.projectId;
      const spend = perProjectCosts[projectId] ?? 0;

      // Use project-specific cap if available, else account-level soft limit
      const cap = config.customLimit ?? softBudgetLimit;
      const percentage = cap > 0 ? (spend / cap) * 100 : 0;

      // Get circuit breaker state
      const cbKvState = cbStatuses[projectId] ?? 'active';
      const hasCBEnabled = projectsWithCBEnabled.has(projectId);

      let circuitBreaker: 'active' | 'tripped' | 'disabled' = 'disabled';
      if (hasCBEnabled) {
        // Map KV status values to CB state
        if (cbKvState === 'paused') {
          circuitBreaker = 'tripped';
        } else if (cbKvState === 'warning') {
          circuitBreaker = 'active'; // Warning is still operational
        } else {
          circuitBreaker = 'active';
        }
      }

      // Determine operational status
      let status: 'RUN' | 'WARN' | 'STOP' = 'RUN';
      if (circuitBreaker === 'tripped') {
        status = 'STOP';
      } else if (percentage > 100) {
        status = 'STOP';
      } else if (percentage > 80 || cbKvState === 'warning') {
        status = 'WARN';
      }

      projects[projectId] = {
        status,
        spend,
        cap,
        percentage: Math.round(percentage * 10) / 10,
        circuitBreaker,
      };
    }

    return jsonResponse({
      success: true,
      period,
      projects,
      timestamp: new Date().toISOString(),
      responseTimeMs: Date.now() - startTime,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:status');
    log.error('Error fetching status', error instanceof Error ? error : undefined, {
      errorMessage,
    });

    return jsonResponse(
      {
        success: false,
        error: 'Failed to fetch status',
        message: errorMessage,
      },
      500
    );
  }
}

/**
 * Handle GET /usage/projects
 *
 * Returns the list of projects from the D1 registry with resource counts,
 * service allowances, and projected monthly cost based on MTD burn rate.
 * Used by the dashboard to populate project selectors and show overview.
 */
export async function handleProjects(env: Env): Promise<Response> {
  const startTime = Date.now();
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:projects');

  // Cache key (hourly refresh)
  const hourTimestamp = Math.floor(Date.now() / (60 * 60 * 1000));
  const cacheKey = `projects:list:v2:${hourTimestamp}`;

  // Check cache first
  try {
    const cached = (await env.PLATFORM_CACHE.get(cacheKey, 'json')) as ProjectListResponse | null;
    if (cached) {
      log.info('Projects cache hit', { tag: 'CACHE_HIT', cacheKey });
      return jsonResponse({
        ...cached,
        cached: true,
        responseTimeMs: Date.now() - startTime,
      });
    }
  } catch (error) {
    log.error('Projects cache read error', error instanceof Error ? error : undefined, {
      tag: 'CACHE_READ_ERROR',
      cacheKey,
    });
  }

  try {
    // Get all projects from registry
    const projects = await getProjects(env.PLATFORM_DB);

    // Get resource counts per project
    const resourceCounts = new Map<string, number>();
    const countResult = await env.PLATFORM_DB.prepare(
      `
      SELECT project_id, COUNT(*) as count
      FROM resource_project_mapping
      GROUP BY project_id
    `
    ).all<{ project_id: string; count: number }>();

    for (const row of countResult.results ?? []) {
      resourceCounts.set(row.project_id, row.count);
    }

    // Merge counts with projects
    const projectsWithCounts = projects.map((p: Project) => ({
      ...p,
      resourceCount: resourceCounts.get(p.projectId) ?? 0,
    }));

    // Sort by resource count (most resources first)
    projectsWithCounts.sort(
      (a: Project & { resourceCount: number }, b: Project & { resourceCount: number }) =>
        b.resourceCount - a.resourceCount
    );

    const totalResources = projectsWithCounts.reduce(
      (sum: number, p: Project & { resourceCount: number }) => sum + p.resourceCount,
      0
    );

    // Calculate projected cost from MTD daily_usage_rollups
    const now = new Date();
    const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const daysPassed = now.getUTCDate();
    const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getDate();

    // Get MTD cost from daily rollups (sum across individual projects, not 'all' row)
    // This ensures we get complete data even if the 'all' rollup row is missing for some dates
    const mtdResult = await env.PLATFORM_DB.prepare(
      `
      SELECT SUM(total_cost_usd) as total_cost
      FROM daily_usage_rollups
      WHERE snapshot_date LIKE ? || '%'
        AND project NOT IN ('all', '_unattributed')
    `
    )
      .bind(currentMonth)
      .first<{ total_cost: number | null }>();

    const currentCost = mtdResult?.total_cost ?? 0;
    const projectedMonthlyCost = daysPassed > 0 ? (currentCost / daysPassed) * daysInMonth : 0;

    // Build allowances object from CF_SIMPLE_ALLOWANCES
    const allowances = {
      workers: { limit: CF_ALLOWANCES.workers.limit, unit: CF_ALLOWANCES.workers.unit },
      d1_writes: { limit: CF_ALLOWANCES.d1.limit, unit: CF_ALLOWANCES.d1.unit },
      kv_writes: { limit: CF_ALLOWANCES.kv.limit, unit: CF_ALLOWANCES.kv.unit },
      r2_storage: { limit: CF_ALLOWANCES.r2.limit, unit: CF_ALLOWANCES.r2.unit },
      durableObjects: {
        limit: CF_ALLOWANCES.durableObjects.limit,
        unit: CF_ALLOWANCES.durableObjects.unit,
      },
      vectorize: { limit: CF_ALLOWANCES.vectorize.limit, unit: CF_ALLOWANCES.vectorize.unit },
      // GitHub Enterprise allowance (50K minutes/month)
      github_actions_minutes: { limit: 50000, unit: 'minutes' },
    };

    const projectedCost: ProjectedCost = {
      currentCost,
      daysPassed,
      daysInMonth,
      projectedMonthlyCost,
    };

    const response: ProjectListResponse = {
      success: true,
      projects: projectsWithCounts,
      totalResources,
      timestamp: new Date().toISOString(),
      cached: false,
      allowances,
      projectedCost,
    };

    // Cache for 1 hour
    try {
      await env.PLATFORM_CACHE.put(cacheKey, JSON.stringify(response), { expirationTtl: 3600 });
      log.info('Projects cached', { tag: 'CACHE_WRITE', cacheKey });
    } catch (error) {
      log.error('Projects cache write error', error instanceof Error ? error : undefined, {
        tag: 'CACHE_WRITE_ERROR',
        cacheKey,
      });
    }

    log.info('Projects fetched', {
      tag: 'PROJECTS_FETCHED',
      durationMs: Date.now() - startTime,
      projectCount: projects.length,
      resourceCount: totalResources,
      projectedMonthlyCost: projectedMonthlyCost.toFixed(2),
    });

    return jsonResponse({
      ...response,
      responseTimeMs: Date.now() - startTime,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('Error fetching projects', error instanceof Error ? error : undefined, {
      tag: 'PROJECTS_ERROR',
      errorMessage,
    });

    return jsonResponse(
      {
        success: false,
        error: 'Failed to fetch projects',
        message: errorMessage,
      },
      500
    );
  }
}

/**
 * Handle GET /usage/anomalies
 *
 * Returns detected usage anomalies from the D1 warehouse.
 * Supports filtering by days lookback and resolved status.
 *
 * Query params:
 * - days: Number of days to look back (default: 7, max: 30)
 * - resolved: 'all' | 'true' | 'false' (default: 'all')
 * - limit: Max results (default: 50, max: 100)
 */
export async function handleAnomalies(url: URL, env: Env): Promise<Response> {
  const startTime = Date.now();
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:anomalies');

  // Parse query params
  const daysParam = url.searchParams.get('days');
  const resolvedParam = url.searchParams.get('resolved') ?? 'all';
  const limitParam = url.searchParams.get('limit');

  const days = Math.min(Math.max(parseInt(daysParam ?? '7', 10) || 7, 1), 30);
  const limit = Math.min(Math.max(parseInt(limitParam ?? '50', 10) || 50, 1), 100);

  // Calculate lookback timestamp (days ago)
  const lookbackMs = days * 24 * 60 * 60 * 1000;
  const sinceTimestamp = Math.floor((Date.now() - lookbackMs) / 1000);

  // Cache key (15-min TTL to balance freshness with cost)
  const cacheTimestamp = Math.floor(Date.now() / (15 * 60 * 1000));
  const cacheKey = `anomalies:${days}:${resolvedParam}:${limit}:${cacheTimestamp}`;

  // Check cache first
  try {
    const cached = (await env.PLATFORM_CACHE.get(cacheKey, 'json')) as AnomaliesResponse | null;
    if (cached) {
      log.info('Anomalies cache hit', { tag: 'CACHE_HIT', cacheKey });
      return jsonResponse({
        ...cached,
        cached: true,
        responseTimeMs: Date.now() - startTime,
      });
    }
  } catch (error) {
    log.error('Anomalies cache read error', error instanceof Error ? error : undefined, {
      tag: 'CACHE_READ_ERROR',
      cacheKey,
    });
  }

  try {
    // Build query based on resolved filter
    let whereClause = 'WHERE detected_at >= ?';
    const params: (string | number)[] = [sinceTimestamp];

    if (resolvedParam === 'true') {
      whereClause += ' AND resolved = 1';
    } else if (resolvedParam === 'false') {
      whereClause += ' AND resolved = 0';
    }
    // 'all' doesn't add a filter

    const query = `
      SELECT id, detected_at, metric_name, project,
             current_value, rolling_avg, rolling_stddev, deviation_factor,
             alert_sent, alert_channel, resolved, resolved_at, resolved_by
      FROM usage_anomalies
      ${whereClause}
      ORDER BY detected_at DESC
      LIMIT ?
    `;
    params.push(limit);

    const result = await env.PLATFORM_DB.prepare(query)
      .bind(...params)
      .all<AnomalyRecord>();

    // Count total anomalies (for pagination info)
    const countQuery = `SELECT COUNT(*) as count FROM usage_anomalies ${whereClause}`;
    const countResult = await env.PLATFORM_DB.prepare(countQuery)
      .bind(...params.slice(0, -1)) // Exclude LIMIT param
      .first<{ count: number }>();

    const anomalies = (result.results ?? []).map((row) => ({
      id: row.id,
      detectedAt: new Date(row.detected_at * 1000).toISOString(),
      metric: row.metric_name,
      project: row.project,
      currentValue: row.current_value,
      rollingAvg: row.rolling_avg,
      deviationFactor: Math.round(row.deviation_factor * 10) / 10,
      alertSent: row.alert_sent === 1,
      alertChannel: row.alert_channel,
      resolved: row.resolved === 1,
      resolvedAt: row.resolved_at ? new Date(row.resolved_at * 1000).toISOString() : null,
      resolvedBy: row.resolved_by,
    }));

    const response: AnomaliesResponse = {
      success: true,
      anomalies,
      total: countResult?.count ?? anomalies.length,
      timestamp: new Date().toISOString(),
      cached: false,
    };

    // Cache for 15 minutes
    try {
      await env.PLATFORM_CACHE.put(cacheKey, JSON.stringify(response), {
        expirationTtl: 15 * 60,
      });
    } catch (error) {
      log.error('Anomalies cache write error', error instanceof Error ? error : undefined, {
        tag: 'CACHE_WRITE_ERROR',
        cacheKey,
      });
    }

    log.info('Anomalies fetched', {
      tag: 'ANOMALIES_FETCHED',
      durationMs: Date.now() - startTime,
      anomalyCount: anomalies.length,
      totalCount: countResult?.count ?? 0,
    });

    return jsonResponse({
      ...response,
      responseTimeMs: Date.now() - startTime,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('Error fetching anomalies', error instanceof Error ? error : undefined, {
      tag: 'ANOMALIES_ERROR',
      errorMessage,
    });

    // Return empty array on error (table may not exist yet)
    return jsonResponse({
      success: true,
      anomalies: [],
      total: 0,
      timestamp: new Date().toISOString(),
      cached: false,
      error: errorMessage,
      responseTimeMs: Date.now() - startTime,
    });
  }
}

/**
 * Handle GET /usage/utilization (task-26)
 *
 * Returns burn rate data and per-project utilization for the dashboard.
 * Includes MTD spend, projected monthly total, and project-level metrics.
 */
export async function handleUtilization(url: URL, env: Env): Promise<Response> {
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:utilization');
  const startTime = Date.now();

  // Cache key (hourly)
  const hourTimestamp = Math.floor(Date.now() / (60 * 60 * 1000));
  const cacheKey = `utilization:${hourTimestamp}`;

  // Check cache bypass
  const noCache = url.searchParams.get('nocache') === 'true';

  if (!noCache) {
    try {
      const cached = (await env.PLATFORM_CACHE.get(cacheKey, 'json')) as BurnRateResponse | null;
      if (cached) {
        log.info(`Utilization cache hit for ${cacheKey}`, { tag: 'USAGE' });
        return jsonResponse({
          ...cached,
          cached: true,
          responseTimeMs: Date.now() - startTime,
        });
      }
    } catch (error) {
      log.error(
        'Utilization cache read error',
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  try {
    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth();
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
    const dayOfMonth = now.getUTCDate();
    const daysRemaining = daysInMonth - dayOfMonth;

    // Get MTD dates
    const mtdStartDate = new Date(Date.UTC(currentYear, currentMonth, 1))
      .toISOString()
      .slice(0, 10);
    const mtdEndDate = now.toISOString().slice(0, 10);

    // Billing period (first to last of month)
    const billingStart = new Date(Date.UTC(currentYear, currentMonth, 1))
      .toISOString()
      .slice(0, 10);
    const billingEnd = new Date(Date.UTC(currentYear, currentMonth + 1, 0))
      .toISOString()
      .slice(0, 10);

    // Query D1 for MTD costs (using 30d period or custom range)
    const d1Data = await queryD1DailyCosts(env, { start: mtdStartDate, end: mtdEndDate }, 'all');

    // Get projects from D1 registry
    const allProjects = await getProjects(env.PLATFORM_DB);
    // Filter to only projects with usage config (from D1 or fallback)
    const projectsWithConfig = allProjects
      .map((p: Project) => ({ project: p, config: getProjectConfig(p) }))
      .filter(
        (p: {
          project: Project;
          config: ReturnType<typeof getProjectConfig>;
        }): p is { project: Project; config: NonNullable<ReturnType<typeof getProjectConfig>> } =>
          p.config !== null
      );

    // Query per-project MTD costs
    const perProjectCosts: Record<string, { mtdCost: number; sparkline: number[] }> = {};
    const projectIds = projectsWithConfig.map(
      (p: { project: Project; config: NonNullable<ReturnType<typeof getProjectConfig>> }) =>
        p.project.projectId
    );

    // Batch query per-project costs in parallel
    const projectCostPromises = projectIds.map(async (projectId: string) => {
      const projectData = await queryD1DailyCosts(
        env,
        { start: mtdStartDate, end: mtdEndDate },
        projectId
      );
      const projectMtdCost = projectData?.totals?.total ?? 0;
      const projectSparkline = projectData?.days?.map((d) => d.total) ?? [];
      return { projectId, mtdCost: projectMtdCost, sparkline: projectSparkline };
    });
    const projectCostResults = await Promise.all(projectCostPromises);
    for (const result of projectCostResults) {
      perProjectCosts[result.projectId] = { mtdCost: result.mtdCost, sparkline: result.sparkline };
    }

    // Query last month's per-project MTD costs for individual delta calculations
    const lastMonth = new Date(Date.UTC(currentYear, currentMonth - 1, 1));
    const lastMonthStart = lastMonth.toISOString().slice(0, 10);
    const lastMonthEnd = new Date(
      Date.UTC(lastMonth.getFullYear(), lastMonth.getMonth(), dayOfMonth)
    )
      .toISOString()
      .slice(0, 10);

    const perProjectLastMonthCosts: Record<string, number> = {};
    const lastMonthProjectPromises = projectIds.map(async (projectId: string) => {
      try {
        const lastMonthProjectData = await queryD1DailyCosts(
          env,
          { start: lastMonthStart, end: lastMonthEnd },
          projectId
        );
        return { projectId, lastMonthCost: lastMonthProjectData?.totals?.total ?? 0 };
      } catch {
        return { projectId, lastMonthCost: 0 };
      }
    });
    const lastMonthProjectResults = await Promise.all(lastMonthProjectPromises);
    for (const result of lastMonthProjectResults) {
      perProjectLastMonthCosts[result.projectId] = result.lastMonthCost;
    }

    // Calculate total MTD cost (use 'all' query which aggregates correctly)
    const mtdCost = d1Data?.totals?.total ?? 0;
    const dailyBurnRate = dayOfMonth > 0 ? mtdCost / dayOfMonth : 0;
    const projectedMonthlyCost = dailyBurnRate * daysInMonth;

    // Confidence based on days of data
    let confidence: 'low' | 'medium' | 'high' = 'low';
    if (dayOfMonth >= 15) confidence = 'high';
    else if (dayOfMonth >= 7) confidence = 'medium';

    // Get last month's MTD cost for account-level comparison (uses dates defined above)
    let vsLastMonthPct: number | null = null;
    try {
      const lastMonthData = await queryD1DailyCosts(env, {
        start: lastMonthStart,
        end: lastMonthEnd,
      });
      if (lastMonthData?.totals?.total && lastMonthData.totals.total > 0) {
        vsLastMonthPct =
          ((mtdCost - lastMonthData.totals.total) / lastMonthData.totals.total) * 100;
      }
    } catch (error) {
      log.warn('Could not fetch last month data for comparison', undefined, {
        tag: 'USAGE',
        error: String(error),
      });
    }

    // Get budget thresholds from D1 (with fallback defaults)
    const { softBudgetLimit, warningThreshold } = await getBudgetThresholds(env);

    // Determine overall status
    let status: 'green' | 'yellow' | 'red' = 'green';
    let statusLabel = 'On Track';
    let statusDetail = 'Under budget';

    if (projectedMonthlyCost > softBudgetLimit) {
      const overageAmount = projectedMonthlyCost - softBudgetLimit;
      status = 'red';
      statusLabel = 'Over Budget';
      statusDetail = `Projected $${overageAmount.toFixed(2)} over $${softBudgetLimit} limit`;
    } else if (projectedMonthlyCost > warningThreshold) {
      status = 'yellow';
      statusLabel = 'Elevated';
      statusDetail = `$${(softBudgetLimit - projectedMonthlyCost).toFixed(2)} headroom to $${softBudgetLimit} limit`;
    }

    // Get project-level data
    const projectData: ProjectUtilizationData[] = [];

    // Query for 7-day sparkline data per project (already fetched above in perProjectCosts)
    const sparklineStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    // Fetch 7-day sparkline data per project in parallel
    const sparklinePromises = projectIds.map(async (projectId: string) => {
      const sparkData = await queryD1DailyCosts(
        env,
        { start: sparklineStart, end: mtdEndDate },
        projectId
      );
      return { projectId, sparkline: sparkData?.days?.map((d) => d.total) ?? [] };
    });
    const sparklineResults = await Promise.all(sparklinePromises);
    const projectSparklines: Record<string, number[]> = {};
    for (const result of sparklineResults) {
      projectSparklines[result.projectId] = result.sparkline;
    }

    // Get circuit breaker status from KV for all registered projects
    const cbStatuses: Record<string, string> = {};
    {
      const projectRows2 = await env.PLATFORM_DB.prepare(
        `SELECT project_id FROM project_registry WHERE project_id != 'all'`
      ).all<{ project_id: string }>();
      const projectIds2 = projectRows2.results?.map((r) => r.project_id) ?? ['platform'];
      const cbResults2 = await Promise.all(
        projectIds2.map(async (pid) => {
          const cbKey = `PROJECT:${pid.toUpperCase().replace(/-/g, '-')}:STATUS`;
          const status = await env.PLATFORM_CACHE.get(cbKey);
          return { pid, status };
        })
      );
      for (const { pid, status } of cbResults2) {
        cbStatuses[pid] = status ?? 'active';
      }
    }

    // Query feature_registry to find which projects have CB-enabled features
    // This determines whether to show CB indicator as active vs disabled
    const projectsWithCBEnabled = new Set<string>();
    try {
      const cbEnabledResult = await env.PLATFORM_DB.prepare(
        `
        SELECT DISTINCT project_id
        FROM feature_registry
        WHERE circuit_breaker_enabled = 1
      `
      ).all();
      for (const row of cbEnabledResult.results ?? []) {
        projectsWithCBEnabled.add(row.project_id as string);
      }
      log.info(`Projects with CB enabled: ${[...projectsWithCBEnabled].join(', ')}`, {
        tag: 'USAGE',
      });
    } catch (err) {
      // feature_registry may not exist - fall back to showing all as enabled
      log.warn('Could not query feature_registry for CB status', undefined, {
        tag: 'USAGE',
        error: String(err),
      });
      // Fallback: add all known projects from cbStatuses
      for (const pid of Object.keys(cbStatuses)) {
        projectsWithCBEnabled.add(pid);
      }
    }

    // Build project-level utilization using ACTUAL per-project data
    for (const { project, config } of projectsWithConfig) {
      const projectId = project.projectId;
      const primaryResource = config.primaryResource;
      const limit = config.customLimit ?? CF_ALLOWANCES[primaryResource].limit;
      const unit = CF_ALLOWANCES[primaryResource].unit;

      // Get project-specific costs from per-project query (not divided total)
      const projectCostData = perProjectCosts[projectId];
      const projectMtdCost = projectCostData?.mtdCost ?? 0;

      // Get actual current usage for primary resource from per-project D1 query
      // We query per-project daily data to get proper attribution
      let currentUsage = 0;
      const projectD1Data = await queryD1DailyCosts(
        env,
        { start: mtdStartDate, end: mtdEndDate },
        projectId
      );
      if (projectD1Data?.totals) {
        switch (primaryResource) {
          case 'workers': {
            // Reverse cost calculation: cost / $0.30 per million * 1M = requests
            // Plus base cost consideration (~$0.17/day for $5/month)
            const workersUsageCost = Math.max(
              0,
              projectD1Data.totals.workers - (5 / 30) * dayOfMonth
            );
            currentUsage = (workersUsageCost / 0.3) * 1_000_000;
            break;
          }
          case 'd1':
            // D1 writes: cost * 1M rows (since $1 per million rows written)
            currentUsage = projectD1Data.totals.d1 * 1_000_000;
            break;
          case 'vectorize':
            // Vectorize: cost / $0.01 per million * 1M = dimensions
            currentUsage = (projectD1Data.totals.vectorize / 0.01) * 1_000_000;
            break;
          case 'kv':
            // KV writes: cost / $5 per million * 1M = writes
            currentUsage = (projectD1Data.totals.kv / 5) * 1_000_000;
            break;
          case 'r2':
            // R2: cost / $4.50 per million * 1M = Class A ops
            currentUsage = (projectD1Data.totals.r2 / 4.5) * 1_000_000;
            break;
          case 'durableObjects':
            // DO: cost / $1 per million * 1M = requests (after 3M included in Workers Paid)
            currentUsage = (projectD1Data.totals.durableObjects / 1) * 1_000_000;
            break;
          case 'queues':
            // Queues: cost / $0.40 per million * 1M = messages (after 1M free)
            currentUsage = (projectD1Data.totals.queues / 0.4) * 1_000_000;
            break;
          default:
            currentUsage = 0;
        }
      }

      const utilizationPct = limit > 0 ? (currentUsage / limit) * 100 : 0;
      const projectStatus = getUtilizationStatus(utilizationPct);

      // Use per-project sparkline data
      const sparkline = projectSparklines[projectId] ?? [];

      // Check if this project has CB enabled in feature_registry
      const hasCBEnabled = projectsWithCBEnabled.has(projectId);

      // Only show actual CB status if the project has CB enabled features
      let cbStatusMapped: 'active' | 'tripped' | 'degraded' | 'disabled';
      let cbLabel: string;

      if (hasCBEnabled) {
        const cbStatus = cbStatuses[projectId];
        cbStatusMapped =
          cbStatus === 'paused' ? 'tripped' : cbStatus === 'degraded' ? 'degraded' : 'active';
        cbLabel = cbStatusMapped === 'active' ? 'CB Active' : 'CB Tripped';
      } else {
        cbStatusMapped = 'disabled';
        cbLabel = 'No CB';
      }

      // Calculate per-project cost delta vs last month (same period)
      // Use $0.10 threshold to avoid astronomical percentages from near-zero baselines
      const projectLastMonthCost = perProjectLastMonthCosts[projectId] ?? 0;
      const MIN_BASELINE_COST = 0.1;
      let projectCostDeltaPct: number | null = null;
      if (projectLastMonthCost >= MIN_BASELINE_COST) {
        projectCostDeltaPct =
          ((projectMtdCost - projectLastMonthCost) / projectLastMonthCost) * 100;
      } else if (projectMtdCost >= MIN_BASELINE_COST) {
        // New project with meaningful current cost but no baseline - show as NEW
        projectCostDeltaPct = null;
      }
      // If both are below threshold, leave as null (will show "--" in UI)

      projectData.push({
        projectId,
        projectName: project.displayName,
        primaryResource:
          primaryResource.charAt(0).toUpperCase() + primaryResource.slice(1).replace('AI', ' AI'),
        mtdCost: projectMtdCost,
        costDeltaPct: projectCostDeltaPct ?? 0,
        utilizationPct: Math.min(utilizationPct, 999),
        utilizationCurrent: Math.round(currentUsage),
        utilizationLimit: limit,
        utilizationUnit: unit,
        status: projectStatus,
        sparklineData: sparkline.length > 0 ? sparkline : [0, 0, 0, 0, 0, 0, 0],
        circuitBreakerStatus: cbStatusMapped,
        circuitBreakerLabel: cbLabel,
        hasCBEnabled,
      });
    }

    // Query GitHub usage data (third-party provider)
    const githubData = await queryGitHubUsage(env);

    // Build service-level utilization metrics for overview page
    const defaultTotals = {
      workers: 0,
      d1: 0,
      kv: 0,
      r2: 0,
      vectorize: 0,
      aiGateway: 0,
      durableObjects: 0,
      workersAI: 0,
      queues: 0,
      pages: 0,
      workflows: 0,
      total: 0,
    };
    const cloudflareServices = buildCloudflareServiceMetrics(
      d1Data?.totals ?? defaultTotals,
      dayOfMonth
    );
    const githubServices = buildGitHubServiceMetrics(githubData);

    // Calculate provider health summaries
    const cloudflareHealth = calculateProviderHealth(cloudflareServices, 'cloudflare');
    const githubHealth = calculateProviderHealth(githubServices, 'github');

    const response: BurnRateResponse = {
      success: true,
      burnRate: {
        mtdCost,
        mtdStartDate,
        mtdEndDate,
        projectedMonthlyCost,
        dailyBurnRate,
        daysIntoMonth: dayOfMonth,
        daysRemaining,
        confidence,
        vsLastMonthPct,
        billingPeriodStart: billingStart,
        billingPeriodEnd: billingEnd,
        status,
        statusLabel,
        statusDetail,
      },
      projects: projectData,
      github: githubData,
      health: {
        cloudflare: cloudflareHealth,
        github: githubHealth,
      },
      cloudflareServices,
      githubServices,
      timestamp: new Date().toISOString(),
      cached: false,
    };

    // Cache for 1 hour
    try {
      await env.PLATFORM_CACHE.put(cacheKey, JSON.stringify(response), { expirationTtl: 3600 });
      log.info(`Utilization cached for ${cacheKey}`, { tag: 'USAGE' });
    } catch (error) {
      log.error(
        'Utilization cache write error',
        error instanceof Error ? error : new Error(String(error))
      );
    }

    return jsonResponse({
      ...response,
      responseTimeMs: Date.now() - startTime,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(
      'Error fetching utilization data',
      error instanceof Error ? error : new Error(errorMessage)
    );

    return jsonResponse(
      {
        success: false,
        error: 'Failed to fetch utilization data',
        message: errorMessage,
      },
      500
    );
  }
}
