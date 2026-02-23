/**
 * Cost Budget Enforcement
 *
 * Cost-based circuit breaker enforcement for platform-usage queue processing.
 * Implements rolling window cost accumulation and budget checking.
 *
 * Part of the real-time cost tracking feature for Platform SDK.
 *
 * Key Concepts:
 * - Cost budgets stored in KV: CONFIG:FEATURE:{key}:COST_BUDGET
 * - Accumulated costs stored in KV: STATE:COST:{key}:ACCUMULATED
 * - Status stored in KV: CONFIG:FEATURE:{key}:STATUS (same key as resource CB)
 */

import type { Env } from '../shared';
import { createLoggerFromEnv } from '@littlebearapps/platform-consumer-sdk';

/**
 * Cost budget configuration for a feature.
 * Stored in KV at CONFIG:FEATURE:{key}:COST_BUDGET.
 */
export interface CostBudgetConfig {
  /** Daily cost limit in USD */
  daily_limit_usd: number;
  /** Optional alert threshold percentage (e.g., 0.8 = 80%) */
  alert_threshold_pct?: number;
}

/**
 * Accumulated cost state stored in KV.
 */
interface AccumulatedCostState {
  /** Total cost accumulated in window */
  cost: number;
  /** Window start timestamp in milliseconds */
  windowStart: number;
}

/**
 * Check and update cost budget status for a feature.
 * Uses a rolling 24-hour window for cost accumulation.
 *
 * If total cost exceeds the configured daily limit, trips the circuit breaker
 * using the same STATUS key as resource-based circuit breakers.
 *
 * @param featureKey - Feature identifier (e.g., 'my-app:scanner:harvest')
 * @param costIncrement - Cost in USD to add to accumulator
 * @param env - Worker environment
 */
export async function checkAndUpdateCostBudgetStatus(
  featureKey: string,
  costIncrement: number,
  env: Env
): Promise<void> {
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:cost-budget');

  const budgetKey = `CONFIG:FEATURE:${featureKey}:COST_BUDGET`;
  const statusKey = `CONFIG:FEATURE:${featureKey}:STATUS`;
  const accumulatorKey = `STATE:COST:${featureKey}:ACCUMULATED`;

  try {
    // Check if cost budget is configured for this feature
    const budgetJson = await env.PLATFORM_CACHE.get(budgetKey);
    if (!budgetJson) {
      // No cost budget configured - skip checking
      return;
    }

    const budget = JSON.parse(budgetJson) as CostBudgetConfig;

    // Rolling 24-hour window
    const windowMs = 24 * 60 * 60 * 1000;
    const windowStart = Date.now() - windowMs;

    // Get current accumulated cost
    let totalCost = costIncrement;
    let existingWindowStart = Date.now();

    const stored = await env.PLATFORM_CACHE.get(accumulatorKey);
    if (stored) {
      const data = JSON.parse(stored) as AccumulatedCostState;
      // Only add to existing cost if within the same window
      if (data.windowStart > windowStart) {
        // Use fixed precision to prevent floating point accumulation errors
        totalCost = Number((data.cost + costIncrement).toFixed(6));
        existingWindowStart = data.windowStart;
      }
    }

    // Store updated cost with 25-hour TTL (allows for window overlap)
    // Round to 6 decimal places to prevent floating point run-on
    await env.PLATFORM_CACHE.put(
      accumulatorKey,
      JSON.stringify({ cost: Number(totalCost.toFixed(6)), windowStart: existingWindowStart }),
      { expirationTtl: 90000 } // 25 hours
    );

    // Check budget violation
    if (totalCost > budget.daily_limit_usd) {
      const reason = `cost_usd=${totalCost.toFixed(4)}>${budget.daily_limit_usd}`;

      // Trip the circuit breaker in KV
      await env.PLATFORM_CACHE.put(statusKey, 'STOP');

      // Log to D1 for historical tracking
      try {
        await env.PLATFORM_DB.prepare(
          `INSERT INTO feature_circuit_breaker_events
           (id, feature_key, event_type, reason, violated_resource, current_value, budget_limit, created_at)
           VALUES (?1, ?2, 'trip', ?3, 'cost_usd', ?4, ?5, unixepoch())`
        )
          .bind(crypto.randomUUID(), featureKey, reason, totalCost, budget.daily_limit_usd)
          .run();
      } catch (d1Error) {
        // D1 logging failure should not prevent KV trip
        log.error(`Failed to log cost CB event to D1 for ${featureKey}`, d1Error);
      }

      log.warn(`Cost CB tripped: ${featureKey}`, {
        totalCost: totalCost.toFixed(4),
        limit: budget.daily_limit_usd,
      });
    }
  } catch (error) {
    // Cost budget check failures should not fail the telemetry write
    log.error(`Cost budget check failed for ${featureKey}`, error);
  }
}
