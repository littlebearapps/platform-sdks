/**
 * Cost Calculator
 *
 * Calculates CF resource cost from telemetry metrics.
 * Uses pricing tiers from workers/lib/costs.ts for consistency.
 *
 * Part of the real-time cost tracking feature for Platform SDK.
 */

import type { FeatureMetrics } from '@littlebearapps/platform-consumer-sdk';
import { PRICING_TIERS } from '@littlebearapps/platform-consumer-sdk';

/**
 * Calculate CF resource cost from telemetry metrics.
 * Returns cost in USD based on current pricing tiers.
 *
 * @param metrics - Feature metrics from telemetry message
 * @returns Total cost in USD for CF resources
 */
export function calculateCFCostFromMetrics(metrics: FeatureMetrics): number {
  let cost = 0;

  // D1: $0.001/billion reads, $1.00/million writes
  if (metrics.d1RowsRead) {
    cost += (metrics.d1RowsRead / 1e9) * PRICING_TIERS.d1.rowsReadPerBillion;
  }
  if (metrics.d1RowsWritten) {
    cost += (metrics.d1RowsWritten / 1e6) * PRICING_TIERS.d1.rowsWrittenPerMillion;
  }

  // KV: $0.50/million reads, $5.00/million writes, $5.00/million deletes, $5.00/million lists
  if (metrics.kvReads) {
    cost += (metrics.kvReads / 1e6) * PRICING_TIERS.kv.readsPerMillion;
  }
  if (metrics.kvWrites) {
    cost += (metrics.kvWrites / 1e6) * PRICING_TIERS.kv.writesPerMillion;
  }
  if (metrics.kvDeletes) {
    cost += (metrics.kvDeletes / 1e6) * PRICING_TIERS.kv.deletesPerMillion;
  }
  if (metrics.kvLists) {
    cost += (metrics.kvLists / 1e6) * PRICING_TIERS.kv.listsPerMillion;
  }

  // R2: $4.50/million Class A, $0.36/million Class B
  if (metrics.r2ClassA) {
    cost += (metrics.r2ClassA / 1e6) * PRICING_TIERS.r2.classAPerMillion;
  }
  if (metrics.r2ClassB) {
    cost += (metrics.r2ClassB / 1e6) * PRICING_TIERS.r2.classBPerMillion;
  }

  // Workers AI: $0.011/1000 neurons
  if (metrics.aiNeurons) {
    cost += (metrics.aiNeurons / 1000) * PRICING_TIERS.workersAI.neuronsPerThousand;
  }

  // Durable Objects: $0.15/million requests, $12.50/million GB-seconds
  if (metrics.doRequests) {
    cost += (metrics.doRequests / 1e6) * PRICING_TIERS.durableObjects.requestsPerMillion;
  }
  if (metrics.doGbSeconds) {
    cost += (metrics.doGbSeconds / 1e6) * PRICING_TIERS.durableObjects.gbSecondsPerMillion;
  }

  // Vectorize: $0.01/million queried dimensions
  if (metrics.vectorizeQueries) {
    cost += (metrics.vectorizeQueries / 1e6) * PRICING_TIERS.vectorize.queriedDimensionsPerMillion;
  }

  // Queues: $0.40/million messages
  if (metrics.queueMessages) {
    cost += (metrics.queueMessages / 1e6) * PRICING_TIERS.queues.messagesPerMillion;
  }

  return cost;
}
