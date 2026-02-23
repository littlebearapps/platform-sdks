/**
 * BCU (Budget Consumption Unit) Cost Allocator
 *
 * Provides scarcity-weighted quota enforcement for intelligent degradation.
 * BCU normalises different resource types into a single unit for budget comparison.
 *
 * Key difference from costs.ts:
 * - costs.ts: Financial reporting (actual USD costs)
 * - economics.ts: Scarcity-weighted quota enforcement (relative resource pressure)
 *
 * BCU weights reflect scarcity and impact, not just cost:
 * - AI neurons are expensive AND scarce (weight: 100)
 * - D1 writes have durability implications (weight: 10)
 * - KV writes are moderately constrained (weight: 1)
 * - Requests are abundant but need tracking (weight: 0.001)
 */

import type { FeatureMetrics } from '@littlebearapps/platform-consumer-sdk';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Resource type for BCU calculation.
 */
export type ResourceType =
  | 'aiNeurons'
  | 'aiRequests'
  | 'd1Writes'
  | 'd1Reads'
  | 'd1RowsWritten'
  | 'd1RowsRead'
  | 'kvWrites'
  | 'kvReads'
  | 'kvDeletes'
  | 'kvLists'
  | 'r2ClassA'
  | 'r2ClassB'
  | 'doRequests'
  | 'doGbSeconds'
  | 'queueMessages'
  | 'vectorizeQueries'
  | 'vectorizeInserts'
  | 'workflowInvocations'
  | 'requests'
  | 'cpuMs';

/**
 * BCU weights per resource type.
 */
export type BCUWeights = Record<ResourceType, number>;

/**
 * Result of BCU calculation.
 */
export interface BCUResult {
  /** Total BCU value */
  total: number;
  /** Breakdown by resource type */
  breakdown: Partial<Record<ResourceType, number>>;
  /** Dominant resource (highest BCU contribution) */
  dominantResource: ResourceType | null;
  /** Percentage contribution of dominant resource */
  dominantPercentage: number;
}

/**
 * Budget state with BCU tracking.
 */
export interface BCUBudgetState {
  /** Current period BCU consumption */
  currentBCU: number;
  /** Budget limit in BCU */
  limitBCU: number;
  /** Utilisation ratio (0.0-1.0+) */
  utilisation: number;
  /** Whether budget is exceeded */
  exceeded: boolean;
}

// =============================================================================
// SCARCITY WEIGHTS
// =============================================================================

/**
 * Default BCU weights reflecting resource scarcity and impact.
 *
 * Philosophy:
 * - Expensive resources that are hard to scale get high weights
 * - Cheap, abundant resources get low weights
 * - Writes are weighted higher than reads (durability implications)
 *
 * TODO: Adjust these weights based on your specific scarcity constraints.
 */
export const DEFAULT_BCU_WEIGHTS: BCUWeights = {
  // AI Resources - Most expensive and scarce
  aiNeurons: 100, // $0.011 per 1K neurons, compute-intensive
  aiRequests: 50, // Each AI call is significant

  // D1 Database - Writes are expensive, reads are cheap
  d1Writes: 10, // Deprecated field (use d1RowsWritten)
  d1Reads: 0.01, // Deprecated field (use d1RowsRead)
  d1RowsWritten: 10, // $1.00 per million, durability critical
  d1RowsRead: 0.01, // $0.001 per billion, cheap

  // KV - Writes constrained, reads abundant
  kvWrites: 1, // $5.00 per million
  kvReads: 0.1, // $0.50 per million
  kvDeletes: 1, // Same cost as writes
  kvLists: 1, // Same cost as writes

  // R2 - Operations are relatively cheap
  r2ClassA: 0.5, // $4.50 per million (PUT, POST, LIST)
  r2ClassB: 0.05, // $0.36 per million (GET, HEAD)

  // Durable Objects - Request-based pricing
  doRequests: 0.5, // $0.15 per million
  doGbSeconds: 5, // $12.50 per million GB-seconds

  // Queues - Moderate pricing
  queueMessages: 0.5, // $0.40 per million

  // Vectorize - Query-intensive
  vectorizeQueries: 1, // $0.01 per million dimensions
  vectorizeInserts: 2, // Writes more expensive

  // Workflows - Still in beta
  workflowInvocations: 1, // Placeholder

  // General compute
  requests: 0.001, // Very cheap, 10M included
  cpuMs: 0.01, // $0.02 per million ms
};

// =============================================================================
// BCU CALCULATION
// =============================================================================

/**
 * Calculate BCU (Budget Consumption Units) from metrics.
 *
 * BCU provides a normalised measure of resource consumption that accounts
 * for scarcity, not just cost. This enables fair quota allocation across
 * features with different resource profiles.
 *
 * @param metrics - Feature metrics from telemetry
 * @param weights - BCU weights (defaults provided)
 * @returns BCU result with total, breakdown, and dominant resource
 *
 * @example
 * ```typescript
 * const metrics = { aiNeurons: 1000, d1RowsWritten: 100, requests: 50 };
 * const result = calculateBCU(metrics);
 * // result.total = 100000 + 1000 + 0.05 = 101000.05
 * // result.dominantResource = 'aiNeurons'
 * // result.dominantPercentage = 99.01
 * ```
 */
export function calculateBCU(
  metrics: FeatureMetrics,
  weights: BCUWeights = DEFAULT_BCU_WEIGHTS
): BCUResult {
  const breakdown: Partial<Record<ResourceType, number>> = {};
  let total = 0;
  let maxContribution = 0;
  let dominantResource: ResourceType | null = null;

  // Calculate BCU for each non-zero metric
  const metricEntries: [ResourceType, number | undefined][] = [
    ['aiNeurons', metrics.aiNeurons],
    ['aiRequests', metrics.aiRequests],
    ['d1Writes', metrics.d1Writes],
    ['d1Reads', metrics.d1Reads],
    ['d1RowsWritten', metrics.d1RowsWritten],
    ['d1RowsRead', metrics.d1RowsRead],
    ['kvWrites', metrics.kvWrites],
    ['kvReads', metrics.kvReads],
    ['kvDeletes', metrics.kvDeletes],
    ['kvLists', metrics.kvLists],
    ['r2ClassA', metrics.r2ClassA],
    ['r2ClassB', metrics.r2ClassB],
    ['doRequests', metrics.doRequests],
    // Note: doGbSeconds not in FeatureMetrics - omitted
    ['queueMessages', metrics.queueMessages],
    ['vectorizeQueries', metrics.vectorizeQueries],
    ['vectorizeInserts', metrics.vectorizeInserts],
    ['workflowInvocations', metrics.workflowInvocations],
    ['requests', metrics.requests],
    ['cpuMs', metrics.cpuMs],
  ];

  for (const [resource, value] of metricEntries) {
    if (value && value > 0) {
      const weight = weights[resource];
      const contribution = value * weight;
      breakdown[resource] = contribution;
      total += contribution;

      if (contribution > maxContribution) {
        maxContribution = contribution;
        dominantResource = resource;
      }
    }
  }

  const dominantPercentage = total > 0 ? (maxContribution / total) * 100 : 0;

  return {
    total,
    breakdown,
    dominantResource,
    dominantPercentage,
  };
}

/**
 * Calculate BCU from raw metric values (not FeatureMetrics object).
 * Useful when processing individual metric updates.
 */
export function calculateBCUForResource(
  resource: ResourceType,
  value: number,
  weights: BCUWeights = DEFAULT_BCU_WEIGHTS
): number {
  return value * weights[resource];
}

// =============================================================================
// BUDGET ENFORCEMENT
// =============================================================================

/**
 * Check BCU budget state for a feature.
 *
 * @param currentBCU - Current BCU consumption
 * @param limitBCU - Budget limit in BCU
 * @returns Budget state with utilisation info
 */
export function checkBCUBudget(currentBCU: number, limitBCU: number): BCUBudgetState {
  const utilisation = limitBCU > 0 ? currentBCU / limitBCU : 0;
  return {
    currentBCU,
    limitBCU,
    utilisation,
    exceeded: currentBCU > limitBCU,
  };
}

/**
 * Convert a USD budget to BCU budget.
 * Useful for setting feature budgets based on dollar allocations.
 *
 * This is an approximation based on the most common resource mix.
 * For precise conversion, you'd need the expected resource profile.
 *
 * @param usdBudget - Budget in USD
 * @returns Approximate BCU budget
 */
export function usdToBCU(usdBudget: number): number {
  // Approximation: assume average workload is 60% requests, 20% D1, 10% KV, 10% AI
  // Average BCU per dollar ~= $1 buys approximately 10000 BCU in this mix
  return usdBudget * 10000;
}

/**
 * Convert BCU to approximate USD.
 * Inverse of usdToBCU for reporting.
 */
export function bcuToUSD(bcu: number): number {
  return bcu / 10000;
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Get human-readable description of dominant resource.
 */
export function describeDominantResource(resource: ResourceType | null): string {
  if (!resource) return 'none';

  const descriptions: Record<ResourceType, string> = {
    aiNeurons: 'AI compute (neurons)',
    aiRequests: 'AI API calls',
    d1Writes: 'D1 writes (legacy)',
    d1Reads: 'D1 reads (legacy)',
    d1RowsWritten: 'D1 rows written',
    d1RowsRead: 'D1 rows read',
    kvWrites: 'KV writes',
    kvReads: 'KV reads',
    kvDeletes: 'KV deletes',
    kvLists: 'KV list operations',
    r2ClassA: 'R2 Class A ops',
    r2ClassB: 'R2 Class B ops',
    doRequests: 'Durable Object requests',
    doGbSeconds: 'Durable Object compute',
    queueMessages: 'Queue messages',
    vectorizeQueries: 'Vectorize queries',
    vectorizeInserts: 'Vectorize inserts',
    workflowInvocations: 'Workflow invocations',
    requests: 'HTTP requests',
    cpuMs: 'CPU time',
  };

  return descriptions[resource] || resource;
}

/**
 * Format BCU result for logging.
 */
export function formatBCUResult(result: BCUResult): string {
  const dominant = result.dominantResource
    ? `${describeDominantResource(result.dominantResource)} (${result.dominantPercentage.toFixed(1)}%)`
    : 'none';
  return `BCU: ${result.total.toFixed(2)}, dominant: ${dominant}`;
}

/**
 * Get resource-specific BCU breakdown for detailed reporting.
 */
export function getTopContributors(
  result: BCUResult,
  topN: number = 3
): { resource: ResourceType; bcu: number; percentage: number }[] {
  const entries = Object.entries(result.breakdown) as [ResourceType, number][];
  return entries
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([resource, bcu]) => ({
      resource,
      bcu,
      percentage: result.total > 0 ? (bcu / result.total) * 100 : 0,
    }));
}

/**
 * Combine BCU results from multiple metrics.
 */
export function combineBCUResults(results: BCUResult[]): BCUResult {
  const combined: Partial<Record<ResourceType, number>> = {};
  let total = 0;

  for (const result of results) {
    for (const [resource, value] of Object.entries(result.breakdown) as [ResourceType, number][]) {
      combined[resource] = (combined[resource] || 0) + value;
    }
    total += result.total;
  }

  // Find dominant resource in combined
  let maxContribution = 0;
  let dominantResource: ResourceType | null = null;
  for (const [resource, value] of Object.entries(combined) as [ResourceType, number][]) {
    if (value > maxContribution) {
      maxContribution = value;
      dominantResource = resource;
    }
  }

  return {
    total,
    breakdown: combined,
    dominantResource,
    dominantPercentage: total > 0 ? (maxContribution / total) * 100 : 0,
  };
}
