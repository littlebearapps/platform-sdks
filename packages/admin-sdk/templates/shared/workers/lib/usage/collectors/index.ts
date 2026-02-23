/**
 * External Billing Collectors
 *
 * Framework for collecting billing and usage data from external providers.
 * Each collector handles errors gracefully - one failure doesn't stop others.
 *
 * TODO: Add collectors for your external providers. See example.ts for a
 * collector template. Common providers include:
 * - GitHub: Org billing + Enterprise consumed licenses
 * - OpenAI: Organization usage (Admin API)
 * - Anthropic: Organization usage (Admin API)
 * - Stripe: Revenue and subscription data
 *
 * Metric types:
 * - FLOW metrics: Usage that accumulates (requests, tokens) - safe to SUM
 * - STOCK metrics: Point-in-time values (balance, quota) - do NOT SUM
 */

import type { Env } from '../shared';
import { createLoggerFromEnv } from '@littlebearapps/platform-consumer-sdk';

// =============================================================================
// COLLECTOR INTERFACE
// =============================================================================

/**
 * A single external metrics collector.
 *
 * Implement this interface for each external provider you want to track.
 */
export interface ExternalCollector<T> {
  /** Unique name for the collector (used in logs and error arrays) */
  name: string;
  /** Collect metrics from the external provider */
  collect: (env: Env) => Promise<T>;
  /** Default value to return on failure */
  defaultValue: T;
}

/**
 * Combined external metrics from all providers.
 *
 * TODO: Add your provider result types here.
 */
export interface ExternalMetrics {
  /** Results keyed by collector name */
  results: Record<string, unknown>;
  /** Collection timestamp */
  collectedAt: string;
  /** Providers that failed to collect */
  errors: string[];
}

// =============================================================================
// COLLECTOR REGISTRY
// =============================================================================

/**
 * Register your collectors here.
 *
 * TODO: Import and add your collector modules. Example:
 *
 *   import { githubCollector } from './github';
 *   import { openaiCollector } from './openai';
 *
 *   const COLLECTORS: ExternalCollector<unknown>[] = [
 *     githubCollector,
 *     openaiCollector,
 *   ];
 */
const COLLECTORS: ExternalCollector<unknown>[] = [
  // Add your collectors here
];

// =============================================================================
// UNIFIED COLLECTION
// =============================================================================

/**
 * Collect all external metrics in parallel.
 *
 * Each provider is collected independently - one failure doesn't affect others.
 * Failed providers are logged and recorded in the errors array.
 *
 * @param env - Worker environment with API keys
 * @returns Combined metrics from all providers
 */
export async function collectExternalMetrics(env: Env): Promise<ExternalMetrics> {
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:external');
  const errors: string[] = [];

  log.info('Starting external metrics collection', {
    collectorCount: COLLECTORS.length,
  });
  const startTime = Date.now();

  // Collect all providers in parallel
  const collectorResults = await Promise.all(
    COLLECTORS.map(async (collector) => {
      try {
        const result = await collector.collect(env);
        return { name: collector.name, result };
      } catch (e) {
        log.error(`${collector.name} collection failed`, e instanceof Error ? e : undefined);
        errors.push(collector.name);
        return { name: collector.name, result: collector.defaultValue };
      }
    })
  );

  const results: Record<string, unknown> = {};
  for (const { name, result } of collectorResults) {
    results[name] = result;
  }

  const duration = Date.now() - startTime;
  log.info('External metrics collection complete', {
    durationMs: duration,
    successCount: COLLECTORS.length - errors.length,
    failedProviders: errors.length > 0 ? errors.join(', ') : 'none',
  });

  return {
    results,
    collectedAt: new Date().toISOString(),
    errors,
  };
}
