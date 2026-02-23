/// <reference types="@cloudflare/workers-types" />

/**
 * Reservoir Sampling for Latency Percentiles
 *
 * Implements Algorithm R for O(1) memory p99/p95 latency tracking.
 * Maintains a fixed-size sample that represents the distribution of all seen values.
 *
 * Key properties:
 * - O(1) memory: Fixed 100 samples (~800 bytes JSON)
 * - O(1) per-sample: Constant time to add each sample
 * - Unbiased: Each value has equal probability of being in the sample
 *
 * @see Vitter, J.S. (1985). "Random Sampling with a Reservoir"
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * Reservoir state stored in KV.
 * Key: STATE:RESERVOIR:{feature_id}
 */
export interface ReservoirState {
  /** Fixed-size array of sampled values */
  samples: number[];
  /** Total number of values seen (for Algorithm R probability) */
  totalSeen: number;
  /** Timestamp of last update */
  lastUpdate: number;
  /** Pre-computed percentiles (updated on retrieval) */
  percentiles?: PercentileResult;
}

/**
 * Computed percentile values.
 */
export interface PercentileResult {
  /** 50th percentile (median) */
  p50: number;
  /** 75th percentile */
  p75: number;
  /** 90th percentile */
  p90: number;
  /** 95th percentile */
  p95: number;
  /** 99th percentile */
  p99: number;
  /** Maximum value in sample */
  max: number;
  /** Minimum value in sample */
  min: number;
  /** Average of samples */
  avg: number;
  /** Sample count used for calculation */
  sampleCount: number;
  /** Total values seen (for context) */
  totalSeen: number;
}

/**
 * Configuration for reservoir sampling.
 */
export interface ReservoirConfig {
  /** Maximum number of samples to keep (default: 100) */
  maxSamples: number;
}

// =============================================================================
// DEFAULT CONFIGURATION
// =============================================================================

/**
 * Default reservoir configuration.
 * 100 samples provides good percentile estimates while keeping KV payload small.
 */
export const DEFAULT_RESERVOIR_CONFIG: ReservoirConfig = {
  maxSamples: 100,
};

/**
 * Create a fresh reservoir state.
 */
export function createReservoirState(): ReservoirState {
  return {
    samples: [],
    totalSeen: 0,
    lastUpdate: Date.now(),
  };
}

// =============================================================================
// ALGORITHM R IMPLEMENTATION
// =============================================================================

/**
 * Add a sample to the reservoir using Algorithm R.
 *
 * Algorithm R (Vitter 1985):
 * - If reservoir not full: add sample directly
 * - If reservoir full: with probability k/n, replace random sample
 *   where k = reservoir size, n = total samples seen
 *
 * This ensures each of the n items has equal probability k/n of being in the sample.
 *
 * @param state - Current reservoir state
 * @param value - New value to potentially add
 * @param config - Reservoir configuration
 * @returns Updated reservoir state (mutates in place for efficiency)
 */
export function addSample(
  state: ReservoirState,
  value: number,
  config: ReservoirConfig = DEFAULT_RESERVOIR_CONFIG
): ReservoirState {
  state.totalSeen++;
  state.lastUpdate = Date.now();

  if (state.samples.length < config.maxSamples) {
    // Reservoir not full - add directly
    state.samples.push(value);
  } else {
    // Reservoir full - Algorithm R replacement
    // Generate random index in range [0, totalSeen)
    const j = Math.floor(Math.random() * state.totalSeen);

    // If j < maxSamples, replace that element
    if (j < config.maxSamples) {
      state.samples[j] = value;
    }
    // Otherwise, the new sample is discarded
  }

  // Clear cached percentiles (will be recomputed on next read)
  state.percentiles = undefined;

  return state;
}

/**
 * Add multiple samples efficiently.
 * For batch processing of telemetry data.
 */
export function addSamples(
  state: ReservoirState,
  values: number[],
  config: ReservoirConfig = DEFAULT_RESERVOIR_CONFIG
): ReservoirState {
  for (const value of values) {
    addSample(state, value, config);
  }
  return state;
}

// =============================================================================
// PERCENTILE CALCULATION
// =============================================================================

/**
 * Calculate percentiles from the reservoir samples.
 *
 * Uses the "nearest rank" method for percentile calculation.
 *
 * @param state - Reservoir state with samples
 * @returns Computed percentiles, or undefined if no samples
 */
export function calculatePercentiles(state: ReservoirState): PercentileResult | undefined {
  if (state.samples.length === 0) {
    return undefined;
  }

  // Sort samples for percentile calculation
  const sorted = [...state.samples].sort((a, b) => a - b);
  const n = sorted.length;

  // Helper: get percentile value using nearest rank
  const getPercentile = (p: number): number => {
    const rank = Math.ceil((p / 100) * n) - 1;
    return sorted[Math.max(0, Math.min(n - 1, rank))];
  };

  // Calculate statistics
  const sum = sorted.reduce((a, b) => a + b, 0);

  const result: PercentileResult = {
    p50: getPercentile(50),
    p75: getPercentile(75),
    p90: getPercentile(90),
    p95: getPercentile(95),
    p99: getPercentile(99),
    min: sorted[0],
    max: sorted[n - 1],
    avg: sum / n,
    sampleCount: n,
    totalSeen: state.totalSeen,
  };

  // Cache in state
  state.percentiles = result;

  return result;
}

/**
 * Get percentiles, computing if not cached.
 */
export function getPercentiles(state: ReservoirState): PercentileResult | undefined {
  if (state.percentiles) {
    return state.percentiles;
  }
  return calculatePercentiles(state);
}

// =============================================================================
// KV PERSISTENCE HELPERS
// =============================================================================

/**
 * KV key for reservoir state.
 */
export function reservoirStateKey(featureId: string): string {
  return `STATE:RESERVOIR:${featureId}`;
}

/**
 * Get reservoir state from KV, returning fresh state if not found.
 */
export async function getReservoirState(
  featureId: string,
  kv: KVNamespace
): Promise<ReservoirState> {
  const key = reservoirStateKey(featureId);
  const data = await kv.get(key, 'json');
  if (data && typeof data === 'object') {
    return data as ReservoirState;
  }
  return createReservoirState();
}

/**
 * Save reservoir state to KV with 24h TTL.
 */
export async function saveReservoirState(
  featureId: string,
  state: ReservoirState,
  kv: KVNamespace
): Promise<void> {
  const key = reservoirStateKey(featureId);

  // Compute percentiles before saving for quick read access
  if (!state.percentiles && state.samples.length > 0) {
    calculatePercentiles(state);
  }

  await kv.put(key, JSON.stringify(state), { expirationTtl: 86400 });
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Merge two reservoir states.
 * Useful for combining data from multiple sources.
 *
 * Uses weighted random selection based on total samples seen.
 */
export function mergeReservoirs(
  a: ReservoirState,
  b: ReservoirState,
  config: ReservoirConfig = DEFAULT_RESERVOIR_CONFIG
): ReservoirState {
  if (a.totalSeen === 0) return { ...b };
  if (b.totalSeen === 0) return { ...a };

  // Combine all samples
  const combined = [...a.samples, ...b.samples];
  const totalSeen = a.totalSeen + b.totalSeen;

  // If combined fits in reservoir, keep all
  if (combined.length <= config.maxSamples) {
    return {
      samples: combined,
      totalSeen,
      lastUpdate: Math.max(a.lastUpdate, b.lastUpdate),
    };
  }

  // Otherwise, randomly select maxSamples
  // Shuffle using Fisher-Yates
  for (let i = combined.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [combined[i], combined[j]] = [combined[j], combined[i]];
  }

  return {
    samples: combined.slice(0, config.maxSamples),
    totalSeen,
    lastUpdate: Math.max(a.lastUpdate, b.lastUpdate),
  };
}

/**
 * Reset reservoir state (clear all samples).
 */
export function resetReservoir(state: ReservoirState): ReservoirState {
  state.samples = [];
  state.totalSeen = 0;
  state.lastUpdate = Date.now();
  state.percentiles = undefined;
  return state;
}

/**
 * Get estimated memory usage of reservoir state in bytes.
 * Useful for monitoring.
 */
export function estimateMemoryUsage(state: ReservoirState): number {
  // Rough estimate: 8 bytes per number + JSON overhead
  const samplesBytes = state.samples.length * 8;
  const overheadBytes = 200; // JSON keys, metadata
  return samplesBytes + overheadBytes;
}

/**
 * Format percentiles for logging/display.
 */
export function formatPercentiles(percentiles: PercentileResult): string {
  return (
    `p50=${percentiles.p50.toFixed(2)}ms, ` +
    `p95=${percentiles.p95.toFixed(2)}ms, ` +
    `p99=${percentiles.p99.toFixed(2)}ms, ` +
    `max=${percentiles.max.toFixed(2)}ms ` +
    `(n=${percentiles.sampleCount}/${percentiles.totalSeen})`
  );
}

/**
 * Check if percentiles indicate potential latency issues.
 *
 * @param percentiles - Computed percentiles
 * @param thresholds - Warning thresholds in ms
 * @returns Warning message if thresholds exceeded, undefined otherwise
 */
export function checkLatencyThresholds(
  percentiles: PercentileResult,
  thresholds: { p95Warning: number; p99Warning: number } = { p95Warning: 100, p99Warning: 500 }
): string | undefined {
  const warnings: string[] = [];

  if (percentiles.p95 > thresholds.p95Warning) {
    warnings.push(`p95 (${percentiles.p95.toFixed(1)}ms) > ${thresholds.p95Warning}ms`);
  }
  if (percentiles.p99 > thresholds.p99Warning) {
    warnings.push(`p99 (${percentiles.p99.toFixed(1)}ms) > ${thresholds.p99Warning}ms`);
  }

  return warnings.length > 0 ? warnings.join(', ') : undefined;
}
