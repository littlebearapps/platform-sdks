/**
 * Platform Usage Worker (Data Warehouse)
 *
 * Provides unified Cloudflare account usage metrics with D1-backed storage,
 * adaptive sampling, circuit breaker protection, and anomaly detection.
 *
 * Architecture:
 * - 2-tier time-series rollup: daily (90d) → monthly (forever)
 * - Feature-level SDK telemetry via Analytics Engine (captured by Platform SDK)
 * - Scheduled handler collects data daily at midnight UTC
 * - Hybrid circuit breaker: soft for this worker, hard 503 for registered projects
 *
 * Endpoints:
 * - GET /usage - Get usage metrics with cost breakdown
 * - GET /usage/costs - Get cost breakdown only (lighter endpoint)
 * - GET /usage/thresholds - Get threshold warnings only
 * - GET /usage/enhanced - Get enhanced usage metrics with sparklines and trends
 * - GET /usage/compare - Get period comparison (task-17.3, 17.4)
 * - GET /usage/workersai - Get Workers AI usage from Analytics Engine (15-min cache)
 * - GET /usage/daily - Get daily cost breakdown for chart/table (task-18)
 * - GET /usage/settings - Get alert threshold configuration (task-17.16)
 * - PUT /usage/settings - Update alert threshold configuration (task-17.16)
 * - GET /usage/settings/verify - Verify all expected settings exist in D1 (task-55)
 * - GET /usage/live - Real-time KV data (circuit breakers, sampling mode) - requires X-API-Key
 * - GET /usage/features - Feature-level usage from Analytics Engine (Phase 4)
 * - GET /usage/features/circuit-breakers - Feature circuit breaker states (Phase 4)
 * - PUT /usage/features/circuit-breakers - Toggle feature circuit breaker (Phase 4)
 * - GET /usage/features/budgets - Feature budgets configuration (Phase 4)
 * - PUT /usage/features/budgets - Update feature budgets configuration (Phase 4)
 * - GET /usage/features/history - Historical feature usage from D1 (Phase 5.2)
 * - GET /usage/features/circuit-breaker-events - Circuit breaker event log from D1 (Phase 5.3)
 * - GET /usage/query - Time-bucketed usage aggregation from Analytics Engine (Dashboard data layer)
 * - GET /usage/health-trends - Project health trends over time (AI Judge Phase 2)
 * - GET /usage/health-trends/latest - Latest health scores summary (AI Judge Phase 2)
 *
 * Query params:
 * - period: '24h' | '7d' | '30d' (default: '30d')
 * - project: 'all' | <your-project-ids> (default: 'all')
 * - compare: 'none' | 'lastMonth' | 'custom' (default: 'none')
 * - startDate: ISO date (YYYY-MM-DD) - for compare=custom
 * - endDate: ISO date (YYYY-MM-DD) - for compare=custom
 * - priorStartDate: ISO date (YYYY-MM-DD) - optional, for compare=custom
 * - priorEndDate: ISO date (YYYY-MM-DD) - optional, for compare=custom
 *
 * Scheduled:
 * - Cron: 0 0 * * * (daily at midnight UTC)
 * - Collects from Cloudflare GraphQL, Analytics Engine, GitHub Billing
 * - Persists to D1, runs all rollups (daily, feature usage, AI model breakdowns)
 * - SDK telemetry flows via queue handler → Analytics Engine → daily rollup
 */

import type {
  KVNamespace,
  ExecutionContext,
  D1Database,
  ScheduledEvent,
  Queue,
  MessageBatch,
  AnalyticsEngineDataset,
  Fetcher,
} from '@cloudflare/workers-types';
import {
  withFeatureBudget,
  createLoggerFromEnv,
  createLoggerFromRequest,
  createTraceContext,
  health,
  HEARTBEAT_HEALTH,
  type TelemetryMessage,
  type FeatureMetrics,
  type ErrorCategory,
  type Logger,
} from '@littlebearapps/platform-consumer-sdk';
import { CB_STATUS, type CircuitBreakerStatusValue } from './lib/circuit-breaker-middleware';
import { HARD_LIMIT_MULTIPLIER } from './lib/usage/queue/budget-enforcement';
import { METRIC_FIELDS } from '@littlebearapps/platform-consumer-sdk';
import {
  calculateBillingPeriod,
  calculateBillableUsage,
  prorateAllowance,
  getDefaultBillingSettings,
  type BillingSettings,
  type BillingPeriod,
} from './lib/billing';
import {
  getPlatformSettings as getPlatformSettingsFromLib,
  getSetting,
  getProjectSetting,
  getUtilizationStatus,
  DEFAULT_PLATFORM_SETTINGS,
  SETTING_KEY_MAP,
  EXPECTED_SETTINGS_KEYS,
  type PlatformSettings,
  type SettingsEnv,
} from './lib/platform-settings';
import {
  CloudflareGraphQL,
  type TimePeriod,
  type DateRange,
  type CompareMode,
  type AccountUsage,
  calculateMonthlyCosts,
  calculateProjectCosts,
  calculateDailyCosts,
  analyseThresholds,
  identifyProject,
  formatCurrency,
  DEFAULT_ALERT_THRESHOLDS,
  mergeThresholds,
  type CostBreakdown,
  type ProjectCostBreakdown,
  type ThresholdAnalysis,
  type SparklineData,
  type WorkersErrorBreakdown,
  type QueuesMetrics,
  type CacheAnalytics,
  type PeriodComparison,
  type AlertThresholds,
  type ServiceThreshold,
  type WorkersAISummary,
  type AIGatewaySummary,
  type DailyCostData,
  type DailyUsageMetrics,
  // Project registry (D1-backed)
  getProjects,
  type Project,
  type ResourceType,
} from './lib/shared/cloudflare';
import {
  CF_SIMPLE_ALLOWANCES,
  type SimpleAllowanceType,
} from './lib/shared/allowances';
import {
  calculateHourlyCosts,
  calculateDailyBillableCosts,
  type HourlyUsageMetrics,
  type AccountDailyUsage,
  type DailyBillableCostBreakdown,
  PRICING_TIERS,
  PAID_ALLOWANCES,
  HOURS_PER_MONTH,
} from '@littlebearapps/platform-consumer-sdk';
import {
  getDailyUsageFromAnalyticsEngine,
  queryUsageByTimeBucket,
  type TimeBucketedUsage,
  type TimeBucketQueryParams,
} from './lib/analytics-engine';
import {
  getPIDState,
  savePIDState,
  computePID,
  calculateUtilisation,
  shouldUpdatePID,
  formatThrottleRate,
  type PIDState,
} from './lib/control';
import {
  getReservoirState,
  saveReservoirState,
  addSample,
  getPercentiles,
  formatPercentiles,
  type ReservoirState,
} from './lib/telemetry-sampling';
import { calculateBCU, formatBCUResult, type BCUResult } from './lib/economics';
import { pingHeartbeat } from '@littlebearapps/platform-consumer-sdk';

// =============================================================================
// SHARED USAGE MODULES (Types, Constants, Utilities)
// =============================================================================
import {
  // Types
  type Env,
  type DailyLimits,
  SamplingMode,
  type PreviousHourMetrics,
  type MetricDeltas,
  type PlatformPricing,
  type UsageResponse,
  type EnhancedUsageResponse,
  type ComparisonResponse,
  type SettingsResponse,
  type ProjectedBurn,
  type LiveUsageResponse,
  type FeatureUsageData,
  type WorkersAIResponse,
  type DailyCostResponse,
  type ServiceUtilizationStatus,
  type ResourceMetricData,
  type ProviderHealthData,
  type ProjectUtilizationData,
  type GitHubUsageResponse,
  type BurnRateResponse,
  type BudgetThresholds,
  type RollingStats,
  type AnomalyRecord,
  type AnomaliesResponse,
  type GitHubUsageItem,
  type GitHubPlanInfo,
  type GitHubBillingData,
  type GitHubPlanInclusions,
  type AnthropicUsageData,
  type OpenAIUsageData,
  type ResendUsageData,
  type ApifyUsageData,
  type ErrorAlertPayload,
  type FeatureBatchState,
  type VectorizeAttribution,
  type ProjectLookupCache,
  // Constants
  CB_KEYS,
  FEATURE_KV_KEYS,
  SETTINGS_KEY,
  METRIC_TO_BUDGET_KEY,
  FEATURE_METRIC_FIELDS,
  RESOURCE_TYPE_MAP,
  DEFAULT_PRICING,
  DEFAULT_BUDGET_THRESHOLDS,
  CF_OVERAGE_PRICING,
  FALLBACK_PROJECT_CONFIGS,
  ERROR_RATE_THRESHOLDS,
  KNOWN_DATASETS,
  QUERIED_DATASETS,
  EXPECTED_USAGE_SETTINGS,
  BILLING_SETTINGS_CACHE_TTL_MS,
  MAX_HOURLY_DELTAS,
  // Utilities
  getCacheKey,
  parseQueryParams,
  parseQueryParamsWithRegistry,
  getValidProjects,
  jsonResponse,
  buildProjectLookupCache,
  identifyProjectWithCache,
  filterByProject,
  filterByProjectWithRegistry,
  attributeVectorizeByProject,
  calculateSummary,
  calcTrend,
  calculateDelta,
  loadPreviousHourMetrics,
  savePreviousHourMetrics,
  getQueueProject,
  getWorkflowProject,
  loadPricing,
  resetPricingCache,
  fetchBillingSettings,
  resetBillingSettingsCache,
  getPlatformSettings,
  getBudgetThresholds,
  determineSamplingMode,
  getServiceUtilizationStatus,
  shouldRunThisHour,
  generateId,
  getCurrentHour,
  getTodayDate,
  validateApiKey,
  fetchWithRetry,
} from './lib/usage/shared';

// =============================================================================
// HANDLER MODULES (HTTP endpoint handlers)
// =============================================================================
import {
  // Data query functions
  getCurrentPricingVersionId,
  resetPricingVersionCache,
  queryD1UsageData,
  queryD1DailyCosts,
  calculateProjectedBurn,
  queryAIGatewayMetrics,
  // Usage metrics handlers
  handleUsage,
  handleCosts,
  handleThresholds,
  handleEnhanced,
  handleCompare,
  handleDaily,
  handleStatus,
  handleUtilization,
  handleProjects,
  handleAnomalies,
  // Feature handlers
  handleFeatures,
  handleWorkersAI,
  handleUsageQuery,
  handleGetFeatureCircuitBreakers,
  handlePutFeatureCircuitBreakers,
  handleGetCircuitBreakerEvents,
  handleGetFeatureBudgets,
  handlePutFeatureBudgets,
  handleGetFeatureHistory,
  // Settings handlers
  handleGetSettings,
  handlePutSettings,
  handleSettingsVerify,
  handleCircuitBreakerStatus,
  handleLiveUsage,
  // Admin handlers
  handleResetCircuitBreaker,
  handleBackfill,
  // DLQ admin handlers
  handleListDLQ,
  handleDLQStats,
  handleReplayDLQ,
  handleDiscardDLQ,
  handleReplayAllDLQ,
  // Health trends handlers (Phase 2 AI Judge)
  handleGetHealthTrends,
  handleGetLatestHealthTrends,
  // Gap detection and backfill handlers
  handleGapsStatus,
  handleGapsHistory,
  handleGapsBackfill,
  handleBackfillHistory,
  handleProjectsHealth,
  // Audit handlers (Phase 2 Usage Capture Audit)
  handleGetAudit,
  handleGetAuditHistory,
  handleGetAttribution,
  handleGetFeatureCoverage,
  // Behavioral analysis handlers
  handleGetBehavioral,
  handleGetHotspots,
  handleGetRegressions,
  handleAcknowledgeRegression,
} from './lib/usage/handlers';

// =============================================================================
// SCHEDULED MODULES (Cron-triggered data collection and rollups)
// =============================================================================
import {
  // Data collection
  persistHourlySnapshot,
  persistResourceUsageSnapshots,
  collectExternalMetrics,
  type ExternalMetrics,
  persistThirdPartyUsage,
  validateCloudflareToken,
  // Rollups
  invalidateDailyCache,
  runDailyRollup,
  runFeatureUsageDailyRollup,
  runMonthlyRollup,
  cleanupOldData,
  calculateUsageVsAllowancePercentages,
  persistWorkersAIModelBreakdown,
  persistAIGatewayModelBreakdown,
  persistFeatureAIModelUsage,
  runWorkersAIModelDailyRollup,
  runAIGatewayModelDailyRollup,
  backfillMissingDays,
  // Anomaly detection
  calculate7DayRollingStats,
  detectAnomalies,
  detectHourlyD1WriteAnomalies,
  discoverAndUpdateDatasetRegistry,
  // Error digest
  checkAndAlertErrors,
  sendHourlyErrorDigest,
  sendDailyErrorSummary,
  cleanupOldErrorEvents,
} from './lib/usage/scheduled';

// =============================================================================
// QUEUE MODULES (Telemetry processing and budget enforcement)
// =============================================================================
import {
  // Queue consumer
  handleQueue,
  // DLQ handler
  handleDLQ,
  // Heartbeat handling
  handleHeartbeat,
  // Intelligent degradation
  processIntelligentDegradation,
  // Budget enforcement
  checkAndUpdateBudgetStatus,
  checkMonthlyBudgets,
  checkAndTripCircuitBreakers,
  determineCircuitBreakerStatus,
  logCircuitBreakerEvent,
  sendSlackAlert,
  // D1/KV tracking
  getD1WriteCount,
  incrementD1WriteCount,
  getDOGbSecondsCount,
  setDOGbSecondsCount,
  getDOGbSecondsThreshold,
} from './lib/usage/queue';

// Note: Data access functions imported from ./lib/usage/handlers (see imports above)

// =============================================================================
// HTTP ENDPOINT HANDLERS
// =============================================================================
// All handler functions are imported from ./lib/usage/handlers modules.
// See imports above for: handleUsage, handleCosts, handleThresholds, etc.
// =============================================================================

// =============================================================================
// RETRY HELPERS
// =============================================================================

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Collect Cloudflare usage data with exponential backoff retry.
 * F1 Fix: Prevents data gaps from transient GraphQL failures.
 *
 * Retry strategy: 2s, 4s, 8s (per Cloudflare recommendations)
 * Rate limit: 300 queries/5 min - backoff helps stay within limits
 *
 * @param graphql - CloudflareGraphQL client instance
 * @param log - Logger for tracking retry attempts
 * @param maxRetries - Maximum number of retry attempts (default: 3)
 * @returns Usage data from GraphQL
 * @throws Error if all retries fail
 */
async function collectWithRetry(
  graphql: CloudflareGraphQL,
  log: Logger,
  maxRetries = 3
): Promise<AccountUsage> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log.info('GraphQL collection attempt', { attempt, maxRetries });
      const usage = await graphql.getAllMetrics('24h');
      if (attempt > 1) {
        log.info('GraphQL collection succeeded after retry', { attempt });
      }
      return usage;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      log.warn('GraphQL collection failed', {
        attempt,
        maxRetries,
        error: lastError.message,
      });

      if (attempt < maxRetries) {
        const delayMs = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
        log.info('Retrying after delay', { delayMs, nextAttempt: attempt + 1 });
        await sleep(delayMs);
      }
    }
  }

  throw lastError ?? new Error('GraphQL collection failed after all retries');
}

// =============================================================================
// SCHEDULED HANDLER
// =============================================================================

/**
 * Scheduled handler - runs hourly at :00.
 * Collects Cloudflare usage data, persists to D1, runs rollups at midnight.
 */
async function handleScheduled(
  event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:scheduled');
  const startTime = Date.now();
  const currentHour = new Date(event.scheduledTime).getUTCHours();
  const snapshotHour = getCurrentHour();
  const today = getTodayDate();

  log.info('Starting data collection', { snapshotHour, hour: currentHour });

  // Gatus heartbeat is pinged on success/fail only (no /start support)

  // Wrap env with Platform SDK for automatic metric tracking
  // Note: platform:usage:scheduled tracks the hourly data collection job
  // This gives visibility into the platform-usage worker's own resource consumption

  const trackedEnv = withFeatureBudget(env, 'platform:usage:scheduled', {
    ctx,
    cacheKv: env.PLATFORM_CACHE as any, // Type assertion for KVNamespace compatibility
    telemetryQueue: env.PLATFORM_TELEMETRY,
    checkCircuitBreaker: false, // Don't block scheduled jobs - this is the control plane
  });

  // 1. Check global stop flag (use raw env for circuit breaker state)
  const globalStop = await env.PLATFORM_CACHE.get(CB_KEYS.GLOBAL_STOP);
  if (globalStop === 'true') {
    log.info('Global stop flag is set, skipping collection');
    return;
  }

  // 2. Determine sampling mode (use trackedEnv for D1 operations inside)
  const previousMode = await env.PLATFORM_CACHE.get(CB_KEYS.USAGE_SAMPLING_MODE);
  const samplingMode = await determineSamplingMode(trackedEnv);
  const samplingModeStr = SamplingMode[samplingMode];

  // Log sampling mode change
  if (previousMode && previousMode !== samplingModeStr) {
    log.info('Sampling mode changed', { previousMode, newMode: samplingModeStr });
    await logCircuitBreakerEvent(
      trackedEnv,
      previousMode > samplingModeStr ? 'sample_restore' : 'sample_reduce',
      'platform-usage',
      `Sampling mode changed from ${previousMode} to ${samplingModeStr}`,
      await getD1WriteCount(trackedEnv),
      samplingModeStr,
      previousMode
    );
  }

  // Update sampling mode in KV (circuit breaker state - not tracked)
  await env.PLATFORM_CACHE.put(CB_KEYS.USAGE_SAMPLING_MODE, samplingModeStr);

  // 3. Check if we should run this hour
  if (!shouldRunThisHour(samplingMode, currentHour)) {
    log.info('Skipping collection', { mode: samplingModeStr, hour: currentHour });
    return;
  }

  let totalD1Writes = 0;

  try {
    // 3.5 Validate API token before making GraphQL calls
    const accountName = await validateCloudflareToken(trackedEnv);
    if (!accountName) {
      log.error('Cloudflare API token validation failed - aborting collection');
      return;
    }

    // 4. Collect Cloudflare usage data with retry logic (F1 Fix)
    // CloudflareGraphQL constructor takes env object with CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN
    const graphql = new CloudflareGraphQL({
      CLOUDFLARE_ACCOUNT_ID: trackedEnv.CLOUDFLARE_ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: trackedEnv.CLOUDFLARE_API_TOKEN,
    });
    const usage = await collectWithRetry(graphql, log);

    // Load previous hour's cumulative metrics for delta calculation
    const previousMetrics = await loadPreviousHourMetrics(trackedEnv);
    if (previousMetrics) {
      log.info('Loaded previous metrics, calculating deltas', {
        previousHour: previousMetrics.snapshotHour,
      });
    } else {
      log.info('No previous metrics found - first collection, will use raw cumulative values');
    }

    // DEBUG: Log GraphQL results to diagnose zero metrics issue
    log.info('GraphQL results', {
      workers: usage.workers.length,
      d1: usage.d1.length,
      kv: usage.kv.length,
      r2: usage.r2.length,
      doRequests: usage.durableObjects.requests,
      vectorize: usage.vectorize.length,
      aiGateway: usage.aiGateway.length,
      pages: usage.pages.length,
    });
    if (usage.workers.length > 0) {
      const sample = usage.workers[0];
      log.info('Sample Worker', {
        scriptName: sample.scriptName,
        requests: sample.requests,
        cpuTimeMs: sample.cpuTimeMs,
      });
    } else {
      log.warn('No workers data returned from GraphQL API');
    }

    // Collect Workflows metrics separately (not part of AccountUsage)
    const workflowsData = await graphql.getWorkflowsMetrics('24h');
    const workflows = {
      executions: workflowsData.totalExecutions,
      successes: workflowsData.totalSuccesses,
      failures: workflowsData.totalFailures,
      wallTimeMs: workflowsData.totalWallTimeMs,
      cpuTimeMs: workflowsData.totalCpuTimeMs,
    };

    // Collect Queues metrics separately (not part of AccountUsage)
    // Uses queueConsumerMetricsAdaptiveGroups + queueMessageOperationsAdaptiveGroups
    const queuesData = await graphql.getQueuesMetrics('24h');
    const totalMessagesProduced = queuesData.reduce((sum, q) => sum + q.messagesProduced, 0);
    const totalMessagesConsumed = queuesData.reduce((sum, q) => sum + q.messagesConsumed, 0);
    const queues = {
      messagesProduced: totalMessagesProduced,
      messagesConsumed: totalMessagesConsumed,
    };
    log.info('Queues', {
      queuesCount: queuesData.length,
      produced: totalMessagesProduced,
      consumed: totalMessagesConsumed,
    });

    // Collect Workers AI model breakdown for detailed tracking
    const workersAIData = await graphql.getWorkersAIMetrics('24h');
    log.info('Workers AI getWorkersAIMetrics returned', {
      metricsLength: workersAIData.metrics.length,
      totalRequests: workersAIData.totalRequests,
    });
    if (workersAIData.metrics.length > 0) {
      totalD1Writes += await persistWorkersAIModelBreakdown(
        trackedEnv,
        snapshotHour,
        workersAIData.metrics
      );
      log.info('Persisted Workers AI model entries', { count: workersAIData.metrics.length });
    }

    // Collect Workers AI neurons/tokens via GraphQL (aiInferenceAdaptive dataset)
    // This provides accurate neuron counts for billing - much better than Analytics Engine estimates
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const now = new Date();

    // Workers AI Neurons via GraphQL (aiInferenceAdaptive dataset)
    // LIMITATION: GraphQL only provides account-level totals with byModel breakdown.
    // There is NO per-script or per-project dimension available from the Cloudflare GraphQL API.
    // All Workers AI neurons are therefore tracked as '_unattributed' in hourly_usage_snapshots.
    // Future option: Reconcile with Platform SDK telemetry which tracks aiNeurons per feature.
    const workersAINeuronData = await graphql.getWorkersAINeuronsGraphQL({
      startDate: hourAgo.toISOString().split('T')[0],
      endDate: now.toISOString().split('T')[0],
    });
    log.info('Workers AI neurons', {
      totalNeurons: workersAINeuronData.totalNeurons,
      inputTokens: workersAINeuronData.totalInputTokens,
      outputTokens: workersAINeuronData.totalOutputTokens,
      modelCount: workersAINeuronData.byModel.length,
    });

    // Fallback: If project-reported metrics are empty but GraphQL has model data, use GraphQL data
    // This ensures workersai_model_usage table gets populated even if projects aren't writing workersai.cost
    if (workersAIData.metrics.length === 0 && workersAINeuronData.byModel.length > 0) {
      log.info('Using GraphQL neurons fallback for Workers AI model breakdown', {
        modelCount: workersAINeuronData.byModel.length,
      });
      // Convert GraphQL neuron data to the format expected by persistWorkersAIModelBreakdown
      const fallbackMetrics = workersAINeuronData.byModel.map((m) => ({
        project: 'all', // GraphQL doesn't provide per-project breakdown
        model: m.modelId, // modelId is the correct property name from GraphQL response
        requests: m.requestCount,
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens,
        costUsd: m.neurons * 0.000011, // $0.011 per 1000 neurons
        isEstimated: true, // Mark as estimated since we're deriving from neurons
      }));
      totalD1Writes += await persistWorkersAIModelBreakdown(
        trackedEnv,
        snapshotHour,
        fallbackMetrics
      );
      log.info('Persisted Workers AI model entries from GraphQL fallback', {
        count: fallbackMetrics.length,
      });
    }

    // Collect Vectorize query metrics via GraphQL (vectorizeV2QueriesAdaptiveGroups dataset)
    // This provides actual query counts - previously was hardcoded to 0
    const vectorizeQueryData = await graphql.getVectorizeQueriesGraphQL({
      startDate: hourAgo.toISOString().split('T')[0],
      endDate: now.toISOString().split('T')[0],
    });
    log.info('Vectorize queries', {
      dimensions: vectorizeQueryData.totalQueriedDimensions,
      vectors: vectorizeQueryData.totalServedVectors,
      indexes: vectorizeQueryData.byIndex.length,
    });

    // Collect Vectorize storage metrics via GraphQL (vectorizeV2StorageAdaptiveGroups dataset)
    const vectorizeStorageData = await graphql.getVectorizeStorageGraphQL({
      startDate: hourAgo.toISOString().split('T')[0],
      endDate: now.toISOString().split('T')[0],
    });
    log.info('Vectorize storage', {
      dimensions: vectorizeStorageData.totalStoredDimensions,
      vectors: vectorizeStorageData.totalVectorCount,
      indexes: vectorizeStorageData.byIndex.length,
    });

    // Attribute Vectorize queries to projects using D1 registry
    // This enables tracking of Vectorize usage per project instead of just account-level totals
    const projectCache = await buildProjectLookupCache(trackedEnv);
    const vectorizeAttribution = attributeVectorizeByProject(
      vectorizeQueryData.byIndex,
      projectCache,
      vectorizeQueryData.totalQueriedDimensions
    );
    log.info('Vectorize attribution', {
      projectsAttributed: vectorizeAttribution.byProject.size,
      unattributed: vectorizeAttribution.unattributed,
    });
    // Log per-project breakdown for debugging
    for (const [projectId, dimensions] of vectorizeAttribution.byProject) {
      log.info('Project vectorize dimensions', { projectId, dimensions });
    }
    if (vectorizeAttribution.unattributed > 0) {
      log.info('Unattributed vectorize dimensions', {
        dimensions: vectorizeAttribution.unattributed,
      });
    }

    // Build AI metrics object for persistHourlySnapshot
    const aiMetrics = {
      workersAINeurons: workersAINeuronData.totalNeurons,
      workersAIRequests: workersAINeuronData.byModel.reduce((sum, m) => sum + m.requestCount, 0),
      vectorizeQueries: vectorizeQueryData.totalQueriedDimensions, // Using dimensions as proxy for query count
      vectorizeVectorsQueried: vectorizeQueryData.totalServedVectors,
    };

    // Collect AI Gateway model breakdown for detailed tracking
    log.info('AI Gateway gateways count', { count: usage.aiGateway.length });
    for (const gateway of usage.aiGateway) {
      log.info('AI Gateway', {
        gatewayId: gateway.gatewayId,
        totalRequests: gateway.totalRequests,
        byModelLength: gateway.byModel?.length ?? 'undefined',
      });
      if (gateway.byModel && gateway.byModel.length > 0) {
        totalD1Writes += await persistAIGatewayModelBreakdown(
          env,
          snapshotHour,
          gateway.gatewayId,
          gateway.byModel
        );
        log.info('Persisted AI Gateway model entries', {
          gatewayId: gateway.gatewayId,
          count: gateway.byModel.length,
        });
      } else {
        log.warn('AI Gateway has no model breakdown data', { gatewayId: gateway.gatewayId });
      }
    }

    // Calculate costs (include queues data for cost calculation)
    // Reserved for future cost tracking feature
    const _costs = calculateMonthlyCosts({ ...usage, queues: queuesData });

    // Build current cumulative metrics for delta calculation
    // These are the raw cumulative values from GraphQL (daily totals)
    const workersRequests = usage.workers.reduce((sum, w) => sum + w.requests, 0);
    const workersErrors = usage.workers.reduce((sum, w) => sum + w.errors, 0);
    const workersCpuTimeMs = usage.workers.reduce((sum, w) => sum + w.cpuTimeMs, 0);
    const d1RowsRead = usage.d1.reduce((sum, d) => sum + d.rowsRead, 0);
    const d1RowsWritten = usage.d1.reduce((sum, d) => sum + d.rowsWritten, 0);
    const kvReads = usage.kv.reduce((sum, k) => sum + k.reads, 0);
    const kvWrites = usage.kv.reduce((sum, k) => sum + k.writes, 0);
    const kvDeletes = usage.kv.reduce((sum, k) => sum + k.deletes, 0);
    const kvLists = usage.kv.reduce((sum, k) => sum + k.lists, 0);
    const r2ClassAOps = usage.r2.reduce((sum, r) => sum + r.classAOperations, 0);
    const r2ClassBOps = usage.r2.reduce((sum, r) => sum + r.classBOperations, 0);
    const r2EgressBytes = usage.r2.reduce((sum, r) => sum + r.egressBytes, 0);
    const aiGatewayRequests = usage.aiGateway.reduce((sum, a) => sum + a.totalRequests, 0);
    const aiGatewayTokensIn = 0; // Not available separately
    const aiGatewayTokensOut = usage.aiGateway.reduce((sum, a) => sum + a.totalTokens, 0);
    const aiGatewayCached = usage.aiGateway.reduce((sum, a) => sum + a.cachedRequests, 0);
    const pagesDeployments = usage.pages.reduce((sum, p) => sum + p.totalBuilds, 0);

    // Current cumulative metrics object (to be saved for next delta calculation)
    const currentCumulativeMetrics: PreviousHourMetrics = {
      snapshotHour,
      timestamp: Math.floor(Date.now() / 1000),
      do: {
        requests: usage.durableObjects.requests,
        gbSeconds: usage.durableObjects.gbSeconds,
        storageReadUnits: usage.durableObjects.storageReadUnits,
        storageWriteUnits: usage.durableObjects.storageWriteUnits,
        storageDeleteUnits: usage.durableObjects.storageDeleteUnits,
      },
      workersAI: {
        neurons: aiMetrics.workersAINeurons,
        requests: aiMetrics.workersAIRequests,
      },
      vectorize: {
        queries: aiMetrics.vectorizeQueries,
      },
      queues: {
        produced: totalMessagesProduced,
        consumed: totalMessagesConsumed,
      },
      workflows: {
        executions: workflowsData.totalExecutions,
        successes: workflowsData.totalSuccesses,
        failures: workflowsData.totalFailures,
        wallTimeMs: workflowsData.totalWallTimeMs,
        cpuTimeMs: workflowsData.totalCpuTimeMs,
      },
      workers: {
        requests: workersRequests,
        errors: workersErrors,
        cpuTimeMs: workersCpuTimeMs,
      },
      d1: {
        rowsRead: d1RowsRead,
        rowsWritten: d1RowsWritten,
      },
      kv: {
        reads: kvReads,
        writes: kvWrites,
        deletes: kvDeletes,
        lists: kvLists,
      },
      r2: {
        classAOps: r2ClassAOps,
        classBOps: r2ClassBOps,
        egressBytes: r2EgressBytes,
      },
      aiGateway: {
        requests: aiGatewayRequests,
        tokensIn: aiGatewayTokensIn,
        tokensOut: aiGatewayTokensOut,
        cached: aiGatewayCached,
      },
      pages: {
        deployments: pagesDeployments,
        bandwidthBytes: 0, // Not available from PagesMetrics
      },
    };

    // Calculate deltas (current - previous, or current if no previous)
    // MAX_HOURLY_DELTAS caps prevent cumulative values being stored as hourly deltas
    // when the KV key for previous metrics expires or is missing.
    const deltas: MetricDeltas = {
      do: {
        requests: calculateDelta(usage.durableObjects.requests, previousMetrics?.do?.requests, MAX_HOURLY_DELTAS.do_requests),
        gbSeconds: calculateDelta(usage.durableObjects.gbSeconds, previousMetrics?.do?.gbSeconds, MAX_HOURLY_DELTAS.do_gb_seconds),
        storageReadUnits: calculateDelta(
          usage.durableObjects.storageReadUnits,
          previousMetrics?.do?.storageReadUnits
        ),
        storageWriteUnits: calculateDelta(
          usage.durableObjects.storageWriteUnits,
          previousMetrics?.do?.storageWriteUnits
        ),
        storageDeleteUnits: calculateDelta(
          usage.durableObjects.storageDeleteUnits,
          previousMetrics?.do?.storageDeleteUnits
        ),
      },
      workersAI: {
        neurons: calculateDelta(aiMetrics.workersAINeurons, previousMetrics?.workersAI?.neurons, MAX_HOURLY_DELTAS.ai_neurons),
        requests: calculateDelta(aiMetrics.workersAIRequests, previousMetrics?.workersAI?.requests, MAX_HOURLY_DELTAS.ai_requests),
      },
      vectorize: {
        queries: calculateDelta(aiMetrics.vectorizeQueries, previousMetrics?.vectorize?.queries, MAX_HOURLY_DELTAS.vectorize_queries),
      },
      queues: {
        produced: calculateDelta(totalMessagesProduced, previousMetrics?.queues?.produced, MAX_HOURLY_DELTAS.queue_produced),
        consumed: calculateDelta(totalMessagesConsumed, previousMetrics?.queues?.consumed, MAX_HOURLY_DELTAS.queue_consumed),
      },
      workflows: {
        executions: calculateDelta(
          workflowsData.totalExecutions,
          previousMetrics?.workflows?.executions,
          MAX_HOURLY_DELTAS.workflow_executions
        ),
        successes: calculateDelta(
          workflowsData.totalSuccesses,
          previousMetrics?.workflows?.successes,
          MAX_HOURLY_DELTAS.workflow_executions
        ),
        failures: calculateDelta(workflowsData.totalFailures, previousMetrics?.workflows?.failures),
        wallTimeMs: calculateDelta(
          workflowsData.totalWallTimeMs,
          previousMetrics?.workflows?.wallTimeMs
        ),
        cpuTimeMs: calculateDelta(
          workflowsData.totalCpuTimeMs,
          previousMetrics?.workflows?.cpuTimeMs
        ),
      },
      workers: {
        requests: calculateDelta(workersRequests, previousMetrics?.workers?.requests, MAX_HOURLY_DELTAS.workers_requests),
        errors: calculateDelta(workersErrors, previousMetrics?.workers?.errors, MAX_HOURLY_DELTAS.workers_errors),
        cpuTimeMs: calculateDelta(workersCpuTimeMs, previousMetrics?.workers?.cpuTimeMs, MAX_HOURLY_DELTAS.workers_cpu_ms),
      },
      d1: {
        rowsRead: calculateDelta(d1RowsRead, previousMetrics?.d1?.rowsRead, MAX_HOURLY_DELTAS.d1_rows_read),
        rowsWritten: calculateDelta(d1RowsWritten, previousMetrics?.d1?.rowsWritten, MAX_HOURLY_DELTAS.d1_rows_written),
      },
      kv: {
        reads: calculateDelta(kvReads, previousMetrics?.kv?.reads, MAX_HOURLY_DELTAS.kv_reads),
        writes: calculateDelta(kvWrites, previousMetrics?.kv?.writes, MAX_HOURLY_DELTAS.kv_writes),
        deletes: calculateDelta(kvDeletes, previousMetrics?.kv?.deletes, MAX_HOURLY_DELTAS.kv_deletes),
        lists: calculateDelta(kvLists, previousMetrics?.kv?.lists, MAX_HOURLY_DELTAS.kv_lists),
      },
      r2: {
        classAOps: calculateDelta(r2ClassAOps, previousMetrics?.r2?.classAOps, MAX_HOURLY_DELTAS.r2_class_a),
        classBOps: calculateDelta(r2ClassBOps, previousMetrics?.r2?.classBOps, MAX_HOURLY_DELTAS.r2_class_b),
        egressBytes: calculateDelta(r2EgressBytes, previousMetrics?.r2?.egressBytes, MAX_HOURLY_DELTAS.r2_egress_bytes),
      },
      aiGateway: {
        requests: calculateDelta(aiGatewayRequests, previousMetrics?.aiGateway?.requests, MAX_HOURLY_DELTAS.ai_gateway_requests),
        tokensIn: calculateDelta(aiGatewayTokensIn, previousMetrics?.aiGateway?.tokensIn, MAX_HOURLY_DELTAS.ai_gateway_tokens),
        tokensOut: calculateDelta(aiGatewayTokensOut, previousMetrics?.aiGateway?.tokensOut, MAX_HOURLY_DELTAS.ai_gateway_tokens),
        cached: calculateDelta(aiGatewayCached, previousMetrics?.aiGateway?.cached),
      },
      pages: {
        deployments: calculateDelta(pagesDeployments, previousMetrics?.pages?.deployments, MAX_HOURLY_DELTAS.pages_deployments),
        bandwidthBytes: calculateDelta(0, previousMetrics?.pages?.bandwidthBytes),
      },
    };

    log.info('Calculated deltas', {
      doRequests: deltas.do.requests,
      workersRequests: deltas.workers.requests,
      d1Reads: deltas.d1.rowsRead,
    });

    // Calculate hourly costs using delta values with proper proration
    // This fixes the issue where monthly base costs ($5/mo) were applied without proration
    const hourlyUsageMetrics: HourlyUsageMetrics = {
      workersRequests: deltas.workers.requests,
      workersCpuMs: deltas.workers.cpuTimeMs,
      d1Reads: deltas.d1.rowsRead,
      d1Writes: deltas.d1.rowsWritten,
      kvReads: deltas.kv.reads,
      kvWrites: deltas.kv.writes,
      kvDeletes: deltas.kv.deletes,
      kvLists: deltas.kv.lists,
      r2ClassA: deltas.r2.classAOps,
      r2ClassB: deltas.r2.classBOps,
      vectorizeQueries: deltas.vectorize.queries,
      aiGatewayRequests: deltas.aiGateway.requests,
      durableObjectsRequests: deltas.do.requests,
      durableObjectsGbSeconds: deltas.do.gbSeconds,
      workersAINeurons: deltas.workersAI.neurons,
      queuesMessages: deltas.queues.produced + deltas.queues.consumed,
    };
    const hourlyCosts = calculateHourlyCosts(hourlyUsageMetrics);
    log.info('Hourly prorated costs', {
      workers: hourlyCosts.workers,
      baseHourly: PRICING_TIERS.workers.baseCostMonthly / HOURS_PER_MONTH,
      total: hourlyCosts.total,
    });

    // 5. Persist hourly snapshot for 'all' project (using deltas)
    totalD1Writes += await persistHourlySnapshot(
      env,
      snapshotHour,
      'all',
      usage,
      hourlyCosts, // Use prorated hourly costs instead of monthly costs
      samplingMode,
      workflows,
      aiMetrics,
      queues,
      deltas // Pass deltas for accurate hourly values
    );

    // 6. Persist per-project breakdowns
    const projectUsage = calculateProjectCosts(usage);

    // Build per-project cumulative values for delta calculation
    const projectCumulatives: Record<
      string,
      {
        workersRequests: number;
        workersErrors: number;
        workersCpuTimeMs: number;
        d1RowsRead: number;
        d1RowsWritten: number;
        kvReads: number;
        kvWrites: number;
        kvDeletes: number;
        kvLists: number;
        r2ClassAOps: number;
        r2ClassBOps: number;
        doRequests: number;
        doGbSeconds: number;
      }
    > = {};

    for (const project of projectUsage) {
      const projectId = project.project.toLowerCase().replace(/ /g, '-');
      projectCumulatives[projectId] = {
        workersRequests: project.workersRequests,
        workersErrors: project.workersErrors,
        workersCpuTimeMs: project.workersCpuTimeMs,
        d1RowsRead: project.d1RowsRead,
        d1RowsWritten: project.d1RowsWritten,
        kvReads: project.kvReads,
        kvWrites: project.kvWrites,
        kvDeletes: project.kvDeletes,
        kvLists: project.kvLists,
        r2ClassAOps: project.r2ClassAOps,
        r2ClassBOps: project.r2ClassBOps,
        doRequests: project.doRequests,
        doGbSeconds: project.doGbSeconds,
      };
    }

    // Add per-project cumulative values to currentCumulativeMetrics before saving
    currentCumulativeMetrics.projects = projectCumulatives;

    // Save current cumulative metrics (including per-project) for next hour's delta calculation
    await savePreviousHourMetrics(trackedEnv, currentCumulativeMetrics);

    // F2 Fix: Removed per-project INSERT to eliminate double-counting
    // Per-project data is now available via:
    //   - resource_usage_snapshots (SDK telemetry, per-resource granularity)
    //   - Analytics Engine (real-time telemetry)
    // Account-wide totals are stored in project='all' row only

    // Update rolling 24h DO GB-seconds counter for circuit breaker (per-project)
    // TODO: This currently queries historical per-project data; will need refactoring
    // to use resource_usage_snapshots or Analytics Engine once historical data ages out
    for (const project of projectUsage) {
      const projectNormalized = project.project.toLowerCase().replace(/ /g, '-');
      try {
        const doSum = await env.PLATFORM_DB.prepare(
          `SELECT SUM(do_gb_seconds) as total FROM hourly_usage_snapshots
           WHERE project = ? AND snapshot_hour >= datetime('now', '-24 hours')`
        )
          .bind(projectNormalized)
          .first<{ total: number | null }>();

        const doGbSeconds24h = doSum?.total ?? 0;
        await setDOGbSecondsCount(trackedEnv, projectNormalized, doGbSeconds24h);
        log.info('Project DO GB-seconds (24h)', {
          project: projectNormalized,
          gbSeconds: doGbSeconds24h,
        });
      } catch (err) {
        log.error(`Failed to update DO GB-seconds for ${projectNormalized}`, err);
      }
    }

    // 6.4 Persist _unattributed row for usage that couldn't be attributed to specific projects
    // This includes: unattributed Vectorize dimensions, Workers AI neurons (no per-project GraphQL)
    // and catch-all cost subtraction (account total - sum of known projects)
    const accountTotalCost = usage.workers.reduce((sum, w) => sum + w.requests * 0, 0); // Placeholder
    const attributedProjectsCost = projectUsage.reduce((sum, p) => sum + p.total, 0);
    const unattributedCostRemainder = Math.max(0, accountTotalCost - attributedProjectsCost);

    // Only create _unattributed row if there's something to track
    const hasUnattributedVectorize = vectorizeAttribution.unattributed > 0;
    const hasUnattributedAINeurons = workersAINeuronData.totalNeurons > 0;

    if (hasUnattributedVectorize || hasUnattributedAINeurons) {
      log.info('Unattributed usage', {
        vectorizeDimensions: vectorizeAttribution.unattributed,
        workersAINeurons: workersAINeuronData.totalNeurons,
      });

      await env.PLATFORM_DB.prepare(
        `
        INSERT INTO hourly_usage_snapshots (
          id, snapshot_hour, project,
          vectorize_dimensions, workersai_neurons, workersai_cost_usd,
          total_cost_usd, collection_timestamp, sampling_mode
        ) VALUES (?, ?, '_unattributed', ?, ?, ?, ?, ?, ?)
        ON CONFLICT (snapshot_hour, project) DO UPDATE SET
          vectorize_dimensions = excluded.vectorize_dimensions,
          workersai_neurons = excluded.workersai_neurons,
          workersai_cost_usd = excluded.workersai_cost_usd,
          total_cost_usd = excluded.total_cost_usd,
          collection_timestamp = excluded.collection_timestamp
        `
      )
        .bind(
          generateId(),
          snapshotHour,
          vectorizeAttribution.unattributed,
          workersAINeuronData.totalNeurons,
          // Workers AI cost: $0.011 per 1000 neurons (after free tier)
          (Math.max(0, workersAINeuronData.totalNeurons - 10000) / 1000) * 0.011,
          unattributedCostRemainder,
          Math.floor(Date.now() / 1000),
          samplingModeStr
        )
        .run();
      totalD1Writes++;
    }

    // 6.5 Persist resource-level snapshots for multi-level aggregation
    totalD1Writes += await persistResourceUsageSnapshots(
      trackedEnv,
      snapshotHour,
      usage,
      queuesData,
      workflowsData
    );

    // 7. Collect external metrics in parallel (once daily at midnight)
    if (currentHour === 0) {
      // Collect all external providers in parallel via the collector framework
      // TODO: Register your collectors in workers/lib/usage/collectors/index.ts
      const externalMetrics = await collectExternalMetrics(trackedEnv);
      if (externalMetrics.errors.length > 0) {
        log.warn('Some external providers failed', { failedProviders: externalMetrics.errors });
      }

      // Persist collected external metrics to D1 third_party_usage table.
      // The collector framework returns results keyed by collector name.
      // TODO: Add your own persistence logic for each registered collector.
      // See workers/lib/usage/collectors/example.ts for the collector template.
      //
      // Example:
      //   const myProviderData = externalMetrics.results['my-provider'];
      //   if (myProviderData) {
      //     await persistThirdPartyUsage(trackedEnv, today, 'my-provider', 'metric_name', value, 'unit', cost);
      //     totalD1Writes++;
      //   }

      // 7b. Collect and persist Cloudflare subscription data (once daily at midnight)
      const cfSubscriptions = await graphql.getAccountSubscriptions();
      if (cfSubscriptions) {
        // Persist each subscription
        for (const sub of cfSubscriptions.subscriptions) {
          await persistThirdPartyUsage(
            env,
            today,
            'cloudflare',
            'subscription',
            sub.price,
            sub.frequency,
            sub.price,
            sub.ratePlanName
          );
          totalD1Writes++;
        }

        // Persist summary flags
        await persistThirdPartyUsage(trackedEnv, today, 'cloudflare', 'has_workers_paid', cfSubscriptions.hasWorkersPaid ? 1 : 0, 'boolean', 0);
        await persistThirdPartyUsage(trackedEnv, today, 'cloudflare', 'has_r2_paid', cfSubscriptions.hasR2Paid ? 1 : 0, 'boolean', 0);
        await persistThirdPartyUsage(trackedEnv, today, 'cloudflare', 'has_analytics_engine', cfSubscriptions.hasAnalyticsEngine ? 1 : 0, 'boolean', 0);
        await persistThirdPartyUsage(trackedEnv, today, 'cloudflare', 'monthly_base_cost', cfSubscriptions.monthlyBaseCost, 'usd', cfSubscriptions.monthlyBaseCost);
        totalD1Writes += 4;

        // Persist plan inclusions (free tier amounts)
        const inclusions = cfSubscriptions.planInclusions;
        await persistThirdPartyUsage(trackedEnv, today, 'cloudflare', 'workers_requests_included', inclusions.requestsIncluded, 'requests', 0);
        await persistThirdPartyUsage(trackedEnv, today, 'cloudflare', 'workers_cpu_time_included', inclusions.cpuTimeIncluded, 'ms', 0);
        await persistThirdPartyUsage(trackedEnv, today, 'cloudflare', 'd1_rows_read_included', inclusions.d1RowsReadIncluded, 'rows', 0);
        await persistThirdPartyUsage(trackedEnv, today, 'cloudflare', 'd1_rows_written_included', inclusions.d1RowsWrittenIncluded, 'rows', 0);
        await persistThirdPartyUsage(trackedEnv, today, 'cloudflare', 'd1_storage_included', inclusions.d1StorageIncluded, 'bytes', 0);
        await persistThirdPartyUsage(trackedEnv, today, 'cloudflare', 'kv_reads_included', inclusions.kvReadsIncluded, 'reads', 0);
        await persistThirdPartyUsage(trackedEnv, today, 'cloudflare', 'kv_writes_included', inclusions.kvWritesIncluded, 'writes', 0);
        await persistThirdPartyUsage(trackedEnv, today, 'cloudflare', 'kv_storage_included', inclusions.kvStorageIncluded, 'bytes', 0);
        await persistThirdPartyUsage(trackedEnv, today, 'cloudflare', 'r2_class_a_included', inclusions.r2ClassAIncluded, 'operations', 0);
        await persistThirdPartyUsage(trackedEnv, today, 'cloudflare', 'r2_class_b_included', inclusions.r2ClassBIncluded, 'operations', 0);
        await persistThirdPartyUsage(trackedEnv, today, 'cloudflare', 'r2_storage_included', inclusions.r2StorageIncluded, 'bytes', 0);
        await persistThirdPartyUsage(trackedEnv, today, 'cloudflare', 'do_requests_included', inclusions.doRequestsIncluded, 'requests', 0);
        await persistThirdPartyUsage(trackedEnv, today, 'cloudflare', 'do_duration_included', inclusions.doDurationIncluded, 'gb_seconds', 0);
        await persistThirdPartyUsage(trackedEnv, today, 'cloudflare', 'do_storage_included', inclusions.doStorageIncluded, 'bytes', 0);
        await persistThirdPartyUsage(trackedEnv, today, 'cloudflare', 'vectorize_queried_dimensions_included', inclusions.vectorizeQueriedDimensionsIncluded, 'dimensions', 0);
        await persistThirdPartyUsage(trackedEnv, today, 'cloudflare', 'vectorize_stored_dimensions_included', inclusions.vectorizeStoredDimensionsIncluded, 'dimensions', 0);
        await persistThirdPartyUsage(trackedEnv, today, 'cloudflare', 'queues_operations_included', inclusions.queuesOperationsIncluded, 'operations', 0);
        totalD1Writes += 17;

        log.info('Collected subscriptions', {
          plansCount: cfSubscriptions.subscriptions.length,
          hasWorkersPaid: cfSubscriptions.hasWorkersPaid,
          monthlyBaseCost: cfSubscriptions.monthlyBaseCost,
        });
      }

      log.info('Completed third-party provider collection');
    }

    // 7.5 Send hourly P1 error digest (runs every hour)
    // Aggregates errors from the last hour and sends digest if thresholds exceeded
    try {
      await sendHourlyErrorDigest(trackedEnv);
      log.info('Hourly P1 error digest check complete');
    } catch (error) {
      log.error('Failed to send hourly error digest', error);
    }

    // 7.6 Hourly D1 write anomaly detection (catches spikes within hours, not days)
    try {
      const hourlyAnomalies = await detectHourlyD1WriteAnomalies(trackedEnv);
      if (hourlyAnomalies > 0) {
        log.info('Hourly D1 write anomaly detected', { hourlyAnomalies });
        totalD1Writes += hourlyAnomalies; // Each anomaly = 1 D1 write (recordAnomaly)
      }
    } catch (error) {
      log.error('Failed hourly D1 write anomaly check', error);
    }

    // 8. Run daily rollup at midnight for yesterday
    if (currentHour === 0) {
      const yesterday = new Date();
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];
      totalD1Writes += await runDailyRollup(trackedEnv, yesterdayStr);

      // Run AI model breakdown daily rollups
      totalD1Writes += await runWorkersAIModelDailyRollup(trackedEnv, yesterdayStr);
      totalD1Writes += await runAIGatewayModelDailyRollup(trackedEnv, yesterdayStr);
      log.info('Completed AI model breakdown daily rollups', { date: yesterdayStr });

      // Run feature-level usage rollup from Analytics Engine (SDK telemetry)
      // This aggregates D1, KV, AI, Vectorize metrics captured by Platform SDK
      totalD1Writes += await runFeatureUsageDailyRollup(trackedEnv, yesterdayStr);
      log.info('Completed feature usage daily rollup', { date: yesterdayStr });

      // Self-healing: Fix any gaps in daily rollups from previous issues
      const gapsFilled = await backfillMissingDays(trackedEnv);
      if (gapsFilled > 0) {
        log.info('Gap-fill fixed days with missing data', { daysFilled: gapsFilled });
        totalD1Writes += gapsFilled; // Each day = 1 rollup write (approx)
      }

      // Calculate usage vs allowance percentages (after rollups complete)
      totalD1Writes += await calculateUsageVsAllowancePercentages(trackedEnv, today);

      // Invalidate daily cache to ensure fresh data is served after rollups
      await invalidateDailyCache(trackedEnv);

      // Run monthly rollup on 1st of month for previous month
      if (new Date().getUTCDate() === 1) {
        const lastMonth = new Date();
        lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
        const lastMonthStr = lastMonth.toISOString().slice(0, 7);
        totalD1Writes += await runMonthlyRollup(trackedEnv, lastMonthStr);
      }

      // Cleanup old data
      const cleanup = await cleanupOldData(trackedEnv);
      totalD1Writes += cleanup.hourlyDeleted + cleanup.dailyDeleted;

      // Run anomaly detection at midnight
      const anomalies = await detectAnomalies(trackedEnv);
      if (anomalies > 0) {
        log.info('Detected anomalies', { anomalies });
        totalD1Writes += anomalies; // Each anomaly = 1 D1 write
      }

      // Check monthly budget limits (sums daily_usage_rollups for current month)
      try {
        const monthlyViolations = await checkMonthlyBudgets(trackedEnv);
        if (monthlyViolations > 0) {
          log.info('Monthly budget violations detected', { monthlyViolations });
        }
      } catch (error) {
        log.error('Failed monthly budget check', error);
      }

      // Run dataset registry discovery weekly (Sunday at midnight UTC)
      const dayOfWeek = new Date().getUTCDay();
      if (dayOfWeek === 0) {
        const registryResult = await discoverAndUpdateDatasetRegistry(trackedEnv);
        totalD1Writes += registryResult.d1Writes;
        log.info('Dataset registry updated', {
          datasetsChecked: registryResult.datasetsChecked,
          newBillableAlerts: registryResult.newBillableAlerts,
        });
      }

      // Send daily P2 error summary (runs at midnight UTC)
      try {
        await sendDailyErrorSummary(trackedEnv);
        log.info('Daily P2 error summary sent');
      } catch (error) {
        log.error('Failed to send daily error summary', error);
      }

      // Cleanup old error events (7-day retention)
      try {
        const errorEventsDeleted = await cleanupOldErrorEvents(trackedEnv);
        if (errorEventsDeleted > 0) {
          totalD1Writes += 1;
          log.info('Cleaned up old error events', { deleted: errorEventsDeleted });
        }
      } catch (error) {
        log.error('Failed to cleanup error events', error);
      }
    }

    // 9. Update D1 write counter
    await incrementD1WriteCount(trackedEnv, totalD1Writes);

    // 10. Check and trip circuit breakers if needed
    await checkAndTripCircuitBreakers(trackedEnv);

    // 11. Send Platform SDK heartbeat
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await health(HEARTBEAT_HEALTH, env.PLATFORM_CACHE as any, env.PLATFORM_TELEMETRY, ctx);
    log.debug('Heartbeat sent');

    // Signal success to Gatus heartbeat
    pingHeartbeat(ctx, env.GATUS_HEARTBEAT_URL, env.GATUS_TOKEN, true);

    const duration = Date.now() - startTime;
    log.info('Collection complete', { durationMs: duration, d1Writes: totalD1Writes });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('Error during collection', undefined, { errorMessage });

    // Signal failure to Gatus heartbeat
    pingHeartbeat(ctx, env.GATUS_HEARTBEAT_URL, env.GATUS_TOKEN, false);

    // Send alert on failure
    if (env.SLACK_WEBHOOK_URL) {
      await sendSlackAlert(trackedEnv, {
        text: ':warning: Platform Usage Collection Failed',
        attachments: [
          {
            color: 'warning',
            fields: [
              { title: 'Error', value: errorMessage, short: false },
              { title: 'Hour', value: snapshotHour, short: true },
              { title: 'Sampling Mode', value: SamplingMode[samplingMode], short: true },
            ],
          },
        ],
      });
    }
  }
}
// =============================================================================
// WORKER EXPORT
// =============================================================================

export default {
  // Queue consumer - processes SDK telemetry messages and DLQ
  async queue(batch: MessageBatch<TelemetryMessage>, env: Env): Promise<void> {
    // Dispatch to appropriate handler based on queue name
    if (batch.queue === 'platform-telemetry-dlq') {
      await handleDLQ(batch, env);
    } else {
      await handleQueue(batch, env);
    }
  },

  // Scheduled handler - runs daily at midnight UTC
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleScheduled(event, env, ctx);
  },

  // HTTP handler - API endpoints
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Test error endpoint - triggers an intentional error for testing the error collection pipeline
    // Usage: GET /test-error?type=exception|soft|warning
    if (path === '/test-error') {
      const errorType = url.searchParams.get('type') || 'exception';

      if (errorType === 'soft') {
        console.error(
          'TEST SOFT ERROR: This is a test soft error from platform-usage /test-error endpoint'
        );
        return new Response(JSON.stringify({ triggered: 'soft_error', worker: 'platform-usage' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (errorType === 'warning') {
        console.warn(
          'TEST WARNING: This is a test warning from platform-usage /test-error endpoint'
        );
        return new Response(JSON.stringify({ triggered: 'warning', worker: 'platform-usage' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Default: throw an exception
      throw new Error(
        'TEST EXCEPTION: This is a test exception from platform-usage /test-error endpoint'
      );
    }

    // Create trace context and logger for request tracking
    const traceContext = createTraceContext(request, env);
    const log = createLoggerFromRequest(request, env, 'platform-usage', 'platform:usage:api');

    log.info('Request received', {
      method: request.method,
      path,
      traceId: traceContext.traceId,
      spanId: traceContext.spanId,
    });

    try {
      // Wrap env with Platform SDK for automatic metric tracking
      // Note: platform:usage:api tracks this worker's own API usage
      // The SDK will track all D1/KV/AI operations and report via PLATFORM_TELEMETRY queue
       
      const trackedEnv = withFeatureBudget(env, 'platform:usage:api', {
        ctx,
        cacheKv: env.PLATFORM_CACHE as any, // Type assertion for KVNamespace compatibility
        telemetryQueue: env.PLATFORM_TELEMETRY,
        checkCircuitBreaker: false, // Don't block API requests - this is the control plane
      });

      // Handle settings verify endpoint (GET only)
      // Returns all settings from D1 and validates completeness
      if (path === '/usage/settings/verify' || path === '/api/usage/settings/verify') {
        if (request.method !== 'GET') {
          const response = jsonResponse({ error: 'Method not allowed' }, 405);
          const headers = new Headers(response.headers);
          Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
          return new Response(response.body, { status: response.status, headers });
        }
        const response = await handleSettingsVerify(trackedEnv);
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
        return new Response(response.body, { status: response.status, headers });
      }

      // Handle settings endpoint (supports GET and PUT)
      // Support both direct paths (/usage/settings) and proxied paths (/api/usage/settings)
      if (path === '/usage/settings' || path === '/api/usage/settings') {
        let response: Response;
        if (request.method === 'GET') {
          response = await handleGetSettings(trackedEnv);
        } else if (request.method === 'PUT') {
          response = await handlePutSettings(request, trackedEnv);
        } else {
          response = jsonResponse({ error: 'Method not allowed' }, 405);
        }
        // Add CORS headers to response
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
        return new Response(response.body, { status: response.status, headers });
      }

      // Handle manual trigger for testing (POST)
      // Supports ?forceHour=0 to test midnight-only functions
      if (
        (path === '/usage/trigger' || path === '/api/usage/trigger') &&
        request.method === 'POST'
      ) {
        const forceHour = url.searchParams.get('forceHour');
        let scheduledTime = Date.now();

        // If forceHour is specified, create a fake time at that hour
        const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:trigger');
        if (forceHour !== null) {
          const hour = parseInt(forceHour, 10);
          if (!isNaN(hour) && hour >= 0 && hour <= 23) {
            const fakeDate = new Date();
            fakeDate.setUTCHours(hour, 0, 0, 0);
            scheduledTime = fakeDate.getTime();
            log.info('Manual trigger requested with forceHour - running synchronously', {
              forceHour: hour,
            });
          } else {
            log.info('Manual trigger requested - running synchronously');
          }
        } else {
          log.info('Manual trigger requested - running synchronously');
        }

        // Create a fake scheduled event for testing
        const fakeEvent = {
          scheduledTime,
          cron: '0 * * * *',
        } as ScheduledEvent;
        const ctx = {
          waitUntil: (promise: Promise<unknown>) =>
            promise.catch((err) => log.error('waitUntil error', err)),
          passThroughOnException: () => {},
          props: {},
        } as unknown as ExecutionContext;
        try {
          // Run synchronously to see any errors
          await handleScheduled(fakeEvent, env, ctx);
          const response = jsonResponse({ success: true, message: 'Scheduled handler completed' });
          const headers = new Headers(response.headers);
          Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
          return new Response(response.body, { status: response.status, headers });
        } catch (error) {
          log.error('Error', error);
          const response = jsonResponse({ success: false, error: String(error) }, 500);
          const headers = new Headers(response.headers);
          Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
          return new Response(response.body, { status: response.status, headers });
        }
      }

      // Handle direct daily rollup for a specific date (POST)
      // Supports ?date=YYYY-MM-DD to re-rollup a specific day from hourly data
      if ((path === '/usage/rollup' || path === '/api/usage/rollup') && request.method === 'POST') {
        const dateParam = url.searchParams.get('date');
        if (!dateParam) {
          return jsonResponse({ error: 'Missing required param: date (YYYY-MM-DD)' }, 400);
        }
        // Validate date format
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(dateParam)) {
          return jsonResponse({ error: 'Invalid date format. Use YYYY-MM-DD.' }, 400);
        }
        const rollupLog = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:rollup');
        rollupLog.info('Manual rollup requested', { date: dateParam });
        try {
          const changes = await runDailyRollup(trackedEnv, dateParam);
          const response = jsonResponse({
            success: true,
            date: dateParam,
            changes,
            message: `Daily rollup completed for ${dateParam}`,
          });
          const headers = new Headers(response.headers);
          Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
          return new Response(response.body, { status: response.status, headers });
        } catch (error) {
          rollupLog.error('Error', error);
          const response = jsonResponse({ success: false, error: String(error) }, 500);
          const headers = new Headers(response.headers);
          Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
          return new Response(response.body, { status: response.status, headers });
        }
      }

      // Handle circuit breaker reset (POST)
      if (
        (path === '/usage/reset-circuit-breaker' || path === '/api/usage/reset-circuit-breaker') &&
        request.method === 'POST'
      ) {
        const response = await handleResetCircuitBreaker(request, trackedEnv);
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
        return new Response(response.body, { status: response.status, headers });
      }

      // Handle circuit breaker status (GET)
      if (
        (path === '/usage/circuit-breaker-status' ||
          path === '/api/usage/circuit-breaker-status') &&
        request.method === 'GET'
      ) {
        const response = await handleCircuitBreakerStatus(trackedEnv);
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
        return new Response(response.body, { status: response.status, headers });
      }

      // Handle live usage endpoint (GET) - real-time KV data with API key auth
      if ((path === '/usage/live' || path === '/api/usage/live') && request.method === 'GET') {
        const response = await handleLiveUsage(request, trackedEnv);
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
        return new Response(response.body, { status: response.status, headers });
      }

      // Handle backfill endpoint (POST) - task-27.3
      if (
        (path === '/usage/backfill' || path === '/api/usage/backfill') &&
        request.method === 'POST'
      ) {
        const response = await handleBackfill(request, trackedEnv);
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
        return new Response(response.body, { status: response.status, headers });
      }

      // ==========================================================================
      // GAP DETECTION ENDPOINTS
      // ==========================================================================

      // GET /usage/gaps - Current gap status
      if ((path === '/usage/gaps' || path === '/api/usage/gaps') && request.method === 'GET') {
        const response = await handleGapsStatus(trackedEnv);
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
        return new Response(response.body, { status: response.status, headers });
      }

      // GET /usage/gaps/history - Gap detection history
      if (
        (path === '/usage/gaps/history' || path === '/api/usage/gaps/history') &&
        request.method === 'GET'
      ) {
        const response = await handleGapsHistory(trackedEnv, url);
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
        return new Response(response.body, { status: response.status, headers });
      }

      // POST /usage/gaps/backfill - Trigger backfill for date range
      if (
        (path === '/usage/gaps/backfill' || path === '/api/usage/gaps/backfill') &&
        request.method === 'POST'
      ) {
        const response = await handleGapsBackfill(request, trackedEnv);
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
        return new Response(response.body, { status: response.status, headers });
      }

      // GET /usage/gaps/backfill/history - Backfill history
      if (
        (path === '/usage/gaps/backfill/history' || path === '/api/usage/gaps/backfill/history') &&
        request.method === 'GET'
      ) {
        const response = await handleBackfillHistory(trackedEnv, url);
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
        return new Response(response.body, { status: response.status, headers });
      }

      // GET /usage/gaps/projects - Per-project health status
      if (
        (path === '/usage/gaps/projects' || path === '/api/usage/gaps/projects') &&
        request.method === 'GET'
      ) {
        const response = await handleProjectsHealth(trackedEnv);
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
        return new Response(response.body, { status: response.status, headers });
      }

      // ==========================================================================
      // AUDIT ENDPOINTS (Phase 2 Usage Capture Audit)
      // ==========================================================================

      // GET /usage/audit - Latest comprehensive audit report
      if ((path === '/usage/audit' || path === '/api/usage/audit') && request.method === 'GET') {
        const response = await handleGetAudit(trackedEnv);
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
        return new Response(response.body, { status: response.status, headers });
      }

      // GET /usage/audit/history - Comprehensive audit history
      if (
        (path === '/usage/audit/history' || path === '/api/usage/audit/history') &&
        request.method === 'GET'
      ) {
        const response = await handleGetAuditHistory(request, trackedEnv);
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
        return new Response(response.body, { status: response.status, headers });
      }

      // GET /usage/audit/attribution - Latest attribution report
      if (
        (path === '/usage/audit/attribution' || path === '/api/usage/audit/attribution') &&
        request.method === 'GET'
      ) {
        const response = await handleGetAttribution(trackedEnv);
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
        return new Response(response.body, { status: response.status, headers });
      }

      // GET /usage/audit/features - Latest feature coverage report
      if (
        (path === '/usage/audit/features' || path === '/api/usage/audit/features') &&
        request.method === 'GET'
      ) {
        const response = await handleGetFeatureCoverage(request, trackedEnv);
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
        return new Response(response.body, { status: response.status, headers });
      }

      // ==========================================================================
      // BEHAVIORAL ANALYSIS ENDPOINTS
      // ==========================================================================

      // GET /usage/audit/behavioral - Combined hotspots + regressions summary
      if (
        (path === '/usage/audit/behavioral' || path === '/api/usage/audit/behavioral') &&
        request.method === 'GET'
      ) {
        const response = await handleGetBehavioral(request, trackedEnv);
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
        return new Response(response.body, { status: response.status, headers });
      }

      // GET /usage/audit/behavioral/hotspots - File hotspots with risk scoring
      if (
        (path === '/usage/audit/behavioral/hotspots' || path === '/api/usage/audit/behavioral/hotspots') &&
        request.method === 'GET'
      ) {
        const response = await handleGetHotspots(request, trackedEnv);
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
        return new Response(response.body, { status: response.status, headers });
      }

      // GET /usage/audit/behavioral/regressions - SDK regressions
      if (
        (path === '/usage/audit/behavioral/regressions' || path === '/api/usage/audit/behavioral/regressions') &&
        request.method === 'GET'
      ) {
        const response = await handleGetRegressions(request, trackedEnv);
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
        return new Response(response.body, { status: response.status, headers });
      }

      // POST /usage/audit/behavioral/regressions/:id/acknowledge - Acknowledge regression
      const acknowledgeMatch = path.match(/^\/(?:api\/)?usage\/audit\/behavioral\/regressions\/(\d+)\/acknowledge$/);
      if (acknowledgeMatch && request.method === 'POST') {
        const response = await handleAcknowledgeRegression(request, trackedEnv, acknowledgeMatch[1]);
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
        return new Response(response.body, { status: response.status, headers });
      }

      // ==========================================================================
      // DLQ ADMIN ENDPOINTS
      // ==========================================================================

      // GET /admin/dlq - List DLQ messages
      if ((path === '/admin/dlq' || path === '/api/admin/dlq') && request.method === 'GET') {
        const response = await handleListDLQ(url, trackedEnv);
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
        return new Response(response.body, { status: response.status, headers });
      }

      // GET /admin/dlq/stats - Get DLQ statistics
      if (
        (path === '/admin/dlq/stats' || path === '/api/admin/dlq/stats') &&
        request.method === 'GET'
      ) {
        const response = await handleDLQStats(trackedEnv);
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
        return new Response(response.body, { status: response.status, headers });
      }

      // POST /admin/dlq/replay-all - Replay all pending DLQ messages
      if (
        (path === '/admin/dlq/replay-all' || path === '/api/admin/dlq/replay-all') &&
        request.method === 'POST'
      ) {
        const response = await handleReplayAllDLQ(url, trackedEnv);
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
        return new Response(response.body, { status: response.status, headers });
      }

      // POST /admin/dlq/:id/replay - Replay a specific DLQ message
      const replayMatch = path.match(/^\/(?:api\/)?admin\/dlq\/([^/]+)\/replay$/);
      if (replayMatch && request.method === 'POST') {
        const messageId = replayMatch[1];
        const response = await handleReplayDLQ(messageId, trackedEnv);
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
        return new Response(response.body, { status: response.status, headers });
      }

      // POST /admin/dlq/:id/discard - Discard a specific DLQ message
      const discardMatch = path.match(/^\/(?:api\/)?admin\/dlq\/([^/]+)\/discard$/);
      if (discardMatch && request.method === 'POST') {
        const messageId = discardMatch[1];
        const body = await request.json().catch(() => ({}));
        const reason = (body as { reason?: string }).reason || 'Manually discarded';
        const response = await handleDiscardDLQ(messageId, reason, trackedEnv);
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
        return new Response(response.body, { status: response.status, headers });
      }

      // Handle feature circuit breakers (GET/PUT) - Phase 4
      if (
        path === '/usage/features/circuit-breakers' ||
        path === '/api/usage/features/circuit-breakers'
      ) {
        let response: Response;
        if (request.method === 'GET') {
          response = await handleGetFeatureCircuitBreakers(trackedEnv);
        } else if (request.method === 'PUT') {
          response = await handlePutFeatureCircuitBreakers(request, trackedEnv);
        } else {
          response = jsonResponse({ error: 'Method not allowed' }, 405);
        }
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
        return new Response(response.body, { status: response.status, headers });
      }

      // Handle feature budgets (GET/PUT) - Phase 4
      if (path === '/usage/features/budgets' || path === '/api/usage/features/budgets') {
        let response: Response;
        if (request.method === 'GET') {
          response = await handleGetFeatureBudgets(trackedEnv);
        } else if (request.method === 'PUT') {
          response = await handlePutFeatureBudgets(request, trackedEnv);
        } else {
          response = jsonResponse({ error: 'Method not allowed' }, 405);
        }
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
        return new Response(response.body, { status: response.status, headers });
      }

      // Handle feature history (GET only) - Phase 5.2
      if (path === '/usage/features/history' || path === '/api/usage/features/history') {
        if (request.method !== 'GET') {
          return jsonResponse({ error: 'Method not allowed' }, 405);
        }
        const response = await handleGetFeatureHistory(url, trackedEnv);
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
        return new Response(response.body, { status: response.status, headers });
      }

      // Handle circuit breaker events (GET only) - Phase 5.3
      if (
        path === '/usage/features/circuit-breaker-events' ||
        path === '/api/usage/features/circuit-breaker-events'
      ) {
        if (request.method !== 'GET') {
          return jsonResponse({ error: 'Method not allowed' }, 405);
        }
        const response = await handleGetCircuitBreakerEvents(url, trackedEnv);
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
        return new Response(response.body, { status: response.status, headers });
      }

      // Only handle GET requests for other endpoints
      if (request.method !== 'GET') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
      }

      // Route to appropriate handler
      let response: Response;

      // Support both direct paths (/usage) and proxied paths (/api/usage)
      if (path === '/usage' || path === '/' || path === '/api/usage') {
        response = await handleUsage(url, trackedEnv);
      } else if (path === '/usage/costs' || path === '/api/usage/costs') {
        response = await handleCosts(url, trackedEnv);
      } else if (path === '/usage/thresholds' || path === '/api/usage/thresholds') {
        response = await handleThresholds(url, trackedEnv);
      } else if (path === '/usage/enhanced' || path === '/api/usage/enhanced') {
        response = await handleEnhanced(url, trackedEnv);
      } else if (path === '/usage/compare' || path === '/api/usage/compare') {
        response = await handleCompare(url, trackedEnv);
      } else if (path === '/usage/workersai' || path === '/api/usage/workersai') {
        response = await handleWorkersAI(url, trackedEnv);
      } else if (path === '/usage/daily' || path === '/api/usage/daily') {
        response = await handleDaily(url, trackedEnv);
      } else if (path === '/usage/utilization' || path === '/api/usage/utilization') {
        response = await handleUtilization(url, trackedEnv);
      } else if (path === '/usage/status' || path === '/api/usage/status') {
        response = await handleStatus(url, trackedEnv);
      } else if (path === '/usage/projects' || path === '/api/usage/projects') {
        response = await handleProjects(trackedEnv);
      } else if (path === '/usage/anomalies' || path === '/api/usage/anomalies') {
        response = await handleAnomalies(url, trackedEnv);
      } else if (path === '/usage/features' || path === '/api/usage/features') {
        response = await handleFeatures(url, trackedEnv);
      } else if (path === '/usage/query' || path === '/api/usage/query') {
        response = await handleUsageQuery(url, trackedEnv);
      } else if (path === '/usage/health-trends' || path === '/api/usage/health-trends') {
        // Phase 2 AI Judge: Health trends for dashboard
        response = await handleGetHealthTrends(url, trackedEnv);
      } else if (
        path === '/usage/health-trends/latest' ||
        path === '/api/usage/health-trends/latest'
      ) {
        // Phase 2 AI Judge: Latest health scores summary
        response = await handleGetLatestHealthTrends(trackedEnv);
      } else {
        response = jsonResponse({ error: 'Not found' }, 404);
      }

      // Add CORS headers to response
      const headers = new Headers(response.headers);
      Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));

      return new Response(response.body, {
        status: response.status,
        headers,
      });
    } catch (error) {
      // Global error handler with full context
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      log.error('Unhandled error in fetch handler', {
        error: errorMessage,
        stack: errorStack,
        path,
        method: request.method,
        traceId: traceContext.traceId,
        spanId: traceContext.spanId,
      });

      const errorResponse = jsonResponse(
        {
          error: 'Internal server error',
          traceId: traceContext.traceId,
        },
        500
      );
      const headers = new Headers(errorResponse.headers);
      Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
      return new Response(errorResponse.body, { status: errorResponse.status, headers });
    }
  },
};
