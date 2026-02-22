/**
 * Platform Usage Utilities
 *
 * Shared utility functions used across handlers, scheduled tasks, and queue processing.
 */

import type {
  Env,
  SamplingMode,
  PreviousHourMetrics,
  PlatformPricing,
  ProjectLookupCache,
  VectorizeAttribution,
  BudgetThresholds,
  TimePeriod,
  AccountUsage,
  Project,
  PlatformSettings,
  BillingSettings,
} from './types';
import { SamplingMode as SamplingModeEnum } from './types';
import {
  CB_KEYS,
  DEFAULT_PRICING,
  BILLING_SETTINGS_CACHE_TTL_MS,
} from './constants';
import {
  getPlatformSettings as getPlatformSettingsFromLib,
  DEFAULT_PLATFORM_SETTINGS,
} from '../../platform-settings';
import {
  getDefaultBillingSettings,
  type BillingSettings as BillingSettingsType,
} from '../../billing';
import { identifyProject, getProjects } from '../../shared/cloudflare';

// =============================================================================
// CACHE KEY GENERATION
// =============================================================================

/**
 * KV cache key format: usage:{period}:{project}:{hour}
 */
export function getCacheKey(prefix: string, period: TimePeriod, project: string): string {
  const hourTimestamp = Math.floor(Date.now() / (60 * 60 * 1000));
  return `${prefix}:${period}:${project}:${hourTimestamp}`;
}

// =============================================================================
// QUERY PARAMETER PARSING
// =============================================================================

/**
 * Parse and validate query parameters (sync version with hardcoded projects)
 * @deprecated Use parseQueryParamsWithRegistry for D1-backed project validation
 */
export function parseQueryParams(url: URL): { period: TimePeriod; project: string } {
  const periodParam = url.searchParams.get('period');
  const projectParam = url.searchParams.get('project') ?? 'all';

  const validPeriods: TimePeriod[] = ['24h', '7d', '30d'];
  const period: TimePeriod = validPeriods.includes(periodParam as TimePeriod)
    ? (periodParam as TimePeriod)
    : '30d';

  // TODO: Replace with your project IDs
  const validProjects = ['all'];
  const project = validProjects.includes(projectParam) ? projectParam : 'all';

  return { period, project };
}

/**
 * Get list of valid projects from D1 registry.
 */
export async function getValidProjects(env: Env): Promise<string[]> {
  try {
    const projects = await getProjects(env.PLATFORM_DB);
    return ['all', ...projects.map((p) => p.projectId)];
  } catch {
    // TODO: Replace with your fallback project IDs
    return ['all'];
  }
}

/**
 * Parse and validate query parameters using D1 registry for project validation
 */
export async function parseQueryParamsWithRegistry(
  url: URL,
  env: Env
): Promise<{ period: TimePeriod; project: string }> {
  const periodParam = url.searchParams.get('period');
  const projectParam = url.searchParams.get('project') ?? 'all';

  const validPeriods: TimePeriod[] = ['24h', '7d', '30d'];
  const period: TimePeriod = validPeriods.includes(periodParam as TimePeriod)
    ? (periodParam as TimePeriod)
    : '30d';

  const validProjects = await getValidProjects(env);
  const project = validProjects.includes(projectParam) ? projectParam : 'all';

  return { period, project };
}

// =============================================================================
// JSON RESPONSE HELPER
// =============================================================================

/**
 * JSON response helper
 */
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// =============================================================================
// PROJECT FILTERING
// =============================================================================

/**
 * Normalize resource type from snapshot format to mapping table format.
 * Snapshots use: 'queues', 'workflows', 'do', 'aigateway'
 * Mapping table uses: 'queue', 'workflow', 'durable_object', 'ai_gateway'
 */
function normalizeResourceType(resourceType: string): string {
  const typeMap: Record<string, string> = {
    queues: 'queue',
    workflows: 'workflow',
    do: 'durable_object',
    aigateway: 'ai_gateway',
  };
  return typeMap[resourceType] ?? resourceType;
}

/**
 * Build a project lookup cache from the D1 registry.
 */
export async function buildProjectLookupCache(env: Env): Promise<ProjectLookupCache> {
  const cache = new Map<string, string>();

  try {
    const result = await env.PLATFORM_DB.prepare(
      `SELECT resource_type, resource_name, project_id FROM resource_project_mapping`
    ).all<{
      resource_type: string;
      resource_name: string;
      project_id: string;
    }>();

    for (const row of result.results ?? []) {
      const key = `${row.resource_type}:${row.resource_name.toLowerCase()}`;
      cache.set(key, row.project_id);
    }
  } catch {
    // Failed to build cache, will fall back to patterns
  }

  return cache;
}

/**
 * Identify project for a resource using the lookup cache.
 * Normalizes resource type to handle snapshot vs mapping table differences.
 */
export function identifyProjectWithCache(
  cache: ProjectLookupCache,
  resourceType: string,
  resourceName: string
): string {
  // Normalize the resource type to match mapping table format
  const normalizedType = normalizeResourceType(resourceType);
  const key = `${normalizedType}:${resourceName.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }
  return identifyProject(resourceName) ?? 'unknown';
}

/**
 * Filter usage data by project (uses pattern-based identification)
 * @deprecated Use filterByProjectWithRegistry for D1-backed lookups
 */
export function filterByProject(usage: AccountUsage, project: string): AccountUsage {
  if (project === 'all') {
    return usage;
  }

  return {
    ...usage,
    workers: usage.workers.filter((w) => identifyProject(w.scriptName) === project),
    d1: usage.d1.filter((db) => identifyProject(db.databaseName) === project),
    kv: usage.kv.filter((ns) => identifyProject(ns.namespaceName) === project),
    r2: usage.r2.filter((b) => identifyProject(b.bucketName) === project),
    vectorize: usage.vectorize.filter((v) => identifyProject(v.name) === project),
    aiGateway: usage.aiGateway.filter((gw) => identifyProject(gw.gatewayId) === project),
    pages: usage.pages.filter((p) => identifyProject(p.projectName) === project),
    durableObjects: usage.durableObjects,
  };
}

/**
 * Filter usage data by project using D1 registry cache.
 */
export function filterByProjectWithRegistry(
  usage: AccountUsage,
  project: string,
  cache: ProjectLookupCache
): AccountUsage {
  if (project === 'all') {
    return usage;
  }

  return {
    ...usage,
    workers: usage.workers.filter(
      (w) => identifyProjectWithCache(cache, 'worker', w.scriptName) === project
    ),
    d1: usage.d1.filter((db) => identifyProjectWithCache(cache, 'd1', db.databaseName) === project),
    kv: usage.kv.filter(
      (ns) => identifyProjectWithCache(cache, 'kv', ns.namespaceName) === project
    ),
    r2: usage.r2.filter((b) => identifyProjectWithCache(cache, 'r2', b.bucketName) === project),
    vectorize: usage.vectorize.filter(
      (v) => identifyProjectWithCache(cache, 'vectorize', v.name) === project
    ),
    aiGateway: usage.aiGateway.filter(
      (gw) => identifyProjectWithCache(cache, 'ai_gateway', gw.gatewayId) === project
    ),
    pages: usage.pages.filter(
      (p) => identifyProjectWithCache(cache, 'pages', p.projectName) === project
    ),
    durableObjects: usage.durableObjects,
  };
}

/**
 * Attribute Vectorize queries to projects using the D1 registry cache.
 */
export function attributeVectorizeByProject(
  byIndex: Array<{ indexName: string; queriedDimensions: number }>,
  cache: ProjectLookupCache,
  accountTotal: number
): VectorizeAttribution {
  const byProject = new Map<string, number>();

  for (const index of byIndex) {
    const projectId = identifyProjectWithCache(cache, 'vectorize', index.indexName);
    const dimensions = index.queriedDimensions;

    if (projectId && projectId !== 'unknown') {
      byProject.set(projectId, (byProject.get(projectId) ?? 0) + dimensions);
    }
  }

  const sumAttributed = Array.from(byProject.values()).reduce((sum, d) => sum + d, 0);
  const unattributed = Math.max(0, accountTotal - sumAttributed);

  return {
    byProject,
    unattributed,
    total: sumAttributed + unattributed,
  };
}

// =============================================================================
// SUMMARY CALCULATION
// =============================================================================

/**
 * Calculate summary statistics
 */
export function calculateSummary(data: AccountUsage) {
  return {
    totalWorkers: data.workers.length,
    totalD1Databases: data.d1.length,
    totalKVNamespaces: data.kv.length,
    totalR2Buckets: data.r2.length,
    totalVectorizeIndexes: data.vectorize.length,
    totalAIGateways: data.aiGateway.length,
    totalPagesProjects: data.pages.length,
    totalRequests: data.workers.reduce((sum, w) => sum + w.requests, 0),
    totalRowsRead: data.d1.reduce((sum, db) => sum + db.rowsRead, 0),
    totalRowsWritten: data.d1.reduce((sum, db) => sum + db.rowsWritten, 0),
  };
}

/**
 * Calculate trend for comparison
 */
export function calcTrend(
  current: number,
  prior: number
): { trend: 'up' | 'down' | 'stable'; percentChange: number } {
  if (prior === 0) {
    return { trend: current > 0 ? 'up' : 'stable', percentChange: current > 0 ? 100 : 0 };
  }

  const percentChange = ((current - prior) / prior) * 100;

  let trend: 'up' | 'down' | 'stable' = 'stable';
  if (percentChange > 5) trend = 'up';
  else if (percentChange < -5) trend = 'down';

  return { trend, percentChange: Math.round(percentChange * 10) / 10 };
}

// =============================================================================
// DELTA CALCULATION
// =============================================================================

/**
 * Calculate delta between current and previous values.
 *
 * When previous is undefined (KV key expired or first run), returns the full
 * cumulative value -- which can massively inflate SUM() totals in hourly snapshots.
 * The optional maxReasonableDelta cap prevents this by limiting the result to a
 * reasonable hourly maximum (e.g., 3x the prorated monthly allowance).
 *
 * @param current - Current cumulative value from GraphQL/REST API
 * @param previous - Previous hour's cumulative value from KV (undefined if expired)
 * @param maxReasonableDelta - Optional cap to prevent cumulative values stored as deltas
 */
export function calculateDelta(
  current: number,
  previous: number | undefined,
  maxReasonableDelta?: number
): number {
  if (previous === undefined) {
    if (maxReasonableDelta !== undefined && current > maxReasonableDelta) {
      return maxReasonableDelta;
    }
    return current;
  }
  const delta = current - previous;
  if (delta < 0) {
    // Counter reset (billing period rollover)
    if (maxReasonableDelta !== undefined && current > maxReasonableDelta) {
      return maxReasonableDelta;
    }
    return current;
  }
  if (maxReasonableDelta !== undefined && delta > maxReasonableDelta) {
    return maxReasonableDelta;
  }
  return delta;
}

/**
 * Load previous hour's cumulative metrics from KV.
 */
export async function loadPreviousHourMetrics(env: Env): Promise<PreviousHourMetrics | null> {
  try {
    const stored = await env.PLATFORM_CACHE.get(CB_KEYS.PREV_HOUR_ACCOUNT_METRICS);
    if (stored) {
      const parsed = JSON.parse(stored);
      return {
        snapshotHour: parsed.snapshotHour ?? '',
        timestamp: parsed.timestamp ?? 0,
        do: {
          requests: parsed.do?.requests ?? 0,
          gbSeconds: parsed.do?.gbSeconds ?? 0,
          storageReadUnits: parsed.do?.storageReadUnits ?? 0,
          storageWriteUnits: parsed.do?.storageWriteUnits ?? 0,
          storageDeleteUnits: parsed.do?.storageDeleteUnits ?? 0,
        },
        workersAI: {
          neurons: parsed.workersAI?.neurons ?? 0,
          requests: parsed.workersAI?.requests ?? 0,
        },
        vectorize: {
          queries: parsed.vectorize?.queries ?? 0,
        },
        queues: {
          produced: parsed.queues?.produced ?? 0,
          consumed: parsed.queues?.consumed ?? 0,
        },
        workflows: {
          executions: parsed.workflows?.executions ?? 0,
          successes: parsed.workflows?.successes ?? 0,
          failures: parsed.workflows?.failures ?? 0,
          wallTimeMs: parsed.workflows?.wallTimeMs ?? 0,
          cpuTimeMs: parsed.workflows?.cpuTimeMs ?? 0,
        },
        workers: {
          requests: parsed.workers?.requests ?? 0,
          errors: parsed.workers?.errors ?? 0,
          cpuTimeMs: parsed.workers?.cpuTimeMs ?? 0,
        },
        d1: {
          rowsRead: parsed.d1?.rowsRead ?? 0,
          rowsWritten: parsed.d1?.rowsWritten ?? 0,
        },
        kv: {
          reads: parsed.kv?.reads ?? 0,
          writes: parsed.kv?.writes ?? 0,
          deletes: parsed.kv?.deletes ?? 0,
          lists: parsed.kv?.lists ?? 0,
        },
        r2: {
          classAOps: parsed.r2?.classAOps ?? 0,
          classBOps: parsed.r2?.classBOps ?? 0,
          egressBytes: parsed.r2?.egressBytes ?? 0,
        },
        aiGateway: {
          requests: parsed.aiGateway?.requests ?? 0,
          tokensIn: parsed.aiGateway?.tokensIn ?? 0,
          tokensOut: parsed.aiGateway?.tokensOut ?? 0,
          cached: parsed.aiGateway?.cached ?? 0,
        },
        pages: {
          deployments: parsed.pages?.deployments ?? 0,
          bandwidthBytes: parsed.pages?.bandwidthBytes ?? 0,
        },
        projects: parsed.projects,
      };
    }
  } catch {
    // Return null on error
  }
  return null;
}

/**
 * Save previous hour's cumulative metrics to KV.
 */
export async function savePreviousHourMetrics(
  env: Env,
  metrics: PreviousHourMetrics
): Promise<void> {
  try {
    await env.PLATFORM_CACHE.put(CB_KEYS.PREV_HOUR_ACCOUNT_METRICS, JSON.stringify(metrics), {
      expirationTtl: 86400 * 7, // 7 days -- prevents delta calculation failures from KV expiry
    });
    await env.PLATFORM_CACHE.put(CB_KEYS.PREV_HOUR_LAST_COLLECTION, metrics.snapshotHour, {
      expirationTtl: 86400 * 7,
    });
  } catch {
    // Non-fatal error
  }
}

// =============================================================================
// QUEUE/WORKFLOW PROJECT MAPPING
// =============================================================================

/**
 * Map queue name to project ID for per-project cost attribution.
 *
 * TODO: Add your queue-to-project mappings here.
 * This function is called during data collection to attribute queue costs.
 */
export function getQueueProject(queueName: string): string {
  const lowerName = queueName.toLowerCase();

  // TODO: Add your project-specific queue patterns:
  // if (lowerName.startsWith('my-project-')) return 'my-project';

  if (lowerName.startsWith('platform-')) {
    return 'platform';
  }

  return 'platform';
}

/**
 * Map workflow name to project ID for per-project metrics attribution.
 *
 * TODO: Add your workflow-to-project mappings here.
 */
export function getWorkflowProject(workflowName: string): string {
  // TODO: Add your project-specific workflow patterns:
  // if (MY_PROJECT_WORKFLOWS.has(workflowName)) return 'my-project';

  return 'platform';
}

// =============================================================================
// PRICING
// =============================================================================

let cachedPricing: PlatformPricing | null = null;

/**
 * Load pricing configuration from KV with fallback to defaults.
 */
export async function loadPricing(env: Env): Promise<PlatformPricing> {
  if (cachedPricing) {
    return cachedPricing;
  }

  try {
    const kvPricing = await env.PLATFORM_CACHE.get(CB_KEYS.PRICING, 'json');

    if (kvPricing && typeof kvPricing === 'object') {
      cachedPricing = {
        ...DEFAULT_PRICING,
        ...(kvPricing as Partial<PlatformPricing>),
        workers: {
          ...DEFAULT_PRICING.workers,
          ...((kvPricing as Partial<PlatformPricing>).workers || {}),
        },
        d1: { ...DEFAULT_PRICING.d1, ...((kvPricing as Partial<PlatformPricing>).d1 || {}) },
        kv: { ...DEFAULT_PRICING.kv, ...((kvPricing as Partial<PlatformPricing>).kv || {}) },
        r2: { ...DEFAULT_PRICING.r2, ...((kvPricing as Partial<PlatformPricing>).r2 || {}) },
        vectorize: {
          ...DEFAULT_PRICING.vectorize,
          ...((kvPricing as Partial<PlatformPricing>).vectorize || {}),
        },
        workersAI: {
          ...DEFAULT_PRICING.workersAI,
          ...((kvPricing as Partial<PlatformPricing>).workersAI || {}),
        },
        durableObjects: {
          ...DEFAULT_PRICING.durableObjects,
          ...((kvPricing as Partial<PlatformPricing>).durableObjects || {}),
        },
        queues: {
          ...DEFAULT_PRICING.queues,
          ...((kvPricing as Partial<PlatformPricing>).queues || {}),
        },
        pages: {
          ...DEFAULT_PRICING.pages,
          ...((kvPricing as Partial<PlatformPricing>).pages || {}),
        },
      };
      return cachedPricing;
    }
  } catch {
    // Fall back to defaults
  }

  cachedPricing = DEFAULT_PRICING;
  return cachedPricing;
}

/**
 * Reset cached pricing.
 */
export function resetPricingCache(): void {
  cachedPricing = null;
}

// =============================================================================
// BILLING SETTINGS
// =============================================================================

let cachedBillingSettings: BillingSettingsType | null = null;
let billingSettingsCacheTime = 0;

/**
 * Fetch billing settings from D1, with in-memory caching.
 */
export async function fetchBillingSettings(
  env: Env,
  accountId = 'default'
): Promise<BillingSettingsType> {
  const now = Date.now();
  if (cachedBillingSettings && now - billingSettingsCacheTime < BILLING_SETTINGS_CACHE_TTL_MS) {
    return cachedBillingSettings;
  }

  try {
    const result = await env.PLATFORM_DB.prepare(
      `SELECT account_id, plan_type, billing_cycle_day, billing_currency, base_cost_monthly, notes
       FROM billing_settings
       WHERE account_id = ?
       LIMIT 1`
    )
      .bind(accountId)
      .first<{
        account_id: string;
        plan_type: string;
        billing_cycle_day: number;
        billing_currency: string;
        base_cost_monthly: number;
        notes: string | null;
      }>();

    if (result) {
      cachedBillingSettings = {
        accountId: result.account_id,
        planType: result.plan_type as BillingSettingsType['planType'],
        billingCycleDay: result.billing_cycle_day,
        billingCurrency: result.billing_currency,
        baseCostMonthly: result.base_cost_monthly,
        notes: result.notes ?? undefined,
      };
      billingSettingsCacheTime = now;
      return cachedBillingSettings;
    }

    cachedBillingSettings = getDefaultBillingSettings();
    billingSettingsCacheTime = now;
    return cachedBillingSettings;
  } catch {
    cachedBillingSettings = getDefaultBillingSettings();
    billingSettingsCacheTime = now;
    return cachedBillingSettings;
  }
}

/**
 * Reset billing settings cache.
 */
export function resetBillingSettingsCache(): void {
  cachedBillingSettings = null;
  billingSettingsCacheTime = 0;
}

// =============================================================================
// PLATFORM SETTINGS
// =============================================================================

/**
 * Get all platform settings from D1/KV.
 */
export async function getPlatformSettings(env: Env): Promise<PlatformSettings> {
  return getPlatformSettingsFromLib(env);
}

/**
 * Get budget thresholds from D1 usage_settings table.
 */
export async function getBudgetThresholds(env: Env): Promise<BudgetThresholds> {
  const settings = await getPlatformSettings(env);
  return {
    softBudgetLimit: settings.budgetSoftLimit,
    warningThreshold: settings.budgetWarningThreshold,
  };
}

// =============================================================================
// SAMPLING MODE
// =============================================================================

/**
 * Determine sampling mode based on D1 write usage.
 */
export async function determineSamplingMode(
  env: Env
): Promise<(typeof SamplingModeEnum)[keyof typeof SamplingModeEnum]> {
  const settings = await getPlatformSettings(env);
  const d1Writes = parseInt((await env.PLATFORM_CACHE.get(CB_KEYS.D1_WRITES_24H)) || '0', 10);
  const ratio = d1Writes / settings.d1WriteLimit;

  if (ratio >= 0.9) return SamplingModeEnum.MINIMAL;
  if (ratio >= 0.8) return SamplingModeEnum.QUARTER;
  if (ratio >= 0.6) return SamplingModeEnum.HALF;
  return SamplingModeEnum.FULL;
}

/**
 * Check if we should run data collection this hour based on sampling mode.
 */
export function shouldRunThisHour(
  mode: (typeof SamplingModeEnum)[keyof typeof SamplingModeEnum],
  hour: number
): boolean {
  return hour % mode === 0;
}

// =============================================================================
// TIME HELPERS
// =============================================================================

/**
 * Generate a unique ID for records.
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Get current hour in ISO format (YYYY-MM-DDTHH:00:00Z).
 */
export function getCurrentHour(): string {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  // Format: 2026-01-28T12:00:00Z (19 chars + Z)
  return now.toISOString().slice(0, 19) + 'Z';
}

/**
 * Get today's date in YYYY-MM-DD format.
 */
export function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// =============================================================================
// API KEY VALIDATION
// =============================================================================

/**
 * Validate API key for protected endpoints.
 */
export function validateApiKey(request: Request, env: Env): Response | null {
  if (!env.USAGE_API_KEY) {
    return null;
  }

  const providedKey = request.headers.get('X-API-Key');

  if (!providedKey) {
    return jsonResponse({ error: 'Missing X-API-Key header', code: 'UNAUTHORIZED' }, 401);
  }

  if (providedKey !== env.USAGE_API_KEY) {
    return jsonResponse({ error: 'Invalid API key', code: 'FORBIDDEN' }, 403);
  }

  return null;
}

// =============================================================================
// UTILIZATION STATUS
// =============================================================================

import type { ServiceUtilizationStatus } from './types';

/**
 * Get service utilization status based on percentage of limit used.
 */
export function getServiceUtilizationStatus(pct: number): ServiceUtilizationStatus {
  if (pct >= 100) return 'overage';
  if (pct >= 80) return 'critical';
  if (pct >= 60) return 'warning';
  return 'ok';
}

// =============================================================================
// FETCH WITH RETRY
// =============================================================================

/**
 * Status codes that should trigger a retry.
 * 429 = rate limited, 500/502/503/504 = transient server errors.
 */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/**
 * Wrapper around fetch that handles retryable responses with exponential backoff.
 * Retries on 429 (rate limit) and 5xx (server errors).
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3,
  baseDelayMs = 1000
): Promise<Response> {
  let lastResponse: Response | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, options);

    if (!RETRYABLE_STATUS_CODES.has(response.status)) {
      return response;
    }

    // Consume body to avoid stalled connections
    await response.text().catch(() => {});
    lastResponse = response;

    if (attempt < maxRetries) {
      const retryAfter = response.headers.get('Retry-After');
      let delayMs: number;

      if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (!isNaN(seconds)) {
          delayMs = seconds * 1000;
        } else {
          const date = new Date(retryAfter);
          delayMs = date.getTime() - Date.now();
        }
      } else {
        delayMs = baseDelayMs * Math.pow(2, attempt);
      }

      delayMs = Math.min(Math.max(delayMs, 100), 30000);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // Return the last response status rather than always 429
  return new Response(`Request failed after ${maxRetries} retries`, {
    status: lastResponse?.status ?? 429,
  });
}
