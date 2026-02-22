/// <reference types="@cloudflare/workers-types" />

/**
 * Platform SDK Timeout Middleware
 *
 * Provides standardised timeout handling for async operations.
 * Returns 504 Gateway Timeout when operations exceed time limits.
 *
 * @example
 * ```typescript
 * import { withTimeout, TimeoutError } from './lib/platform-sdk';
 *
 * try {
 *   const result = await withTimeout(
 *     async () => await slowOperation(),
 *     5000, // 5 seconds
 *     'slow_operation'
 *   );
 * } catch (error) {
 *   if (error instanceof TimeoutError) {
 *     return new Response('Gateway Timeout', { status: 504 });
 *   }
 *   throw error;
 * }
 * ```
 */

import { reportErrorExplicit } from './errors';

// =============================================================================
// TIMEOUT ERROR
// =============================================================================

/**
 * Error thrown when an operation exceeds its timeout.
 */
export class TimeoutError extends Error {
  /** The operation that timed out */
  readonly operation: string;
  /** Timeout duration in milliseconds */
  readonly timeoutMs: number;
  /** Actual duration before timeout (may be slightly less than timeoutMs) */
  readonly actualMs: number;

  constructor(operation: string, timeoutMs: number, actualMs: number) {
    super(`Operation '${operation}' timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
    this.operation = operation;
    this.timeoutMs = timeoutMs;
    this.actualMs = actualMs;
  }
}

// =============================================================================
// TIMEOUT CONFIGURATION
// =============================================================================

/**
 * Default timeout values for different operation types.
 */
export const DEFAULT_TIMEOUTS = {
  /** Short operations (KV reads, simple D1 queries) */
  short: 5000, // 5 seconds
  /** Medium operations (API calls, complex queries) */
  medium: 15000, // 15 seconds
  /** Long operations (batch processing, AI inference) */
  long: 30000, // 30 seconds
  /** Maximum for any operation */
  max: 60000, // 60 seconds
} as const;

// =============================================================================
// TIMEOUT WRAPPER
// =============================================================================

/**
 * Execute an async function with a timeout.
 * Throws TimeoutError if the operation exceeds the specified duration.
 *
 * @param fn - Async function to execute
 * @param timeoutMs - Timeout in milliseconds (default: 30000)
 * @param operation - Operation name for error messages (default: 'operation')
 * @returns The result of the async function
 * @throws TimeoutError if the operation times out
 *
 * @example
 * ```typescript
 * const data = await withTimeout(
 *   () => fetch('https://api.example.com/slow'),
 *   10000,
 *   'fetch_external_api'
 * );
 * ```
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number = DEFAULT_TIMEOUTS.long,
  operation: string = 'operation'
): Promise<T> {
  const startTime = Date.now();

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      const actualMs = Date.now() - startTime;
      reject(new TimeoutError(operation, timeoutMs, actualMs));
    }, timeoutMs);
  });

  return Promise.race([fn(), timeoutPromise]);
}

/**
 * Execute an async function with timeout and automatic error reporting.
 * Reports timeout as TIMEOUT category in telemetry.
 *
 * @param env - Tracked environment for error reporting
 * @param fn - Async function to execute
 * @param timeoutMs - Timeout in milliseconds
 * @param operation - Operation name for error messages
 * @returns The result of the async function
 * @throws TimeoutError if the operation times out
 */
export async function withTrackedTimeout<T>(
  env: object,
  fn: () => Promise<T>,
  timeoutMs: number = DEFAULT_TIMEOUTS.long,
  operation: string = 'operation'
): Promise<T> {
  try {
    return await withTimeout(fn, timeoutMs, operation);
  } catch (error) {
    if (error instanceof TimeoutError) {
      reportErrorExplicit(env, 'TIMEOUT', `TIMEOUT_${operation.toUpperCase()}`);
    }
    throw error;
  }
}

// =============================================================================
// HTTP RESPONSE HELPERS
// =============================================================================

/**
 * Create a 504 Gateway Timeout response.
 *
 * @param error - Optional TimeoutError for details
 * @returns 504 Response with JSON body
 */
export function timeoutResponse(error?: TimeoutError): Response {
  const body = {
    error: 'Gateway Timeout',
    code: 'TIMEOUT',
    operation: error?.operation,
    timeout_ms: error?.timeoutMs,
  };

  return new Response(JSON.stringify(body), {
    status: 504,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Check if an error is a TimeoutError.
 */
export function isTimeoutError(error: unknown): error is TimeoutError {
  return error instanceof TimeoutError;
}

// =============================================================================
// REQUEST HANDLER WRAPPER
// =============================================================================

/**
 * Wrap a request handler with timeout handling.
 * Returns 504 Gateway Timeout if the handler exceeds the timeout.
 *
 * @param handler - Request handler function
 * @param timeoutMs - Timeout in milliseconds (default: 30000)
 * @param operation - Operation name for logging
 * @returns Wrapped handler that returns 504 on timeout
 *
 * @example
 * ```typescript
 * export default {
 *   fetch: withRequestTimeout(
 *     async (request, env, ctx) => {
 *       // Handler logic
 *       return new Response('OK');
 *     },
 *     30000,
 *     'api_handler'
 *   )
 * };
 * ```
 */
export function withRequestTimeout<Env>(
  handler: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>,
  timeoutMs: number = DEFAULT_TIMEOUTS.long,
  operation: string = 'request_handler'
): (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response> {
  return async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    try {
      return await withTimeout(() => handler(request, env, ctx), timeoutMs, operation);
    } catch (error) {
      if (isTimeoutError(error)) {
        return timeoutResponse(error);
      }
      throw error;
    }
  };
}
