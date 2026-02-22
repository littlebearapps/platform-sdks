/**
 * Usage Settings Handlers
 *
 * Handler functions for settings, circuit breaker status, and live usage endpoints.
 * Extracted from platform-usage.ts as part of Phase B migration.
 */

import {
  type Env,
  type BudgetThresholds,
  type SettingsResponse,
  type LiveUsageResponse,
  SamplingMode,
} from '../shared';
import { CB_KEYS, SETTINGS_KEY, EXPECTED_USAGE_SETTINGS } from '../shared/constants';
import {
  jsonResponse,
  getPlatformSettings,
  getBudgetThresholds,
  validateApiKey,
} from '../shared/utils';
import {
  DEFAULT_ALERT_THRESHOLDS,
  mergeThresholds,
  type AlertThresholds,
  type ServiceThreshold,
} from '../../shared/cloudflare';
import { createLoggerFromEnv } from '@littlebearapps/platform-sdk';

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Save budget thresholds to D1 usage_settings table.
 */
async function saveBudgetThresholds(
  env: Env,
  thresholds: Partial<BudgetThresholds>
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  if (thresholds.softBudgetLimit !== undefined) {
    await env.PLATFORM_DB.prepare(
      `
      INSERT INTO usage_settings (id, project, setting_key, setting_value, updated_at)
      VALUES (?, 'all', 'budget_soft_limit', ?, ?)
      ON CONFLICT (project, setting_key) DO UPDATE SET
        setting_value = excluded.setting_value,
        updated_at = excluded.updated_at
    `
    )
      .bind(`budget_soft_limit_all`, thresholds.softBudgetLimit.toString(), now)
      .run();
  }

  if (thresholds.warningThreshold !== undefined) {
    await env.PLATFORM_DB.prepare(
      `
      INSERT INTO usage_settings (id, project, setting_key, setting_value, updated_at)
      VALUES (?, 'all', 'budget_warning_threshold', ?, ?)
      ON CONFLICT (project, setting_key) DO UPDATE SET
        setting_value = excluded.setting_value,
        updated_at = excluded.updated_at
    `
    )
      .bind(`budget_warning_threshold_all`, thresholds.warningThreshold.toString(), now)
      .run();
  }
}

// =============================================================================
// SETTINGS HANDLERS
// =============================================================================

/**
 * Handle GET /usage/settings (task-17.16)
 *
 * Returns current alert threshold configuration.
 * Thresholds are stored in KV and merged with defaults.
 */
export async function handleGetSettings(env: Env): Promise<Response> {
  const startTime = Date.now();

  try {
    // Fetch alert thresholds from KV and budget thresholds from D1 in parallel
    const [stored, budgetThresholds] = await Promise.all([
      env.PLATFORM_CACHE.get(SETTINGS_KEY, 'json') as Promise<{
        thresholds: Partial<AlertThresholds>;
        updated: string;
      } | null>,
      getBudgetThresholds(env),
    ]);

    if (stored) {
      // Merge stored thresholds with defaults to ensure all services are present
      const thresholds = mergeThresholds(stored.thresholds);
      return jsonResponse({
        success: true,
        thresholds,
        budgetThresholds,
        updated: stored.updated,
        cached: true,
        responseTimeMs: Date.now() - startTime,
      } satisfies SettingsResponse & { responseTimeMs: number });
    }

    // No custom config, return defaults
    return jsonResponse({
      success: true,
      thresholds: DEFAULT_ALERT_THRESHOLDS,
      budgetThresholds,
      cached: false,
      responseTimeMs: Date.now() - startTime,
    } satisfies SettingsResponse & { responseTimeMs: number });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // Error fetching settings - log at warn level since defaults will be used

    return jsonResponse(
      {
        success: false,
        error: 'Failed to fetch settings',
        message: errorMessage,
      },
      500
    );
  }
}

/**
 * Handle PUT /usage/settings (task-17.16)
 *
 * Updates the alert threshold configuration and budget thresholds.
 * Request body should contain partial AlertThresholds and/or budgetThresholds.
 */
export async function handlePutSettings(request: Request, env: Env): Promise<Response> {
  const startTime = Date.now();

  try {
    const body = (await request.json()) as {
      thresholds?: Partial<AlertThresholds>;
      budgetThresholds?: Partial<BudgetThresholds>;
    };

    if (
      (!body.thresholds || typeof body.thresholds !== 'object') &&
      (!body.budgetThresholds || typeof body.budgetThresholds !== 'object')
    ) {
      return jsonResponse(
        {
          success: false,
          error: 'Invalid request body',
          message: 'Request body must contain a thresholds and/or budgetThresholds object',
        },
        400
      );
    }

    // Validate alert threshold values if provided
    if (body.thresholds) {
      for (const [service, config] of Object.entries(body.thresholds)) {
        if (config) {
          // Validate percentage values are 0-100
          if (
            config.warningPct !== undefined &&
            (config.warningPct < 0 || config.warningPct > 100)
          ) {
            return jsonResponse(
              {
                success: false,
                error: 'Invalid threshold value',
                message: `${service}.warningPct must be between 0 and 100`,
              },
              400
            );
          }
          if (config.highPct !== undefined && (config.highPct < 0 || config.highPct > 100)) {
            return jsonResponse(
              {
                success: false,
                error: 'Invalid threshold value',
                message: `${service}.highPct must be between 0 and 100`,
              },
              400
            );
          }
          if (
            config.criticalPct !== undefined &&
            (config.criticalPct < 0 || config.criticalPct > 100)
          ) {
            return jsonResponse(
              {
                success: false,
                error: 'Invalid threshold value',
                message: `${service}.criticalPct must be between 0 and 100`,
              },
              400
            );
          }
          // Validate absoluteMax is non-negative
          if (config.absoluteMax !== undefined && config.absoluteMax < 0) {
            return jsonResponse(
              {
                success: false,
                error: 'Invalid threshold value',
                message: `${service}.absoluteMax must be non-negative`,
              },
              400
            );
          }
        }
      }
    }

    // Validate budget threshold values if provided
    if (body.budgetThresholds) {
      if (
        body.budgetThresholds.softBudgetLimit !== undefined &&
        (body.budgetThresholds.softBudgetLimit < 0 || body.budgetThresholds.softBudgetLimit > 10000)
      ) {
        return jsonResponse(
          {
            success: false,
            error: 'Invalid budget threshold value',
            message: 'softBudgetLimit must be between 0 and 10000',
          },
          400
        );
      }
      if (
        body.budgetThresholds.warningThreshold !== undefined &&
        (body.budgetThresholds.warningThreshold < 0 ||
          body.budgetThresholds.warningThreshold > 10000)
      ) {
        return jsonResponse(
          {
            success: false,
            error: 'Invalid budget threshold value',
            message: 'warningThreshold must be between 0 and 10000',
          },
          400
        );
      }
    }

    const updated = new Date().toISOString();
    let fullThresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS;

    // Update alert thresholds in KV if provided
    if (body.thresholds) {
      // Get existing settings to merge with
      const existing = (await env.PLATFORM_CACHE.get(SETTINGS_KEY, 'json')) as {
        thresholds: Partial<AlertThresholds>;
        updated: string;
      } | null;

      // Merge new thresholds with existing (deep merge per service)
      const mergedThresholds: Record<string, Partial<ServiceThreshold>> = {};
      const allServices = Array.from(
        new Set([...Object.keys(existing?.thresholds ?? {}), ...Object.keys(body.thresholds)])
      );

      for (const service of allServices) {
        const existingService = existing?.thresholds?.[service];
        const newService = body.thresholds[service];
        if (existingService || newService) {
          mergedThresholds[service] = {
            ...existingService,
            ...newService,
          };
        }
      }

      await env.PLATFORM_CACHE.put(
        SETTINGS_KEY,
        JSON.stringify({ thresholds: mergedThresholds, updated }),
        { expirationTtl: 60 * 60 * 24 * 365 } // 1 year TTL
      );

      fullThresholds = mergeThresholds(mergedThresholds as Partial<AlertThresholds>);
      // Alert thresholds updated
    }

    // Update budget thresholds in D1 if provided
    if (body.budgetThresholds) {
      await saveBudgetThresholds(env, body.budgetThresholds);
      // Budget thresholds updated
    }

    // Fetch current budget thresholds for the response
    const currentBudgetThresholds = await getBudgetThresholds(env);

    return jsonResponse({
      success: true,
      thresholds: fullThresholds,
      budgetThresholds: currentBudgetThresholds,
      updated,
      responseTimeMs: Date.now() - startTime,
    } satisfies SettingsResponse & { responseTimeMs: number });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // Error updating settings

    return jsonResponse(
      {
        success: false,
        error: 'Failed to update settings',
        message: errorMessage,
      },
      500
    );
  }
}

/**
 * Handle GET /usage/settings/verify
 *
 * Returns all settings from D1 usage_settings table and validates completeness.
 * Used to verify that all expected settings exist after migrations/sync.
 */
export async function handleSettingsVerify(env: Env): Promise<Response> {
  try {
    // Fetch all settings from D1
    const result = await env.PLATFORM_DB.prepare(
      `
      SELECT setting_key, setting_value, project, updated_at
      FROM usage_settings
      WHERE project = 'all'
      ORDER BY setting_key
    `
    ).all<{ setting_key: string; setting_value: string; project: string; updated_at: number }>();

    const settings = result.results ?? [];
    const foundKeys = new Set(settings.map((s) => s.setting_key));

    // Check for missing expected settings
    const missingKeys = EXPECTED_USAGE_SETTINGS.filter((key) => !foundKeys.has(key));

    // Check for unexpected settings (not in expected list)
    const unexpectedKeys = settings
      .map((s) => s.setting_key)
      .filter((key) => !EXPECTED_USAGE_SETTINGS.includes(key));

    const status = missingKeys.length === 0 ? 'complete' : 'incomplete';

    return jsonResponse({
      status,
      totalExpected: EXPECTED_USAGE_SETTINGS.length,
      totalFound: settings.length,
      missingCount: missingKeys.length,
      unexpectedCount: unexpectedKeys.length,
      missing: missingKeys,
      unexpected: unexpectedKeys,
      settings: settings.map((s) => ({
        key: s.setting_key,
        value: s.setting_value,
        project: s.project,
        updatedAt: s.updated_at ? new Date(s.updated_at * 1000).toISOString() : null,
      })),
    });
  } catch (error) {
    return jsonResponse(
      {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
}

// =============================================================================
// CIRCUIT BREAKER STATUS HANDLER
// =============================================================================

/**
 * Handle GET /usage/circuit-breaker-status
 *
 * Returns current circuit breaker status for all services.
 */
export async function handleCircuitBreakerStatus(env: Env): Promise<Response> {
  const startTime = Date.now();

  try {
    // Fetch settings and KV values in parallel
    const [settings, globalStop, samplingMode, d1Writes] = await Promise.all([
      getPlatformSettings(env),
      env.PLATFORM_CACHE.get(CB_KEYS.GLOBAL_STOP),
      env.PLATFORM_CACHE.get(CB_KEYS.USAGE_SAMPLING_MODE),
      env.PLATFORM_CACHE.get(CB_KEYS.D1_WRITES_24H),
    ]);

    // Get registered projects from D1 and fetch their CB statuses dynamically
    // TODO: Ensure your projects are registered in project_registry
    const projectRows = await env.PLATFORM_DB.prepare(
      `SELECT project_id FROM project_registry WHERE project_id != 'all'`
    ).all<{ project_id: string }>();
    const registeredProjects = projectRows.results?.map((r) => r.project_id) ?? ['platform'];

    // Fetch all project CB statuses in parallel
    const projectStatusEntries = await Promise.all(
      registeredProjects.map(async (pid) => {
        const cbKey = `PROJECT:${pid.toUpperCase().replace(/-/g, '-')}:STATUS`;
        const status = await env.PLATFORM_CACHE.get(cbKey);
        return { id: pid, status: status ?? 'active' };
      })
    );

    const d1WriteLimit = settings.d1WriteLimit;
    const d1WritesNum = d1Writes ? parseInt(d1Writes, 10) : 0;
    const d1WritePercentage = (d1WritesNum / d1WriteLimit) * 100;

    // Determine sampling mode name
    const samplingModeName = samplingMode
      ? (Object.keys(SamplingMode).find(
          (k) => SamplingMode[k as keyof typeof SamplingMode] === parseInt(samplingMode, 10)
        ) ?? 'FULL')
      : 'FULL';

    // Build dynamic circuit breaker status objects
    const circuitBreakers: Record<string, { status: string; paused: boolean }> = {
      globalStop: { status: globalStop === 'true' ? 'true' : 'false', paused: globalStop === 'true' },
    };
    for (const entry of projectStatusEntries) {
      circuitBreakers[entry.id] = {
        status: entry.status,
        paused: entry.status === 'paused',
      };
    }

    return jsonResponse({
      success: true,
      circuitBreakers,
      // Array format for UI consumption (matches CircuitBreakerStatus component)
      projects: projectStatusEntries.map((entry) => ({
        id: entry.id,
        status: entry.status === 'paused' ? 'tripped' : 'active',
        label: entry.status === 'paused' ? 'Paused' : 'Active',
      })),
      adaptiveSampling: {
        samplingMode: samplingModeName,
        d1Writes24h: d1WritesNum,
        d1WriteLimit,
        d1WritePercentage: Math.round(d1WritePercentage * 100) / 100,
      },
      timestamp: new Date().toISOString(),
      responseTimeMs: Date.now() - startTime,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:circuitbreaker');
    log.error('Error fetching circuit breaker status', error instanceof Error ? error : undefined, {
      errorMessage,
    });

    return jsonResponse(
      {
        success: false,
        error: 'Failed to fetch circuit breaker status',
        message: errorMessage,
      },
      500
    );
  }
}

// =============================================================================
// LIVE USAGE HANDLER
// =============================================================================

/**
 * Handle GET /usage/live
 *
 * Returns real-time KV data for monitoring:
 * - Circuit breaker states (global + per-project)
 * - Adaptive sampling mode and D1 write tracking
 * - Latest hourly snapshot metrics
 *
 * Requires X-API-Key header for authentication.
 */
export async function handleLiveUsage(request: Request, env: Env): Promise<Response> {
  const startTime = Date.now();

  // Validate API key
  const authError = validateApiKey(request, env);
  if (authError) return authError;

  try {
    // Fetch settings and KV data in parallel for minimal latency
    const [settings, globalStop, samplingMode, d1Writes] = await Promise.all([
      getPlatformSettings(env),
      env.PLATFORM_CACHE.get(CB_KEYS.GLOBAL_STOP),
      env.PLATFORM_CACHE.get(CB_KEYS.USAGE_SAMPLING_MODE),
      env.PLATFORM_CACHE.get(CB_KEYS.D1_WRITES_24H),
    ]);

    // Get registered projects and fetch their CB statuses dynamically
    const liveProjectRows = await env.PLATFORM_DB.prepare(
      `SELECT project_id FROM project_registry WHERE project_id != 'all'`
    ).all<{ project_id: string }>();
    const liveRegisteredProjects = liveProjectRows.results?.map((r) => r.project_id) ?? ['platform'];

    const projectStatuses: Array<{ project: string; status: string | null }> = await Promise.all(
      liveRegisteredProjects.map(async (pid) => {
        const cbKey = `PROJECT:${pid.toUpperCase().replace(/-/g, '-')}:STATUS`;
        const status = await env.PLATFORM_CACHE.get(cbKey);
        return { project: pid, status };
      })
    );

    const d1WriteLimit = settings.d1WriteLimit;

    // Build list of active circuit breakers
    const activeBreakers: LiveUsageResponse['circuitBreakers']['activeBreakers'] = [];

    for (const { project, status } of projectStatuses) {
      if (status === 'paused') {
        activeBreakers.push({
          project,
          status: 'paused',
          reason: 'Resource limit exceeded',
        });
      } else if (status === 'degraded') {
        activeBreakers.push({
          project,
          status: 'degraded',
          reason: 'Operating in degraded mode',
        });
      }
    }

    // Calculate D1 write metrics
    const d1WritesNum = d1Writes ? parseInt(d1Writes, 10) : 0;
    const d1WritePercentage = (d1WritesNum / d1WriteLimit) * 100;

    // Determine sampling mode name
    const samplingModeName = samplingMode
      ? (Object.keys(SamplingMode).find(
          (k) => SamplingMode[k as keyof typeof SamplingMode] === parseInt(samplingMode, 10)
        ) ?? 'FULL')
      : 'FULL';

    // Fetch latest hourly snapshot from D1 for request estimates
    let latestSnapshot: LiveUsageResponse['latestSnapshot'] = null;
    try {
      const snapshotResult = await env.PLATFORM_DB.prepare(
        `SELECT snapshot_hour, workers_requests, d1_rows_read, kv_reads
         FROM hourly_usage_snapshots
         WHERE project = 'all'
         ORDER BY snapshot_hour DESC
         LIMIT 1`
      ).first<{
        snapshot_hour: string;
        workers_requests: number | null;
        d1_rows_read: number | null;
        kv_reads: number | null;
      }>();

      if (snapshotResult) {
        latestSnapshot = {
          snapshotHour: snapshotResult.snapshot_hour,
          workersRequests: snapshotResult.workers_requests,
          d1RowsRead: snapshotResult.d1_rows_read,
          kvReads: snapshotResult.kv_reads,
        };
      }
    } catch (dbError) {
      const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:live');
      log.error(
        'Failed to fetch latest snapshot from D1',
        dbError instanceof Error ? dbError : undefined
      );
      // Continue without snapshot data - KV data is primary
    }

    const response: LiveUsageResponse = {
      timestamp: new Date().toISOString(),
      circuitBreakers: {
        globalStop: globalStop === 'true',
        activeBreakers,
      },
      adaptiveSampling: {
        mode: samplingModeName,
        d1Writes24h: d1WritesNum,
        d1WriteLimit,
        d1WritePercentage: Math.round(d1WritePercentage * 100) / 100,
      },
      latestSnapshot,
      responseTimeMs: Date.now() - startTime,
    };

    return jsonResponse(response);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:live');
    log.error('Error fetching live usage', error instanceof Error ? error : undefined, {
      errorMessage,
    });

    return jsonResponse(
      {
        success: false,
        error: 'Failed to fetch live usage data',
        message: errorMessage,
      },
      500
    );
  }
}
