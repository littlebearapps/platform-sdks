/// <reference types="@cloudflare/workers-types" />

/**
 * Platform SDK Logging
 *
 * Structured JSON logging for Workers Observability.
 * Provides correlation IDs, error categorisation, and timed operations.
 *
 * @example
 * ```typescript
 * import { createLoggerFromEnv } from './lib/platform-sdk';
 *
 * const log = createLoggerFromEnv(env, 'stripe-connector', 'platform:connector:stripe');
 * log.info('Starting sync', { customerId: 'cus_123' });
 *
 * try {
 *   const duration = await log.timed('fetch_customers', async () => {
 *     return await stripe.customers.list();
 *   });
 * } catch (error) {
 *   log.error('Sync failed', error);
 * }
 * ```
 */

import { CircuitBreakerError } from './types';
import { extractTraceContext, setTraceContext } from './tracing';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Log severity levels.
 * Maps to Workers Observability log levels.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Error category for classification.
 * Used for alerting priority and deduplication.
 */
export type ErrorCategory =
  | 'VALIDATION' // Input/schema validation errors
  | 'NETWORK' // Network/timeout errors
  | 'CIRCUIT_BREAKER' // Circuit breaker tripped
  | 'INTERNAL' // Internal/unexpected errors
  | 'AUTH' // Authentication/authorisation errors
  | 'RATE_LIMIT' // Rate limiting errors
  | 'D1_ERROR' // D1 database errors
  | 'KV_ERROR' // KV namespace errors
  | 'QUEUE_ERROR' // Queue errors
  | 'EXTERNAL_API'; // External API errors

/**
 * Structured log entry.
 * JSON format for Workers Observability.
 */
export interface StructuredLog {
  /** Log level */
  level: LogLevel;
  /** Human-readable message */
  message: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Correlation ID for request tracing */
  correlationId?: string;
  /** W3C Trace ID (32 hex chars) for distributed tracing */
  traceId?: string;
  /** W3C Span ID (16 hex chars) for distributed tracing */
  spanId?: string;
  /** Feature ID (project:category:feature) */
  featureId?: string;
  /** Worker name */
  worker: string;
  /** Error category (for error/warn levels) */
  category?: ErrorCategory;
  /** Error details */
  error?: {
    name: string;
    message: string;
    stack?: string;
    code?: string;
  };
  /** Additional context */
  context?: Record<string, unknown>;
  /** Operation duration in milliseconds */
  durationMs?: number;
}

/**
 * Logger configuration options.
 */
export interface LoggerOptions {
  /** Worker name for identification */
  worker: string;
  /** Feature ID for budget tracking */
  featureId?: string;
  /** Correlation ID for request tracing */
  correlationId?: string;
  /** W3C Trace ID for distributed tracing */
  traceId?: string;
  /** W3C Span ID for distributed tracing */
  spanId?: string;
  /** Minimum log level (default: 'info') */
  minLevel?: LogLevel;
  /** Additional default context */
  defaultContext?: Record<string, unknown>;
}

/**
 * Logger interface.
 */
export interface Logger {
  /** Log debug message */
  debug(message: string, context?: Record<string, unknown>): void;
  /** Log info message */
  info(message: string, context?: Record<string, unknown>): void;
  /** Log warning message (with optional error) */
  warn(message: string, error?: unknown, context?: Record<string, unknown>): void;
  /** Log error message */
  error(message: string, error?: unknown, context?: Record<string, unknown>): void;
  /** Time an async operation and log its duration */
  timed<T>(operation: string, fn: () => Promise<T>, context?: Record<string, unknown>): Promise<T>;
  /** Create a child logger with additional context */
  child(context: Record<string, unknown>): Logger;
  /** Get the correlation ID */
  readonly correlationId: string;
}

// =============================================================================
// CORRELATION ID MANAGEMENT
// =============================================================================

/**
 * WeakMap to store correlation IDs per environment.
 * Same pattern as telemetry context.
 */
const correlationIds = new WeakMap<object, string>();

/**
 * Generate a new correlation ID.
 * Uses crypto.randomUUID() for uniqueness.
 */
export function generateCorrelationId(): string {
  return crypto.randomUUID();
}

/**
 * Get or create a correlation ID for an environment.
 */
export function getCorrelationId(env: object): string {
  let id = correlationIds.get(env);
  if (!id) {
    id = generateCorrelationId();
    correlationIds.set(env, id);
  }
  return id;
}

/**
 * Set a specific correlation ID for an environment.
 * Useful for propagating IDs from incoming requests.
 */
export function setCorrelationId(env: object, correlationId: string): void {
  correlationIds.set(env, correlationId);
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
// LOG LEVEL FILTERING
// =============================================================================

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Check if a log level should be output based on minimum level.
 */
function shouldLog(level: LogLevel, minLevel: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[minLevel];
}

// =============================================================================
// LOGGER IMPLEMENTATION
// =============================================================================

/**
 * Create a structured logger.
 */
export function createLogger(options: LoggerOptions): Logger {
  const {
    worker,
    featureId,
    correlationId,
    traceId,
    spanId,
    minLevel = 'info',
    defaultContext = {},
  } = options;

  const logCorrelationId = correlationId ?? generateCorrelationId();

  function formatLog(
    level: LogLevel,
    message: string,
    error?: unknown,
    context?: Record<string, unknown>,
    durationMs?: number
  ): StructuredLog {
    const log: StructuredLog = {
      level,
      message,
      timestamp: new Date().toISOString(),
      worker,
    };

    if (logCorrelationId) {
      log.correlationId = logCorrelationId;
    }

    // Add distributed tracing context
    if (traceId) {
      log.traceId = traceId;
    }
    if (spanId) {
      log.spanId = spanId;
    }

    if (featureId) {
      log.featureId = featureId;
    }

    if (error) {
      log.category = categoriseError(error);
      log.error = {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
        code: extractErrorCode(error),
      };
      // Only include stack in debug mode or for errors
      if (error instanceof Error && error.stack && level === 'error') {
        log.error.stack = error.stack;
      }
    }

    if (durationMs !== undefined) {
      log.durationMs = durationMs;
    }

    // Merge default context with provided context
    const mergedContext = { ...defaultContext, ...context };
    if (Object.keys(mergedContext).length > 0) {
      log.context = mergedContext;
    }

    return log;
  }

  function output(log: StructuredLog): void {
    // Output as JSON for Workers Observability
    const json = JSON.stringify(log);

    switch (log.level) {
      case 'debug':
        console.debug(json);
        break;
      case 'info':
        console.log(json);
        break;
      case 'warn':
        console.warn(json);
        break;
      case 'error':
        console.error(json);
        break;
    }
  }

  const logger: Logger = {
    get correlationId() {
      return logCorrelationId;
    },

    debug(message: string, context?: Record<string, unknown>): void {
      if (shouldLog('debug', minLevel)) {
        output(formatLog('debug', message, undefined, context));
      }
    },

    info(message: string, context?: Record<string, unknown>): void {
      if (shouldLog('info', minLevel)) {
        output(formatLog('info', message, undefined, context));
      }
    },

    warn(message: string, error?: unknown, context?: Record<string, unknown>): void {
      if (shouldLog('warn', minLevel)) {
        output(formatLog('warn', message, error, context));
      }
    },

    error(message: string, error?: unknown, context?: Record<string, unknown>): void {
      if (shouldLog('error', minLevel)) {
        output(formatLog('error', message, error, context));
      }
    },

    async timed<T>(
      operation: string,
      fn: () => Promise<T>,
      context?: Record<string, unknown>
    ): Promise<T> {
      const start = Date.now();
      try {
        const result = await fn();
        const durationMs = Date.now() - start;
        if (shouldLog('info', minLevel)) {
          output(formatLog('info', `${operation} completed`, undefined, context, durationMs));
        }
        return result;
      } catch (error) {
        const durationMs = Date.now() - start;
        if (shouldLog('error', minLevel)) {
          output(formatLog('error', `${operation} failed`, error, context, durationMs));
        }
        throw error;
      }
    },

    child(context: Record<string, unknown>): Logger {
      return createLogger({
        worker,
        featureId,
        correlationId: logCorrelationId,
        traceId,
        spanId,
        minLevel,
        defaultContext: { ...defaultContext, ...context },
      });
    },
  };

  return logger;
}

/**
 * Create a logger from a tracked environment.
 * Automatically extracts or creates correlation ID.
 *
 * @param env - Worker environment (tracked or raw)
 * @param worker - Worker name
 * @param featureId - Feature ID for budget tracking
 * @param minLevel - Minimum log level (default: 'info')
 */
export function createLoggerFromEnv(
  env: object,
  worker: string,
  featureId?: string,
  minLevel: LogLevel = 'info'
): Logger {
  const correlationId = getCorrelationId(env);

  return createLogger({
    worker,
    featureId,
    correlationId,
    minLevel,
  });
}

// =============================================================================
// REQUEST CONTEXT HELPERS
// =============================================================================

/**
 * Extract correlation ID from request headers.
 * Looks for common correlation ID headers.
 */
export function extractCorrelationIdFromRequest(request: Request): string | undefined {
  const headers = [
    'x-correlation-id',
    'x-request-id',
    'x-trace-id',
    'cf-ray', // Cloudflare Ray ID as fallback
  ];

  for (const header of headers) {
    const value = request.headers.get(header);
    if (value) {
      return value;
    }
  }

  return undefined;
}

/**
 * Create a logger from an incoming request.
 * Extracts correlation ID and trace context from headers if present.
 */
export function createLoggerFromRequest(
  request: Request,
  env: object,
  worker: string,
  featureId?: string,
  minLevel: LogLevel = 'info'
): Logger {
  const correlationId = extractCorrelationIdFromRequest(request) ?? getCorrelationId(env);

  // Also set on env for downstream use
  setCorrelationId(env, correlationId);

  // Extract W3C Trace Context from request
  const traceContext = extractTraceContext(request);
  setTraceContext(env, traceContext);

  return createLogger({
    worker,
    featureId,
    correlationId,
    traceId: traceContext.traceId,
    spanId: traceContext.spanId,
    minLevel,
  });
}
