/// <reference types="@cloudflare/workers-types" />

/**
 * Platform SDK Errors
 *
 * Error tracking and categorisation utilities for the Platform SDK.
 * Integrates with telemetry to report errors to the platform-usage consumer.
 *
 * @example
 * ```typescript
 * import { withFeatureBudget, reportError, completeTracking } from './lib/platform-sdk';
 *
 * const trackedEnv = withFeatureBudget(env, 'my-app:api:users', { ctx });
 * try {
 *   await riskyOperation(trackedEnv);
 * } catch (error) {
 *   reportError(trackedEnv, error);
 *   // Handle error...
 * }
 * await completeTracking(trackedEnv); // Errors included in telemetry
 * ```
 */

import type { ErrorCategory, MetricsAccumulator } from './types';
import { CircuitBreakerError } from './types';
import { getTelemetryContext } from './telemetry';
import { createLogger, type Logger } from './logging';
import { TimeoutError } from './timeout';

// =============================================================================
// MODULE LOGGER (lazy-initialized to avoid global scope crypto calls)
// =============================================================================

let _log: Logger | null = null;
function getLog(): Logger {
  if (!_log) {
    _log = createLogger({
      worker: 'platform-sdk',
      featureId: 'platform:sdk:errors',
    });
  }
  return _log;
}

// =============================================================================
// ERROR CATEGORISATION
// =============================================================================

/**
 * Categorise an error based on its type and message.
 * Uses error name, message patterns, and known error types.
 */
export function categoriseError(error: unknown): ErrorCategory {
  if (error instanceof CircuitBreakerError) {
    return 'CIRCUIT_BREAKER';
  }

  if (error instanceof TimeoutError) {
    return 'TIMEOUT';
  }

  if (error instanceof Error) {
    const name = error.name.toLowerCase();
    const message = error.message.toLowerCase();

    // Auth errors
    if (
      name.includes('auth') ||
      name.includes('unauthorized') ||
      name.includes('forbidden') ||
      message.includes('unauthorized') ||
      message.includes('forbidden') ||
      message.includes('401') ||
      message.includes('403')
    ) {
      return 'AUTH';
    }

    // Rate limit errors
    if (
      name.includes('ratelimit') ||
      message.includes('rate limit') ||
      message.includes('too many requests') ||
      message.includes('429')
    ) {
      return 'RATE_LIMIT';
    }

    // Network/timeout errors
    if (
      name.includes('timeout') ||
      name.includes('network') ||
      name.includes('fetch') ||
      message.includes('timeout') ||
      message.includes('network') ||
      message.includes('econnrefused') ||
      message.includes('enotfound') ||
      message.includes('socket hang up')
    ) {
      return 'NETWORK';
    }

    // Validation errors
    if (
      name.includes('validation') ||
      name.includes('schema') ||
      name.includes('parse') ||
      message.includes('invalid') ||
      message.includes('required') ||
      message.includes('expected')
    ) {
      return 'VALIDATION';
    }

    // D1 errors
    if (name.includes('d1') || message.includes('d1_error') || message.includes('sqlite')) {
      return 'D1_ERROR';
    }

    // KV errors
    if (name.includes('kv') || message.includes('kv_error') || message.includes('namespace')) {
      return 'KV_ERROR';
    }

    // Queue errors
    if (name.includes('queue') || message.includes('queue_error')) {
      return 'QUEUE_ERROR';
    }

    // External API errors (by common status codes)
    if (
      message.includes('500') ||
      message.includes('502') ||
      message.includes('503') ||
      message.includes('504')
    ) {
      return 'EXTERNAL_API';
    }
  }

  return 'INTERNAL';
}

/**
 * Extract error code from an error if available.
 */
export function extractErrorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object') {
    const errorObj = error as Record<string, unknown>;
    if (typeof errorObj.code === 'string') {
      return errorObj.code;
    }
    if (typeof errorObj.errno === 'string') {
      return errorObj.errno;
    }
    if (typeof errorObj.status === 'number') {
      return `HTTP_${errorObj.status}`;
    }
  }
  return undefined;
}

// =============================================================================
// ERROR TRACKING
// =============================================================================

/**
 * Track an error in the metrics accumulator.
 * Used internally by proxy wrappers and reportError.
 */
export function trackError(metrics: MetricsAccumulator, error: unknown): void {
  metrics.errorCount += 1;
  metrics.lastErrorCategory = categoriseError(error);

  const code = extractErrorCode(error);
  if (code && !metrics.errorCodes.includes(code)) {
    // Keep at most 10 unique error codes
    if (metrics.errorCodes.length < 10) {
      metrics.errorCodes.push(code);
    }
  }
}

/**
 * Report an error for a tracked environment.
 * Call this when you catch an error that should be included in telemetry.
 *
 * @param env - The tracked environment from withFeatureBudget
 * @param error - The error to report
 *
 * @example
 * ```typescript
 * try {
 *   await riskyOperation(trackedEnv);
 * } catch (error) {
 *   reportError(trackedEnv, error);
 *   throw error; // Re-throw or handle
 * }
 * ```
 */
export function reportError(env: object, error: unknown): void {
  const context = getTelemetryContext(env);
  if (!context) {
    getLog().warn('reportError called without telemetry context');
    return;
  }

  trackError(context.metrics, error);
}

/**
 * Report an error with explicit category and code.
 * Use when you know the error type better than automatic categorisation.
 *
 * @param env - The tracked environment from withFeatureBudget
 * @param category - Error category
 * @param code - Optional error code
 *
 * @example
 * ```typescript
 * if (!response.ok) {
 *   reportErrorExplicit(trackedEnv, 'EXTERNAL_API', `HTTP_${response.status}`);
 * }
 * ```
 */
export function reportErrorExplicit(env: object, category: ErrorCategory, code?: string): void {
  const context = getTelemetryContext(env);
  if (!context) {
    getLog().warn('reportErrorExplicit called without telemetry context');
    return;
  }

  context.metrics.errorCount += 1;
  context.metrics.lastErrorCategory = category;

  if (code && !context.metrics.errorCodes.includes(code)) {
    if (context.metrics.errorCodes.length < 10) {
      context.metrics.errorCodes.push(code);
    }
  }
}

/**
 * Check if a tracked environment has recorded any errors.
 */
export function hasErrors(env: object): boolean {
  const context = getTelemetryContext(env);
  return context ? context.metrics.errorCount > 0 : false;
}

/**
 * Get the error count for a tracked environment.
 */
export function getErrorCount(env: object): number {
  const context = getTelemetryContext(env);
  return context?.metrics.errorCount ?? 0;
}

// =============================================================================
// ERROR WRAPPER
// =============================================================================

/**
 * Wrap an async function to automatically track errors.
 * Errors are tracked and then re-thrown.
 *
 * @param env - The tracked environment from withFeatureBudget
 * @param fn - The async function to wrap
 * @returns The result of the function
 *
 * @example
 * ```typescript
 * const result = await withErrorTracking(trackedEnv, async () => {
 *   return await riskyOperation();
 * });
 * ```
 */
export async function withErrorTracking<T>(env: object, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    reportError(env, error);
    throw error;
  }
}
