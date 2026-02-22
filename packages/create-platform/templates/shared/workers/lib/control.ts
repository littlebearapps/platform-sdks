/// <reference types="@cloudflare/workers-types" />

/**
 * PID Controller for Intelligent Degradation
 *
 * Provides smooth throttle rate calculation (0.0-1.0) instead of binary ON/OFF.
 * State is stored in KV, making the controller stateless per invocation.
 *
 * Key principle: PID provides smooth degradation, circuit breakers remain the emergency stop.
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * PID controller gains and configuration.
 * Tuned for budget-based throttling where:
 * - setpoint (0.70) = target 70% budget utilisation
 * - Output range [0, 1] = throttle rate (0=no throttle, 1=full throttle)
 */
export interface PIDConfig {
  /** Proportional gain - responds to current error */
  kp: number;
  /** Integral gain - responds to accumulated error */
  ki: number;
  /** Derivative gain - responds to rate of change */
  kd: number;
  /** Target budget utilisation (0.0-1.0) */
  setpoint: number;
  /** Minimum output value (default: 0) */
  outputMin: number;
  /** Maximum output value (default: 1) */
  outputMax: number;
  /** Maximum integral accumulation to prevent windup */
  integralMax: number;
}

/**
 * Persisted PID state stored in KV.
 * Key: STATE:PID:{feature_id}
 */
export interface PIDState {
  /** Accumulated error (integral term) */
  integral: number;
  /** Previous error for derivative calculation */
  prevError: number;
  /** Last update timestamp (ms) */
  lastUpdate: number;
  /** Current throttle rate output */
  throttleRate: number;
}

/**
 * Input for PID computation.
 */
export interface PIDInput {
  /** Current budget utilisation (0.0-1.0+, can exceed 1.0 if over budget) */
  currentUsage: number;
  /** Time since last update in milliseconds */
  deltaTimeMs: number;
}

/**
 * Output from PID computation.
 */
export interface PIDOutput {
  /** Computed throttle rate (0.0-1.0) */
  throttleRate: number;
  /** Updated state to persist */
  newState: PIDState;
  /** Debug info for monitoring */
  debug: {
    error: number;
    pTerm: number;
    iTerm: number;
    dTerm: number;
  };
}

// =============================================================================
// DEFAULT CONFIGURATION
// =============================================================================

/**
 * Default PID configuration tuned for budget-based throttling.
 *
 * Rationale:
 * - kp=0.5: Moderate response to current error (50% of error -> throttle change)
 * - ki=0.1: Slow integral to avoid oscillation, correct steady-state error
 * - kd=0.05: Light derivative to dampen sudden changes
 * - setpoint=0.70: Target 70% budget utilisation, leaving 30% headroom
 * - integralMax=2.0: Prevent integral windup during sustained over-budget
 */
export const DEFAULT_PID_CONFIG: PIDConfig = {
  kp: 0.5,
  ki: 0.1,
  kd: 0.05,
  setpoint: 0.7,
  outputMin: 0,
  outputMax: 1,
  integralMax: 2.0,
};

/**
 * Create a fresh PID state (for new features or reset).
 */
export function createPIDState(): PIDState {
  return {
    integral: 0,
    prevError: 0,
    lastUpdate: Date.now(),
    throttleRate: 0,
  };
}

// =============================================================================
// PID COMPUTATION
// =============================================================================

/**
 * Compute PID output for throttle rate.
 *
 * This is a stateless function - pass in current state, get new state back.
 * The caller is responsible for persisting state to KV.
 *
 * @param state - Current PID state from KV (or fresh state for new features)
 * @param input - Current usage and timing information
 * @param config - PID configuration (defaults provided)
 * @returns New throttle rate and updated state
 *
 * @example
 * ```typescript
 * const state = await getPIDState(featureId, env);
 * const input = { currentUsage: 0.85, deltaTimeMs: 60000 };
 * const output = computePID(state, input);
 * await savePIDState(featureId, output.newState, env);
 * ```
 */
export function computePID(
  state: PIDState,
  input: PIDInput,
  config: PIDConfig = DEFAULT_PID_CONFIG
): PIDOutput {
  // Calculate error: positive = over budget, negative = under budget
  // error > 0 means we need MORE throttling
  const error = input.currentUsage - config.setpoint;

  // Convert deltaTime to seconds for consistent gains regardless of update frequency
  const dt = Math.max(input.deltaTimeMs / 1000, 0.001); // Minimum 1ms to avoid division issues

  // Proportional term: immediate response to current error
  const pTerm = config.kp * error;

  // Integral term: accumulated error over time (with anti-windup)
  let newIntegral = state.integral + error * dt;
  // Clamp integral to prevent windup
  newIntegral = Math.max(-config.integralMax, Math.min(config.integralMax, newIntegral));
  const iTerm = config.ki * newIntegral;

  // Derivative term: rate of change of error (damping)
  const derivative = (error - state.prevError) / dt;
  const dTerm = config.kd * derivative;

  // Sum all terms
  let output = pTerm + iTerm + dTerm;

  // Clamp output to valid range
  output = Math.max(config.outputMin, Math.min(config.outputMax, output));

  // Create new state
  const newState: PIDState = {
    integral: newIntegral,
    prevError: error,
    lastUpdate: Date.now(),
    throttleRate: output,
  };

  return {
    throttleRate: output,
    newState,
    debug: {
      error,
      pTerm,
      iTerm,
      dTerm,
    },
  };
}

// =============================================================================
// KV PERSISTENCE HELPERS
// =============================================================================

/**
 * KV key for PID state.
 */
export function pidStateKey(featureId: string): string {
  return `STATE:PID:${featureId}`;
}

/**
 * KV key for throttle rate (read by SDK).
 */
export function throttleRateKey(featureId: string): string {
  return `CONFIG:FEATURE:${featureId}:THROTTLE_RATE`;
}

/**
 * Get PID state from KV, returning fresh state if not found.
 */
export async function getPIDState(featureId: string, kv: KVNamespace): Promise<PIDState> {
  const key = pidStateKey(featureId);
  const data = await kv.get(key, 'json');
  if (data && typeof data === 'object') {
    return data as PIDState;
  }
  return createPIDState();
}

/**
 * Save PID state to KV with 24h TTL.
 * Also writes throttle rate to separate key with 5min TTL for SDK consumption.
 */
export async function savePIDState(
  featureId: string,
  state: PIDState,
  kv: KVNamespace
): Promise<void> {
  const stateKey = pidStateKey(featureId);
  const rateKey = throttleRateKey(featureId);

  // Save state with 24h TTL (for persistence across updates)
  await kv.put(stateKey, JSON.stringify(state), { expirationTtl: 86400 });

  // Save throttle rate separately with 5min TTL (for SDK quick access)
  // Only write if throttle rate > 0 to avoid unnecessary KV writes
  if (state.throttleRate > 0.001) {
    await kv.put(rateKey, state.throttleRate.toString(), { expirationTtl: 300 });
  } else {
    // Delete the key if throttle rate is essentially 0
    await kv.delete(rateKey);
  }
}

/**
 * Get current throttle rate for SDK consumption.
 * Returns 0 if no throttle rate is set.
 */
export async function getThrottleRate(featureId: string, kv: KVNamespace): Promise<number> {
  const key = throttleRateKey(featureId);
  const value = await kv.get(key);
  if (value) {
    const rate = parseFloat(value);
    return isNaN(rate) ? 0 : Math.max(0, Math.min(1, rate));
  }
  return 0;
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Calculate budget utilisation from current usage and limit.
 *
 * @param currentUsage - Current period usage value
 * @param budgetLimit - Budget limit for the period
 * @returns Utilisation ratio (0.0-1.0+, can exceed 1.0 if over budget)
 */
export function calculateUtilisation(currentUsage: number, budgetLimit: number): number {
  if (budgetLimit <= 0) return 0;
  return currentUsage / budgetLimit;
}

/**
 * Determine if PID update is needed based on time since last update.
 *
 * @param lastUpdate - Timestamp of last PID update (ms)
 * @param minIntervalMs - Minimum interval between updates (default: 60s)
 * @returns True if update is due
 */
export function shouldUpdatePID(lastUpdate: number, minIntervalMs: number = 60_000): boolean {
  return Date.now() - lastUpdate >= minIntervalMs;
}

/**
 * Format throttle rate for logging (percentage with 1 decimal).
 */
export function formatThrottleRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}
