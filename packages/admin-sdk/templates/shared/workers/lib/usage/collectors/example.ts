/**
 * Example External Billing Collector
 *
 * Template for creating a new external provider collector.
 * Copy this file and modify for your provider.
 *
 * Usage:
 * 1. Copy this file to ./your-provider.ts
 * 2. Implement the collect function
 * 3. Register in ./index.ts COLLECTORS array
 * 4. Add required API keys to your wrangler config
 */

import type { Env } from '../shared';
import type { ExternalCollector } from './index';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Result type for your provider's metrics.
 *
 * For FLOW metrics (usage that accumulates): requests, tokens, compute units
 * For STOCK metrics (point-in-time): balance remaining, quota remaining
 */
export interface ExampleUsageData {
  /** Total requests made this billing period */
  totalRequests: number;
  /** Total cost in USD this billing period */
  totalCostUsd: number;
  /** Billing period start date (ISO) */
  periodStart: string;
  /** Billing period end date (ISO) */
  periodEnd: string;
}

// =============================================================================
// COLLECTOR IMPLEMENTATION
// =============================================================================

/**
 * Collect usage data from your external provider.
 *
 * @param env - Worker environment (access API keys via env.YOUR_API_KEY)
 * @returns Usage data from the provider
 */
export async function collectExampleUsage(env: Env): Promise<ExampleUsageData | null> {
  // Check if API key is configured
  const apiKey = (env as Record<string, unknown>)['EXAMPLE_API_KEY'] as string | undefined;
  if (!apiKey) {
    return null; // Provider not configured, skip silently
  }

  const response = await fetch('https://api.example.com/v1/usage', {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Example API returned ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as {
    total_requests: number;
    total_cost: number;
    period_start: string;
    period_end: string;
  };

  return {
    totalRequests: data.total_requests,
    totalCostUsd: data.total_cost,
    periodStart: data.period_start,
    periodEnd: data.period_end,
  };
}

// =============================================================================
// COLLECTOR REGISTRATION
// =============================================================================

/**
 * Collector instance to register in ./index.ts COLLECTORS array.
 *
 * Example usage in index.ts:
 *   import { exampleCollector } from './example';
 *   const COLLECTORS = [exampleCollector];
 */
export const exampleCollector: ExternalCollector<ExampleUsageData | null> = {
  name: 'example',
  collect: collectExampleUsage,
  defaultValue: null,
};
