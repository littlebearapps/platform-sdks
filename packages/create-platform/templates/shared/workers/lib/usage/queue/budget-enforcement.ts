/**
 * Budget Enforcement
 *
 * Circuit breaker management and budget enforcement for platform-usage queue processing.
 * Handles D1 write limits, DO GB-seconds tracking, and feature-level budget violations.
 *
 * Extracted from platform-usage.ts as part of Phase D modularisation.
 *
 * Key Components:
 * - determineCircuitBreakerStatus: Tiered status (CLOSED/WARNING/OPEN) from usage vs limit
 * - checkAndTripCircuitBreakers: Evaluates D1/DO limits and trips project-level breakers
 * - checkAndUpdateBudgetStatus: Feature-level budget checking from telemetry metrics
 * - logCircuitBreakerEvent: D1 audit trail for CB events
 * - sendSlackAlert: Alert delivery to Slack webhook
 * - D1/KV tracking helpers: Read/write usage counters
 */

import type { Env, DailyLimits } from '../shared';
import type { FeatureMetrics } from '@littlebearapps/platform-sdk';
import { CB_KEYS, METRIC_TO_BUDGET_KEY } from '../shared';
import { generateId, fetchWithRetry } from '../shared';
import { createLoggerFromEnv } from '@littlebearapps/platform-sdk';
import { CB_STATUS, type CircuitBreakerStatusValue } from '../../circuit-breaker-middleware';
/**
 * Hard limit multiplier for circuit breaker enforcement.
 * When usage exceeds (soft_limit * HARD_LIMIT_MULTIPLIER), the project is hard-paused.
 */
const HARD_LIMIT_MULTIPLIER = 1.5;
import {
  getPlatformSettings,
  getProjectSetting,
  DEFAULT_PLATFORM_SETTINGS,
} from '../../platform-settings';

// =============================================================================
// CIRCUIT BREAKER STATUS DETERMINATION
// =============================================================================

/**
 * Determine circuit breaker status based on usage vs limit with tiered logic.
 *
 * - OPEN (paused): usage > limit * 1.5 (hard limit exceeded - block requests)
 * - WARNING: usage > limit (soft limit exceeded - allow with warnings)
 * - CLOSED (active): usage <= limit (normal operation)
 *
 * @param usage - Current usage value
 * @param limit - Soft limit threshold
 * @returns Circuit breaker status value
 */
export function determineCircuitBreakerStatus(
  usage: number,
  limit: number
): CircuitBreakerStatusValue {
  const hardLimit = limit * HARD_LIMIT_MULTIPLIER;

  if (usage >= hardLimit) {
    return CB_STATUS.OPEN; // 'paused' - block requests
  } else if (usage >= limit) {
    return CB_STATUS.WARNING; // 'warning' - allow with logging
  } else {
    return CB_STATUS.CLOSED; // 'active' - normal operation
  }
}

// =============================================================================
// D1 WRITE TRACKING
// =============================================================================

/**
 * Get the current D1 write count for the rolling 24h window.
 * Stored in KV with timestamp for sliding window calculation.
 *
 * @param env - Worker environment
 * @returns Current D1 write count
 */
export async function getD1WriteCount(env: Env): Promise<number> {
  try {
    const countStr = await env.PLATFORM_CACHE.get(CB_KEYS.D1_WRITES_24H);
    return countStr ? parseInt(countStr, 10) : 0;
  } catch {
    return 0;
  }
}

/**
 * Increment the D1 write counter.
 * Called after each batch of D1 writes.
 *
 * @param env - Worker environment
 * @param count - Number of writes to add
 */
export async function incrementD1WriteCount(env: Env, count: number): Promise<void> {
  const current = await getD1WriteCount(env);
  const newCount = current + count;
  // TTL of 24 hours for automatic cleanup
  await env.PLATFORM_CACHE.put(CB_KEYS.D1_WRITES_24H, String(newCount), {
    expirationTtl: 86400,
  });
}

// =============================================================================
// DO GB-SECONDS TRACKING (per-project)
// =============================================================================

/**
 * Get the rolling 24h DO GB-seconds count for a project.
 *
 * @param env - Worker environment
 * @param project - Project identifier
 * @returns Current DO GB-seconds count
 */
export async function getDOGbSecondsCount(env: Env, project: string): Promise<number> {
  try {
    const countStr = await env.PLATFORM_CACHE.get(`${CB_KEYS.DO_GB_SECONDS_24H_PREFIX}${project}`);
    return countStr ? parseFloat(countStr) : 0;
  } catch {
    return 0;
  }
}

/**
 * Set the DO GB-seconds count for a project.
 * Called after collecting metrics for each project.
 *
 * @param env - Worker environment
 * @param project - Project identifier
 * @param gbSeconds - New GB-seconds value
 */
export async function setDOGbSecondsCount(
  env: Env,
  project: string,
  gbSeconds: number
): Promise<void> {
  // TTL of 24 hours for automatic cleanup
  await env.PLATFORM_CACHE.put(`${CB_KEYS.DO_GB_SECONDS_24H_PREFIX}${project}`, String(gbSeconds), {
    expirationTtl: 86400,
  });
}

/**
 * Get DO GB-seconds threshold for a project from usage_settings.
 * Falls back to global setting, then to default if not found.
 * Uses platform-settings module with KV caching.
 *
 * @param env - Worker environment
 * @param project - Project identifier
 * @returns DO GB-seconds threshold
 */
export async function getDOGbSecondsThreshold(env: Env, project: string): Promise<number> {
  return getProjectSetting(
    env,
    project,
    'do_gb_seconds_daily_limit',
    DEFAULT_PLATFORM_SETTINGS.doGbSecondsDailyLimit
  );
}

// =============================================================================
// CIRCUIT BREAKER EVENT LOGGING
// =============================================================================

/**
 * Log a circuit breaker event to D1 for audit trail.
 *
 * @param env - Worker environment
 * @param eventType - Type of event (trip, reset, sample_reduce, sample_restore)
 * @param service - Service/project name
 * @param reason - Human-readable reason for the event
 * @param d1Writes24h - Current D1 write count (optional)
 * @param samplingMode - Current sampling mode (optional)
 * @param previousSamplingMode - Previous sampling mode (optional)
 * @param doGbSeconds24h - Current DO GB-seconds count (optional)
 * @param d1Limit - D1 write limit threshold
 * @param doGbSecondsLimit - DO GB-seconds limit threshold
 */
export async function logCircuitBreakerEvent(
  env: Env,
  eventType: 'trip' | 'reset' | 'sample_reduce' | 'sample_restore',
  service: string,
  reason: string,
  d1Writes24h?: number,
  samplingMode?: string,
  previousSamplingMode?: string,
  doGbSeconds24h?: number,
  d1Limit: number = DEFAULT_PLATFORM_SETTINGS.d1WriteLimit,
  doGbSecondsLimit: number = DEFAULT_PLATFORM_SETTINGS.doGbSecondsDailyLimit
): Promise<void> {
  await env.PLATFORM_DB.prepare(
    `
    INSERT INTO circuit_breaker_logs (
      id, event_type, service, reason,
      d1_writes_24h, d1_limit, sampling_mode, previous_sampling_mode,
      do_gb_seconds_24h, do_gb_seconds_limit,
      alert_sent, alert_channel
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  )
    .bind(
      generateId(),
      eventType,
      service,
      reason,
      d1Writes24h || null,
      d1Limit,
      samplingMode || null,
      previousSamplingMode || null,
      doGbSeconds24h || null,
      doGbSeconds24h ? doGbSecondsLimit : null,
      env.SLACK_WEBHOOK_URL ? 1 : 0,
      env.SLACK_WEBHOOK_URL ? 'slack' : null
    )
    .run();
}

// =============================================================================
// SLACK ALERTING
// =============================================================================

/**
 * Slack alert payload structure.
 */
export interface SlackAlertPayload {
  text: string;
  attachments?: Array<{
    color: string;
    fields: Array<{ title: string; value: string; short?: boolean }>;
  }>;
}

/**
 * Send a Slack alert via webhook.
 *
 * @param env - Worker environment
 * @param payload - Slack message payload
 */
export async function sendSlackAlert(env: Env, payload: SlackAlertPayload): Promise<void> {
  if (!env.SLACK_WEBHOOK_URL) return;

  try {
    await fetchWithRetry(env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:slack');
    log.error('Failed to send Slack alert', error instanceof Error ? error : undefined, {
      tag: 'SLACK_ERROR',
    });
  }
}

// =============================================================================
// DASHBOARD NOTIFICATIONS
// =============================================================================

/**
 * Notification payload for the platform-notifications API.
 */
interface NotificationPayload {
  category: 'error' | 'warning' | 'info' | 'success';
  source: string;
  source_id?: string;
  title: string;
  description?: string;
  priority: 'critical' | 'high' | 'medium' | 'low' | 'info';
  action_url?: string;
  action_label?: string;
  project?: string | null;
}

/**
 * Create a dashboard notification via the platform-notifications API.
 *
 * @param api - The NOTIFICATIONS_API fetcher binding
 * @param payload - Notification data
 */
async function createDashboardNotification(
  api: Fetcher | undefined,
  payload: NotificationPayload
): Promise<void> {
  if (!api) return;

  try {
    // Service binding URL — the hostname is ignored; only the path matters
    await api.fetch('https://platform-notifications.internal/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    // Silently fail - notifications are non-critical
    console.error('Failed to create dashboard notification:', error);
  }
}

// =============================================================================
// PROJECT CB KEY HELPER
// =============================================================================

/**
 * Get circuit breaker KV keys for all registered projects.
 * Queries project_registry in D1 and generates CB key names.
 *
 * TODO: Ensure your projects are registered in project_registry.
 * CB key format: PROJECT:{PROJECT_ID_UPPERCASE}:STATUS
 *
 * @param env - Worker environment
 * @returns Record mapping project ID to its CB KV key
 */
async function getProjectCBKeys(env: Env): Promise<Record<string, string>> {
  try {
    const rows = await env.PLATFORM_DB.prepare(
      `SELECT project_id FROM project_registry WHERE project_id != 'all' LIMIT 50`
    ).all<{ project_id: string }>();

    const keys: Record<string, string> = {};
    for (const row of rows.results ?? []) {
      keys[row.project_id] = `PROJECT:${row.project_id.toUpperCase().replace(/-/g, '-')}:STATUS`;
    }

    // Always include 'platform' as a fallback
    if (!keys['platform']) {
      keys['platform'] = 'PROJECT:PLATFORM:STATUS';
    }

    return keys;
  } catch {
    // Fallback if project_registry doesn't exist yet
    return {
      platform: 'PROJECT:PLATFORM:STATUS',
    };
  }
}

// =============================================================================
// PROJECT-LEVEL CIRCUIT BREAKER CHECKING
// =============================================================================

/**
 * Check and update circuit breakers for all registered projects based on usage limits.
 *
 * Tiered approach (HARD_LIMIT_MULTIPLIER = 1.5):
 * - CLOSED (active): usage < limit - normal operation
 * - WARNING: usage >= limit but < limit*1.5 - requests pass with warning logged
 * - OPEN (paused): usage >= limit*1.5 - requests blocked with 503
 *
 * This allows background jobs to complete even when slightly over budget,
 * while still alerting operators.
 *
 * @param env - Worker environment
 * @returns True if any circuit breaker was tripped
 */
export async function checkAndTripCircuitBreakers(env: Env): Promise<boolean> {
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:circuitbreaker');
  let tripped = false;

  // Fetch settings and D1 writes in parallel
  const [settings, writes24h] = await Promise.all([getPlatformSettings(env), getD1WriteCount(env)]);
  const d1WriteLimit = settings.d1WriteLimit;

  // Check D1 write limit (global)
  const d1Status = determineCircuitBreakerStatus(writes24h, d1WriteLimit);
  const hardLimit = d1WriteLimit * HARD_LIMIT_MULTIPLIER;

  if (d1Status === CB_STATUS.OPEN) {
    // OPEN: Hard limit exceeded - block all requests
    log.info('D1 writes exceeded HARD limit, setting status to OPEN (paused)', {
      tag: 'CB_OPEN',
      writes24h,
      hardLimit,
    });

    // Set OPEN status for all registered projects (24h expiry)
    // TODO: Add your project IDs to project_registry in D1
    const projectCBKeys = await getProjectCBKeys(env);
    for (const cbKey of Object.values(projectCBKeys)) {
      await env.PLATFORM_CACHE.put(cbKey, CB_STATUS.OPEN, { expirationTtl: 86400 });
    }

    // Log the event
    await logCircuitBreakerEvent(
      env,
      'trip',
      'all',
      `D1 writes exceeded hard limit ${hardLimit.toLocaleString()} (1.5x soft limit)`,
      writes24h,
      undefined, // samplingMode
      undefined, // previousSamplingMode
      undefined, // doGbSeconds24h
      d1WriteLimit
    );

    // Send Slack alert for OPEN
    if (env.SLACK_WEBHOOK_URL) {
      const projectNames = Object.keys(projectCBKeys).join(', ');
      await sendSlackAlert(env, {
        text: ':rotating_light: Circuit Breaker OPEN - Requests Blocked',
        attachments: [
          {
            color: 'danger',
            fields: [
              { title: 'Event', value: 'D1 write HARD limit exceeded', short: true },
              { title: 'Writes (24h)', value: writes24h.toLocaleString(), short: true },
              { title: 'Soft Limit', value: d1WriteLimit.toLocaleString(), short: true },
              { title: 'Hard Limit (1.5x)', value: hardLimit.toLocaleString(), short: true },
              { title: 'Status', value: 'OPEN (paused)', short: true },
              { title: 'Action', value: `Projects blocked for 24h: ${projectNames}`, short: true },
            ],
          },
        ],
      });
    }

    // Create dashboard notification for OPEN state
    await createDashboardNotification(env.NOTIFICATIONS_API, {
      category: 'error',
      source: 'circuit-breaker',
      title: 'Circuit Breaker OPEN - All Requests Blocked',
      description: `D1 writes (${writes24h.toLocaleString()}) exceeded hard limit (${hardLimit.toLocaleString()}). All projects blocked for 24h.`,
      priority: 'critical',
      action_url: '/circuit-breakers',
      action_label: 'View Status',
      project: 'platform',
    });

    tripped = true;
  } else if (d1Status === CB_STATUS.WARNING) {
    // WARNING: Soft limit exceeded - allow requests but log warning
    log.info('D1 writes exceeded soft limit, setting status to WARNING', {
      tag: 'CB_WARNING',
      writes24h,
      softLimit: d1WriteLimit,
    });

    // Set WARNING status for all registered projects (24h expiry)
    const projectCBKeysWarn = await getProjectCBKeys(env);
    for (const cbKey of Object.values(projectCBKeysWarn)) {
      await env.PLATFORM_CACHE.put(cbKey, CB_STATUS.WARNING, { expirationTtl: 86400 });
    }

    // Log the event as 'warning' (not 'trip')
    await logCircuitBreakerEvent(
      env,
      'sample_reduce', // Reusing for warning events
      'all',
      `D1 writes exceeded soft limit ${d1WriteLimit.toLocaleString()}`,
      writes24h,
      'warning',
      undefined, // previousSamplingMode
      undefined, // doGbSeconds24h
      d1WriteLimit
    );

    // Send Slack alert for WARNING
    if (env.SLACK_WEBHOOK_URL) {
      await sendSlackAlert(env, {
        text: ':warning: Circuit Breaker WARNING - Budget Exceeded',
        attachments: [
          {
            color: 'warning',
            fields: [
              { title: 'Event', value: 'D1 write soft limit exceeded', short: true },
              { title: 'Writes (24h)', value: writes24h.toLocaleString(), short: true },
              { title: 'Soft Limit', value: d1WriteLimit.toLocaleString(), short: true },
              { title: 'Hard Limit (1.5x)', value: hardLimit.toLocaleString(), short: true },
              { title: 'Status', value: 'WARNING (requests allowed)', short: true },
              { title: 'Action', value: 'Monitoring - will block at hard limit', short: true },
            ],
          },
        ],
      });
    }

    // Create dashboard notification for WARNING state
    await createDashboardNotification(env.NOTIFICATIONS_API, {
      category: 'warning',
      source: 'circuit-breaker',
      title: 'Circuit Breaker WARNING - Budget Exceeded',
      description: `D1 writes (${writes24h.toLocaleString()}) exceeded soft limit (${d1WriteLimit.toLocaleString()}). Will block at ${hardLimit.toLocaleString()}.`,
      priority: 'high',
      action_url: '/circuit-breakers',
      action_label: 'View Status',
      project: 'platform',
    });
  } else {
    // CLOSED: Under limit - ensure status is reset to active
    const projectCBKeysClosed = await getProjectCBKeys(env);
    for (const cbKey of Object.values(projectCBKeysClosed)) {
      await env.PLATFORM_CACHE.put(cbKey, CB_STATUS.CLOSED, { expirationTtl: 86400 });
    }
  }

  // Check DO GB-seconds per project
  // Uses the same dynamic project CB keys from project_registry
  const projectStatusKeys = await getProjectCBKeys(env);

  for (const [project, statusKey] of Object.entries(projectStatusKeys)) {
    const gbSeconds24h = await getDOGbSecondsCount(env, project);
    const threshold = await getDOGbSecondsThreshold(env, project);
    const doStatus = determineCircuitBreakerStatus(gbSeconds24h, threshold);
    const doHardLimit = threshold * HARD_LIMIT_MULTIPLIER;

    if (doStatus === CB_STATUS.OPEN) {
      // OPEN: Hard limit exceeded - block requests
      log.info('DO GB-seconds exceeded HARD limit, setting status to OPEN', {
        tag: 'CB_DO_OPEN',
        project,
        gbSeconds24h: Math.round(gbSeconds24h),
        hardLimit: Math.round(doHardLimit),
      });

      await env.PLATFORM_CACHE.put(statusKey, CB_STATUS.OPEN, { expirationTtl: 86400 });

      await logCircuitBreakerEvent(
        env,
        'trip',
        project,
        `DO GB-seconds exceeded hard limit ${doHardLimit.toFixed(0)} (1.5x soft limit)`,
        undefined, // d1Writes24h
        undefined, // samplingMode
        undefined, // previousSamplingMode
        gbSeconds24h,
        d1WriteLimit,
        threshold
      );

      if (env.SLACK_WEBHOOK_URL) {
        const estimatedCost = (gbSeconds24h / 1_000_000) * 12.5;
        await sendSlackAlert(env, {
          text: ':rotating_light: DO Circuit Breaker OPEN',
          attachments: [
            {
              color: 'danger',
              fields: [
                { title: 'Project', value: project, short: true },
                { title: 'Event', value: 'DO GB-seconds HARD limit exceeded', short: true },
                {
                  title: 'GB-seconds (24h)',
                  value: gbSeconds24h.toLocaleString(undefined, { maximumFractionDigits: 0 }),
                  short: true,
                },
                {
                  title: 'Soft Limit',
                  value: threshold.toLocaleString(undefined, { maximumFractionDigits: 0 }),
                  short: true,
                },
                {
                  title: 'Hard Limit (1.5x)',
                  value: doHardLimit.toLocaleString(undefined, { maximumFractionDigits: 0 }),
                  short: true,
                },
                {
                  title: 'Est. Cost',
                  value: `$${estimatedCost.toFixed(2)}`,
                  short: true,
                },
                { title: 'Status', value: 'OPEN (paused)', short: true },
                { title: 'Action', value: `${project} blocked for 24h`, short: true },
              ],
            },
          ],
        });
      }

      // Create dashboard notification for DO OPEN state
      const estimatedCostOpen = (gbSeconds24h / 1_000_000) * 12.5;
      await createDashboardNotification(env.NOTIFICATIONS_API, {
        category: 'error',
        source: 'circuit-breaker',
        title: `Circuit Breaker OPEN - ${project} Blocked`,
        description: `DO GB-seconds (${Math.round(gbSeconds24h).toLocaleString()}) exceeded hard limit. Est. cost: $${estimatedCostOpen.toFixed(2)}`,
        priority: 'critical',
        action_url: '/circuit-breakers',
        action_label: 'View Status',
        project,
      });

      tripped = true;
    } else if (doStatus === CB_STATUS.WARNING) {
      // WARNING: Soft limit exceeded - allow with logging
      log.info('DO GB-seconds exceeded soft limit, setting status to WARNING', {
        tag: 'CB_DO_WARNING',
        project,
        gbSeconds24h: Math.round(gbSeconds24h),
        softLimit: threshold,
      });

      await env.PLATFORM_CACHE.put(statusKey, CB_STATUS.WARNING, { expirationTtl: 86400 });

      await logCircuitBreakerEvent(
        env,
        'sample_reduce',
        project,
        `DO GB-seconds exceeded soft limit ${threshold.toFixed(0)}`,
        undefined, // d1Writes24h
        'warning', // samplingMode
        undefined, // previousSamplingMode
        gbSeconds24h,
        d1WriteLimit,
        threshold
      );

      if (env.SLACK_WEBHOOK_URL) {
        const estimatedCost = (gbSeconds24h / 1_000_000) * 12.5;
        await sendSlackAlert(env, {
          text: ':warning: DO Circuit Breaker WARNING',
          attachments: [
            {
              color: 'warning',
              fields: [
                { title: 'Project', value: project, short: true },
                { title: 'Event', value: 'DO GB-seconds soft limit exceeded', short: true },
                {
                  title: 'GB-seconds (24h)',
                  value: gbSeconds24h.toLocaleString(undefined, { maximumFractionDigits: 0 }),
                  short: true,
                },
                {
                  title: 'Soft Limit',
                  value: threshold.toLocaleString(undefined, { maximumFractionDigits: 0 }),
                  short: true,
                },
                {
                  title: 'Hard Limit (1.5x)',
                  value: doHardLimit.toLocaleString(undefined, { maximumFractionDigits: 0 }),
                  short: true,
                },
                {
                  title: 'Est. Cost',
                  value: `$${estimatedCost.toFixed(2)}`,
                  short: true,
                },
                { title: 'Status', value: 'WARNING (requests allowed)', short: true },
                { title: 'Action', value: 'Monitoring - will block at hard limit', short: true },
              ],
            },
          ],
        });
      }

      // Create dashboard notification for DO WARNING state
      const estimatedCostWarning = (gbSeconds24h / 1_000_000) * 12.5;
      await createDashboardNotification(env.NOTIFICATIONS_API, {
        category: 'warning',
        source: 'circuit-breaker',
        title: `Circuit Breaker WARNING - ${project} Budget Exceeded`,
        description: `DO GB-seconds (${Math.round(gbSeconds24h).toLocaleString()}) exceeded soft limit. Est. cost: $${estimatedCostWarning.toFixed(2)}`,
        priority: 'high',
        action_url: '/circuit-breakers',
        action_label: 'View Status',
        project,
      });
    } else {
      // CLOSED: Under limit - reset to active
      await env.PLATFORM_CACHE.put(statusKey, CB_STATUS.CLOSED, { expirationTtl: 86400 });
    }
  }

  return tripped;
}

// =============================================================================
// FEATURE-LEVEL BUDGET CHECKING
// =============================================================================

/**
 * Check if any metrics exceed budget limits and update status.
 * Reads budget from CONFIG:FEATURE:{key}:BUDGET, writes to CONFIG:FEATURE:{key}:STATUS.
 *
 * This is called during queue processing for each telemetry message to enforce
 * feature-level circuit breakers based on configured budgets.
 *
 * @param featureKey - Feature identifier (e.g., 'my-app:scanner:harvest')
 * @param metrics - Feature metrics from telemetry message
 * @param env - Worker environment
 */
export async function checkAndUpdateBudgetStatus(
  featureKey: string,
  metrics: FeatureMetrics,
  env: Env
): Promise<void> {
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:budget');
  const budgetKvKey = `CONFIG:FEATURE:${featureKey}:BUDGET`;
  const statusKey = `CONFIG:FEATURE:${featureKey}:STATUS`;

  try {
    const budgetJson = await env.PLATFORM_CACHE.get(budgetKvKey);
    if (!budgetJson) {
      // No budget configured for this feature - skip checking
      return;
    }

    const budget = JSON.parse(budgetJson) as DailyLimits;

    // Check each metric against budget
    const violations: string[] = [];
    const warnings: Array<{ metricKey: string; value: number; limit: number; percent: number }> = [];

    for (const [metricKey, value] of Object.entries(metrics)) {
      if (value === undefined || value === 0) continue;

      const budgetKey = METRIC_TO_BUDGET_KEY[metricKey as keyof typeof METRIC_TO_BUDGET_KEY];
      if (!budgetKey) continue;

      const rawLimit = budget[budgetKey];
      if (rawLimit === undefined) continue;
      // Defense-in-depth: YAML 1.2 may store "1_000" as string in KV.
      // Type says number but runtime may be string from JSON.parse of KV value.
      const rawLimitAny = rawLimit as unknown;
      const limit = typeof rawLimitAny === 'string' ? Number(rawLimitAny.replace(/_/g, '')) : Number(rawLimitAny);
      if (isNaN(limit) || limit === 0) continue;

      const numValue = value as number;
      if (numValue > limit) {
        violations.push(`${metricKey}=${value}>${limit}`);
      } else {
        const percent = (numValue / limit) * 100;
        if (percent >= 70) {
          warnings.push({ metricKey, value: numValue, limit, percent });
        }
      }
    }

    // Send warnings for metrics approaching budget limits (70% and 90%)
    for (const warn of warnings) {
      const threshold = warn.percent >= 90 ? 90 : 70;
      const dedupKey = `BUDGET_WARN:${featureKey}:${warn.metricKey}:${threshold}`;
      try {
        const alreadySent = await env.PLATFORM_CACHE.get(dedupKey);
        if (!alreadySent) {
          await env.PLATFORM_CACHE.put(dedupKey, '1', { expirationTtl: 3600 });
          const [project, ...featureParts] = featureKey.split(':');
          const featureName = featureParts.join(':') || featureKey;
          await sendSlackAlert(env, {
            text: `:warning: Feature Budget Warning (${threshold}%)`,
            attachments: [{
              color: threshold >= 90 ? '#ff9800' : '#ffc107',
              fields: [
                { title: 'Feature', value: `${featureName} (${featureKey})`, short: false },
                { title: 'Project', value: project, short: true },
                { title: 'Metric', value: warn.metricKey, short: true },
                {
                  title: 'Usage',
                  value: `${warn.percent.toFixed(0)}% (${warn.value.toLocaleString()} / ${warn.limit.toLocaleString()})`,
                  short: false,
                },
              ],
            }],
          });
        }
      } catch (warnError) {
        log.error(`Failed to send budget warning for ${featureKey}`, warnError);
      }
    }

    if (violations.length > 0) {
      const reason = violations.join(', ');
      const trippedAt = new Date().toISOString();

      // Trip the circuit breaker in KV
      await env.PLATFORM_CACHE.put(statusKey, 'STOP', {
        metadata: { reason, trippedAt },
        expirationTtl: 3600,
      });

      // Log to D1 for historical tracking
      // Parse the first violation to extract details (format: "metricKey=value>limit")
      const firstViolation = violations[0];
      const match = firstViolation.match(/^(\w+)=(\d+(?:\.\d+)?)>(\d+(?:\.\d+)?)$/);
      const violatedResource = match?.[1] ?? null;
      const currentValue = match ? parseFloat(match[2]) : null;
      const budgetLimit = match ? parseFloat(match[3]) : null;

      // Send Slack alert for feature-level circuit breaker trip
      let alertSent = 0;
      if (env.SLACK_WEBHOOK_URL) {
        try {
          // Parse feature key to extract project and feature name
          const [project, ...featureParts] = featureKey.split(':');
          const featureName = featureParts.join(':') || featureKey;

          await sendSlackAlert(env, {
            text: `:zap: Feature Circuit Breaker Tripped`,
            attachments: [
              {
                color: 'danger',
                fields: [
                  { title: 'Feature', value: featureKey, short: false },
                  { title: 'Project', value: project, short: true },
                  { title: 'Status', value: 'STOP (blocked)', short: true },
                  { title: 'Violation', value: reason, short: false },
                  {
                    title: 'Violated Resource',
                    value: violatedResource ?? 'unknown',
                    short: true,
                  },
                  {
                    title: 'Current / Limit',
                    value: `${currentValue?.toLocaleString() ?? '?'} / ${budgetLimit?.toLocaleString() ?? '?'}`,
                    short: true,
                  },
                  { title: 'Time', value: trippedAt, short: false },
                ],
              },
            ],
          });
          alertSent = 1;
        } catch (slackError) {
          log.error(`Failed to send Slack alert for ${featureKey}`, slackError);
        }
      }

      // Log to D1 for historical tracking
      try {
        await env.PLATFORM_DB.prepare(
          `INSERT INTO feature_circuit_breaker_events
           (id, feature_key, event_type, reason, violated_resource, current_value, budget_limit, auto_reset, alert_sent, created_at)
           VALUES (?1, ?2, 'trip', ?3, ?4, ?5, ?6, 0, ?7, unixepoch())`
        )
          .bind(
            crypto.randomUUID(),
            featureKey,
            reason,
            violatedResource,
            currentValue,
            budgetLimit,
            alertSent
          )
          .run();
      } catch (d1Error) {
        // D1 logging failure should not prevent KV trip
        log.error(`Failed to log CB event to D1 for ${featureKey}`, d1Error);
      }

      log.warn(`${featureKey} exceeded: ${reason}`, { alertSent });
    }
  } catch (error) {
    // Budget check failures should not fail the telemetry write
    log.error(`Error checking ${featureKey}`, error);
  }
}

// =============================================================================
// MONTHLY BUDGET CHECK (runs at midnight UTC)
// =============================================================================

/**
 * Mapping from DailyLimits keys to daily_usage_rollups column names.
 * Only includes metrics available in the rollups table.
 */
const MONTHLY_METRIC_TO_COLUMN: Record<string, string> = {
  d1_writes: 'd1_rows_written',
  d1_rows_written: 'd1_rows_written',
  d1_rows_read: 'd1_rows_read',
  kv_reads: 'kv_reads',
  kv_writes: 'kv_writes',
  kv_deletes: 'kv_deletes',
  r2_class_a: 'r2_class_a_ops',
  r2_class_b: 'r2_class_b_ops',
  ai_requests: 'workersai_requests',
  ai_neurons: 'workersai_neurons',
  requests: 'workers_requests',
  queue_messages: 'queues_messages_produced',
  vectorize_queries: 'vectorize_queries',
  vectorize_inserts: 'vectorize_inserts',
};

/** Allowlist for safe column interpolation in SQL. */
const ALLOWED_MONTHLY_COLUMNS = new Set(Object.values(MONTHLY_METRIC_TO_COLUMN));

// TODO: Add your project IDs here (must match project_registry in D1)
const MONTHLY_PROJECTS = ['all', 'platform'] as const;

/**
 * Check monthly budget usage against limits.
 * Runs once daily at midnight. Sums daily_usage_rollups for the current calendar month
 * and compares against monthly limits stored in KV (BUDGET_MONTHLY keys).
 *
 * Falls back to daily limits × 30 if no explicit monthly limits are configured.
 *
 * @returns Number of monthly violations detected
 */
export async function checkMonthlyBudgets(env: Env): Promise<number> {
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:monthly-budget');
  let violations = 0;

  try {
    // List all features with monthly budgets via KV list
    const kvList = await env.PLATFORM_CACHE.list({ prefix: 'CONFIG:FEATURE:', limit: 1000 });

    // Collect feature keys that have BUDGET_MONTHLY entries
    const monthlyFeatures: Array<{ featureKey: string; limits: DailyLimits }> = [];
    for (const key of kvList.keys) {
      if (!key.name.endsWith(':BUDGET_MONTHLY')) continue;
      const featureKey = key.name
        .replace('CONFIG:FEATURE:', '')
        .replace(':BUDGET_MONTHLY', '');
      const limitsJson = await env.PLATFORM_CACHE.get(key.name);
      if (!limitsJson) continue;
      try {
        monthlyFeatures.push({ featureKey, limits: JSON.parse(limitsJson) as DailyLimits });
      } catch {
        log.error(`Invalid monthly budget JSON for ${featureKey}`);
      }
    }

    if (monthlyFeatures.length === 0) {
      log.info('No features with monthly budgets configured');
      return 0;
    }

    // For each project, get monthly totals from daily_usage_rollups
    for (const project of MONTHLY_PROJECTS) {
      // Get the monthly sum for this project
      const monthlyTotals = await env.PLATFORM_DB.prepare(`
        SELECT
          SUM(d1_rows_written) as d1_rows_written,
          SUM(d1_rows_read) as d1_rows_read,
          SUM(kv_reads) as kv_reads,
          SUM(kv_writes) as kv_writes,
          SUM(kv_deletes) as kv_deletes,
          SUM(r2_class_a_ops) as r2_class_a_ops,
          SUM(r2_class_b_ops) as r2_class_b_ops,
          SUM(workersai_requests) as workersai_requests,
          SUM(workersai_neurons) as workersai_neurons,
          SUM(workers_requests) as workers_requests,
          SUM(queues_messages_produced) as queues_messages_produced,
          SUM(vectorize_queries) as vectorize_queries,
          SUM(vectorize_inserts) as vectorize_inserts
        FROM daily_usage_rollups
        WHERE project = ? AND snapshot_date >= date('now', 'start of month')
        LIMIT 1
      `).bind(project).first<Record<string, number | null>>();

      if (!monthlyTotals) continue;

      // Check each feature that maps to this project
      for (const { featureKey, limits } of monthlyFeatures) {
        const [featureProject] = featureKey.split(':');
        // Only check features belonging to this project (or 'all' catches everything)
        if (project !== 'all' && featureProject !== project) continue;
        if (project === 'all' && featureProject !== 'all' && featureProject !== 'platform') continue;

        for (const [limitKey, rawLimitValue] of Object.entries(limits)) {
          if (rawLimitValue === undefined || rawLimitValue === 0) continue;
          const column = MONTHLY_METRIC_TO_COLUMN[limitKey];
          if (!column || !ALLOWED_MONTHLY_COLUMNS.has(column)) continue;

          // Defense-in-depth: YAML 1.2 may store "1_000_000" as string in KV.
          // Type says number but runtime may be string from JSON.parse of KV value.
          const rawAny = rawLimitValue as unknown;
          const limitValue = typeof rawAny === 'string'
            ? Number(rawAny.replace(/_/g, ''))
            : Number(rawAny);
          if (isNaN(limitValue) || limitValue === 0) continue;

          const currentValue = monthlyTotals[column] ?? 0;
          if (currentValue === 0) continue;

          const percent = (currentValue / limitValue) * 100;

          if (currentValue > limitValue) {
            // Monthly budget exceeded — alert
            violations++;
            const dedupKey = `BUDGET_WARN_MONTHLY:${featureKey}:${limitKey}:exceeded`;
            const alreadySent = await env.PLATFORM_CACHE.get(dedupKey);
            if (!alreadySent) {
              await env.PLATFORM_CACHE.put(dedupKey, '1', { expirationTtl: 86400 }); // 24hr dedup
              await sendSlackAlert(env, {
                text: `:rotating_light: Monthly Budget Exceeded`,
                attachments: [{
                  color: '#e53e3e',
                  fields: [
                    { title: 'Feature', value: featureKey, short: false },
                    { title: 'Project', value: project, short: true },
                    { title: 'Metric', value: limitKey, short: true },
                    {
                      title: 'Monthly Usage',
                      value: `${percent.toFixed(0)}% (${currentValue.toLocaleString()} / ${limitValue.toLocaleString()})`,
                      short: false,
                    },
                    { title: 'Period', value: `${new Date().toISOString().slice(0, 7)} (month to date)`, short: false },
                  ],
                }],
              });
            }
          } else if (percent >= 70) {
            // Monthly warning threshold
            const threshold = percent >= 90 ? 90 : 70;
            const dedupKey = `BUDGET_WARN_MONTHLY:${featureKey}:${limitKey}:${threshold}`;
            const alreadySent = await env.PLATFORM_CACHE.get(dedupKey);
            if (!alreadySent) {
              await env.PLATFORM_CACHE.put(dedupKey, '1', { expirationTtl: 86400 }); // 24hr dedup
              await sendSlackAlert(env, {
                text: `:warning: Monthly Budget Warning (${threshold}%)`,
                attachments: [{
                  color: threshold >= 90 ? '#ff9800' : '#ffc107',
                  fields: [
                    { title: 'Feature', value: featureKey, short: false },
                    { title: 'Project', value: project, short: true },
                    { title: 'Metric', value: limitKey, short: true },
                    {
                      title: 'Monthly Usage',
                      value: `${percent.toFixed(0)}% (${currentValue.toLocaleString()} / ${limitValue.toLocaleString()})`,
                      short: false,
                    },
                    { title: 'Period', value: `${new Date().toISOString().slice(0, 7)} (month to date)`, short: false },
                  ],
                }],
              });
            }
          }
        }
      }
    }

    log.info(`Monthly budget check complete`, { violations, featuresChecked: monthlyFeatures.length });
  } catch (error) {
    log.error('Monthly budget check failed', error instanceof Error ? error : new Error(String(error)));
  }

  return violations;
}

// =============================================================================
// RE-EXPORTS
// =============================================================================

// Re-export CB_STATUS and CircuitBreakerStatusValue for convenience
export { CB_STATUS, type CircuitBreakerStatusValue } from '../../circuit-breaker-middleware';
export { HARD_LIMIT_MULTIPLIER };
