/**
 * Platform Settings Module
 *
 * Centralised configuration management for platform-wide thresholds,
 * circuit breakers, and resource limits.
 *
 * Caching Strategy:
 * 1. Check KV (PLATFORM_CACHE) first - 1 hour TTL
 * 2. If KV miss, query D1 (usage_settings table)
 * 3. If D1 miss, return default value
 * 4. On D1 hit, write to KV for next request
 *
 * Source of Truth:
 * - Git: platform/config/budgets.yaml
 * - Synced to D1 via scripts/sync-config.ts
 * - Cached in KV for runtime performance
 */

import type { KVNamespace, D1Database } from '@cloudflare/workers-types';

// =============================================================================
// TYPES
// =============================================================================

/**
 * All platform settings from D1 usage_settings table.
 * Centralised configuration for thresholds, circuit breakers, and sampling.
 */
export interface PlatformSettings {
  // Budget thresholds (USD)
  budgetSoftLimit: number;
  budgetWarningThreshold: number;
  budgetCriticalThreshold: number;

  // Alert/utilization thresholds (percentage)
  alertWarningPct: number;
  alertCriticalPct: number;
  utilizationWarningPct: number;
  utilizationCriticalPct: number;

  // Sampling thresholds (D1 usage ratio)
  samplingFullThreshold: number;
  samplingHalfThreshold: number;
  samplingQuarterThreshold: number;

  // Circuit breaker defaults
  cbAutoResetSeconds: number;
  cbCooldownSeconds: number;
  cbMaxConsecutiveTrips: number;

  // Error rate settings
  errorRateThreshold: number;
  errorRateWindowMinutes: number;
  errorRateMinRequests: number;

  // Resource limits (daily)
  d1WriteLimit: number;
  doGbSecondsDailyLimit: number;
}

/**
 * Environment bindings required for settings functions.
 */
export interface SettingsEnv {
  PLATFORM_CACHE: KVNamespace;
  PLATFORM_DB: D1Database;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Default platform settings (fallback if D1/KV query fails).
 * These MUST match the values in budgets.yaml defaults section.
 */
export const DEFAULT_PLATFORM_SETTINGS: PlatformSettings = {
  // Budget thresholds (USD)
  budgetSoftLimit: 25,
  budgetWarningThreshold: 20,
  budgetCriticalThreshold: 50,

  // Alert/utilization thresholds (percentage) - from budgets.yaml defaults.thresholds
  alertWarningPct: 70,
  alertCriticalPct: 90,
  utilizationWarningPct: 70,
  utilizationCriticalPct: 90,

  // Sampling thresholds (D1 usage ratio)
  samplingFullThreshold: 0.6,
  samplingHalfThreshold: 0.8,
  samplingQuarterThreshold: 0.9,

  // Circuit breaker defaults - from budgets.yaml defaults.circuit_breaker
  cbAutoResetSeconds: 3600,
  cbCooldownSeconds: 300,
  cbMaxConsecutiveTrips: 3,

  // Error rate settings - from budgets.yaml defaults.error_budget
  errorRateThreshold: 0.1,
  errorRateWindowMinutes: 15,
  errorRateMinRequests: 50,

  // Resource limits (daily)
  d1WriteLimit: 1_000_000, // 1M writes per 24h (adaptive sampling trigger)
  doGbSecondsDailyLimit: 200_000, // 200K GB-seconds per 24h (~$2.50/day)
};

/**
 * Mapping from D1 setting_key to PlatformSettings property.
 */
export const SETTING_KEY_MAP: Record<string, keyof PlatformSettings> = {
  budget_soft_limit: 'budgetSoftLimit',
  budget_warning_threshold: 'budgetWarningThreshold',
  budget_critical_threshold: 'budgetCriticalThreshold',
  alert_warning_pct: 'alertWarningPct',
  alert_critical_pct: 'alertCriticalPct',
  utilization_warning_pct: 'utilizationWarningPct',
  utilization_critical_pct: 'utilizationCriticalPct',
  sampling_full_threshold: 'samplingFullThreshold',
  sampling_half_threshold: 'samplingHalfThreshold',
  sampling_quarter_threshold: 'samplingQuarterThreshold',
  cb_auto_reset_seconds: 'cbAutoResetSeconds',
  cb_cooldown_seconds: 'cbCooldownSeconds',
  cb_max_consecutive_trips: 'cbMaxConsecutiveTrips',
  error_rate_threshold: 'errorRateThreshold',
  error_rate_window_minutes: 'errorRateWindowMinutes',
  error_rate_min_requests: 'errorRateMinRequests',
  d1_write_limit: 'd1WriteLimit',
  do_gb_seconds_daily_limit: 'doGbSecondsDailyLimit',
};

/**
 * Reverse mapping from PlatformSettings property to D1 setting_key.
 */
export const PROPERTY_TO_KEY_MAP: Record<keyof PlatformSettings, string> = Object.fromEntries(
  Object.entries(SETTING_KEY_MAP).map(([k, v]) => [v, k])
) as Record<keyof PlatformSettings, string>;

/**
 * KV key prefix for settings cache.
 */
const KV_SETTINGS_PREFIX = 'CONFIG:SETTINGS:';

/**
 * KV key for the full settings object cache.
 */
const KV_ALL_SETTINGS_KEY = 'CONFIG:SETTINGS:ALL';

/**
 * KV cache TTL in seconds (1 hour).
 */
const KV_CACHE_TTL_SECONDS = 3600;

// =============================================================================
// SINGLE SETTING GETTER
// =============================================================================

/**
 * Get a single platform setting with KV-first, D1-fallback caching.
 *
 * Lookup order:
 * 1. KV cache (CONFIG:SETTINGS:{key})
 * 2. D1 usage_settings table
 * 3. Default value
 *
 * On D1 hit, value is cached to KV with 1-hour TTL.
 *
 * @param env - Environment with PLATFORM_CACHE and PLATFORM_DB
 * @param key - Setting key (e.g., 'budget_soft_limit')
 * @param defaultValue - Fallback if not found in KV or D1
 * @returns The setting value, converted to the appropriate type
 */
export async function getSetting<T extends string | number | boolean>(
  env: SettingsEnv,
  key: string,
  defaultValue: T
): Promise<T> {
  const kvKey = `${KV_SETTINGS_PREFIX}${key}`;

  try {
    // 1. Check KV cache first
    const cached = await env.PLATFORM_CACHE.get(kvKey);
    if (cached !== null) {
      return parseValue(cached, defaultValue);
    }

    // 2. Query D1
    const result = await env.PLATFORM_DB.prepare(
      `SELECT setting_value FROM usage_settings WHERE project = 'all' AND setting_key = ?`
    )
      .bind(key)
      .first<{ setting_value: string }>();

    if (result?.setting_value !== undefined) {
      // 3. Cache to KV for next time
      await env.PLATFORM_CACHE.put(kvKey, result.setting_value, {
        expirationTtl: KV_CACHE_TTL_SECONDS,
      });
      return parseValue(result.setting_value, defaultValue);
    }

    // 4. Return default
    return defaultValue;
  } catch {
    // On error, return default silently (logging handled by caller)
    return defaultValue;
  }
}

/**
 * Parse a string value to the appropriate type based on the default value type.
 */
function parseValue<T extends string | number | boolean>(value: string, defaultValue: T): T {
  if (typeof defaultValue === 'number') {
    const parsed = parseFloat(value);
    return (isNaN(parsed) ? defaultValue : parsed) as T;
  }
  if (typeof defaultValue === 'boolean') {
    return (value === 'true' || value === '1') as unknown as T;
  }
  return value as T;
}

// =============================================================================
// FULL SETTINGS GETTER
// =============================================================================

/**
 * Get all platform settings with KV-first, D1-fallback caching.
 *
 * This fetches all settings in a single query rather than N+1 queries.
 * Use this when you need multiple settings in one operation.
 *
 * @param env - Environment with PLATFORM_CACHE and PLATFORM_DB
 * @returns Full PlatformSettings object
 */
export async function getPlatformSettings(env: SettingsEnv): Promise<PlatformSettings> {
  try {
    // 1. Check KV cache for full settings object
    const cached = await env.PLATFORM_CACHE.get(KV_ALL_SETTINGS_KEY);
    // Empty string means cache was invalidated by sync script - skip to D1
    if (cached !== null && cached !== '') {
      try {
        const parsed = JSON.parse(cached) as Partial<PlatformSettings>;
        // Merge with defaults to handle any missing keys
        return { ...DEFAULT_PLATFORM_SETTINGS, ...parsed };
      } catch {
        // Invalid JSON, fall through to D1
      }
    }

    // 2. Query all settings from D1
    const result = await env.PLATFORM_DB.prepare(
      `SELECT setting_key, setting_value FROM usage_settings WHERE project = 'all'`
    ).all<{ setting_key: string; setting_value: string }>();

    const settings = { ...DEFAULT_PLATFORM_SETTINGS };

    for (const row of result.results ?? []) {
      const prop = SETTING_KEY_MAP[row.setting_key];
      if (prop) {
        const value = parseFloat(row.setting_value);
        if (!isNaN(value)) {
          (settings as Record<string, number>)[prop] = value;
        }
      }
    }

    // 3. Cache full settings object to KV
    await env.PLATFORM_CACHE.put(KV_ALL_SETTINGS_KEY, JSON.stringify(settings), {
      expirationTtl: KV_CACHE_TTL_SECONDS,
    });

    return settings;
  } catch {
    // On error, return defaults
    return DEFAULT_PLATFORM_SETTINGS;
  }
}

// =============================================================================
// PROJECT-SPECIFIC SETTINGS
// =============================================================================

/**
 * Get a project-specific setting, falling back to global ('all') if not found.
 *
 * @param env - Environment with PLATFORM_CACHE and PLATFORM_DB
 * @param project - Project identifier
 * @param key - Setting key (e.g., 'do_gb_seconds_daily_limit')
 * @param defaultValue - Fallback if not found
 * @returns The setting value
 */
export async function getProjectSetting<T extends string | number | boolean>(
  env: SettingsEnv,
  project: string,
  key: string,
  defaultValue: T
): Promise<T> {
  const kvKey = `${KV_SETTINGS_PREFIX}${project}:${key}`;

  try {
    // 1. Check KV cache for project-specific value
    const cached = await env.PLATFORM_CACHE.get(kvKey);
    if (cached !== null) {
      return parseValue(cached, defaultValue);
    }

    // 2. Query D1 for project-specific value
    const projectResult = await env.PLATFORM_DB.prepare(
      `SELECT setting_value FROM usage_settings WHERE project = ? AND setting_key = ?`
    )
      .bind(project, key)
      .first<{ setting_value: string }>();

    if (projectResult?.setting_value !== undefined) {
      await env.PLATFORM_CACHE.put(kvKey, projectResult.setting_value, {
        expirationTtl: KV_CACHE_TTL_SECONDS,
      });
      return parseValue(projectResult.setting_value, defaultValue);
    }

    // 3. Fallback to global setting
    return getSetting(env, key, defaultValue);
  } catch {
    // On error, try global setting
    return getSetting(env, key, defaultValue);
  }
}

// =============================================================================
// CACHE INVALIDATION
// =============================================================================

/**
 * Invalidate settings cache for a specific key.
 * Call this after updating a setting in D1.
 */
export async function invalidateSettingCache(env: SettingsEnv, key: string): Promise<void> {
  await Promise.all([
    env.PLATFORM_CACHE.delete(`${KV_SETTINGS_PREFIX}${key}`),
    env.PLATFORM_CACHE.delete(KV_ALL_SETTINGS_KEY),
  ]);
}

/**
 * Invalidate all settings cache.
 * Call this after bulk updates to usage_settings.
 */
export async function invalidateAllSettingsCache(env: SettingsEnv): Promise<void> {
  // We can't easily list and delete all CONFIG:SETTINGS:* keys,
  // so we rely on TTL expiration for individual keys.
  // The full settings cache is deleted to force a refresh.
  await env.PLATFORM_CACHE.delete(KV_ALL_SETTINGS_KEY);
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Get utilization status based on percentage.
 * Uses thresholds from settings or defaults.
 */
export function getUtilizationStatus(
  pct: number,
  settings?: { warningPct: number; criticalPct: number }
): 'green' | 'yellow' | 'red' {
  const warning = settings?.warningPct ?? DEFAULT_PLATFORM_SETTINGS.utilizationWarningPct;
  const critical = settings?.criticalPct ?? DEFAULT_PLATFORM_SETTINGS.utilizationCriticalPct;
  if (pct < warning) return 'green';
  if (pct < critical) return 'yellow';
  return 'red';
}

/**
 * Expected setting keys that should exist in D1.
 * Used by /usage/settings/verify endpoint.
 */
export const EXPECTED_SETTINGS_KEYS = [
  // Budget thresholds (USD)
  'budget_soft_limit',
  'budget_warning_threshold',
  'budget_critical_threshold',
  // Alert thresholds (percentage)
  'alert_warning_pct',
  'alert_critical_pct',
  // Utilization thresholds (percentage)
  'utilization_warning_pct',
  'utilization_critical_pct',
  // Sampling thresholds (D1 usage ratio)
  'sampling_full_threshold',
  'sampling_half_threshold',
  'sampling_quarter_threshold',
  // Circuit breaker defaults
  'cb_auto_reset_seconds',
  'cb_cooldown_seconds',
  'cb_max_consecutive_trips',
  // Error rate settings
  'error_rate_threshold',
  'error_rate_window_minutes',
  'error_rate_min_requests',
  // Resource limits
  'd1_write_limit',
  'do_gb_seconds_daily_limit',
];
