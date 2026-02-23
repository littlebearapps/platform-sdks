/// <reference types="@cloudflare/workers-types" />

/**
 * Platform SDK Service Client
 *
 * Provides helpers for making inter-service requests with automatic
 * propagation of correlation IDs and trace context.
 *
 * @example
 * ```typescript
 * import { createServiceClient } from './lib/platform-sdk';
 *
 * // Create a client for calling another service
 * const client = createServiceClient(env, 'platform-alert-router');
 *
 * // Make a traced request
 * const response = await client.fetch('https://alert-router/notify', {
 *   method: 'POST',
 *   body: JSON.stringify({ message: 'Hello' })
 * });
 * ```
 */

import { getCorrelationId } from './logging';
import { getTraceContext, propagateTraceContext } from './tracing';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Service client for making inter-service requests.
 */
export interface ServiceClient {
  /** Make a fetch request with propagated context */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /** Get the current correlation ID */
  readonly correlationId: string;
  /** Get the current trace ID */
  readonly traceId: string | undefined;
}

/**
 * Options for creating a service client.
 */
export interface ServiceClientOptions {
  /** Target service name (for logging) */
  targetService: string;
  /** Additional default headers */
  defaultHeaders?: Record<string, string>;
  /** Request timeout in milliseconds */
  timeoutMs?: number;
}

// =============================================================================
// HEADER CONSTANTS
// =============================================================================

/** Correlation ID header name */
export const CORRELATION_ID_HEADER = 'x-correlation-id';

/** Source service header name */
export const SOURCE_SERVICE_HEADER = 'x-source-service';

/** Target service header name */
export const TARGET_SERVICE_HEADER = 'x-target-service';

/** Feature ID header name */
export const FEATURE_ID_HEADER = 'x-feature-id';

// =============================================================================
// SERVICE CLIENT
// =============================================================================

/**
 * Create a service client for making inter-service requests.
 * Automatically propagates correlation ID and trace context.
 *
 * @param env - Environment object (tracked or raw)
 * @param sourceService - Name of the calling service
 * @param options - Optional configuration
 * @returns Service client with fetch method
 */
export function createServiceClient(
  env: object,
  sourceService: string,
  options: Partial<ServiceClientOptions> = {}
): ServiceClient {
  const correlationId = getCorrelationId(env);
  const traceContext = getTraceContext(env);

  const { defaultHeaders = {}, timeoutMs } = options;

  return {
    get correlationId() {
      return correlationId;
    },

    get traceId() {
      return traceContext?.traceId;
    },

    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      // Build headers with propagated context
      const headers = new Headers(init?.headers);

      // Add correlation ID
      headers.set(CORRELATION_ID_HEADER, correlationId);

      // Add source service
      headers.set(SOURCE_SERVICE_HEADER, sourceService);

      // Add target service if known
      if (options.targetService) {
        headers.set(TARGET_SERVICE_HEADER, options.targetService);
      }

      // Add trace context headers
      if (traceContext) {
        const traceHeaders = propagateTraceContext(traceContext);
        traceHeaders.forEach((value, key) => {
          headers.set(key, value);
        });
      }

      // Add default headers
      for (const [key, value] of Object.entries(defaultHeaders)) {
        if (!headers.has(key)) {
          headers.set(key, value);
        }
      }

      // Build request options
      const requestInit: RequestInit = {
        ...init,
        headers,
      };

      // Apply timeout if specified
      if (timeoutMs) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
          return await fetch(input, {
            ...requestInit,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }
      }

      return fetch(input, requestInit);
    },
  };
}

// =============================================================================
// SERVICE BINDING HELPERS
// =============================================================================

/**
 * Create headers for calling a service binding (Fetcher).
 * Use this when calling env.SERVICE_BINDING.fetch() directly.
 *
 * @param env - Environment object
 * @param sourceService - Name of the calling service
 * @returns Headers object with propagated context
 */
export function createServiceBindingHeaders(env: object, sourceService: string): Headers {
  const headers = new Headers();

  // Add correlation ID
  headers.set(CORRELATION_ID_HEADER, getCorrelationId(env));

  // Add source service
  headers.set(SOURCE_SERVICE_HEADER, sourceService);

  // Add trace context
  const traceContext = getTraceContext(env);
  if (traceContext) {
    const traceHeaders = propagateTraceContext(traceContext);
    traceHeaders.forEach((value, key) => {
      headers.set(key, value);
    });
  }

  return headers;
}

/**
 * Wrap a service binding (Fetcher) with automatic context propagation.
 *
 * @param fetcher - Service binding (Fetcher)
 * @param env - Environment object
 * @param sourceService - Name of the calling service
 * @returns Wrapped fetcher that propagates context
 *
 * @example
 * ```typescript
 * const tracedAlertRouter = wrapServiceBinding(
 *   env.ALERT_ROUTER,
 *   env,
 *   'platform-usage'
 * );
 *
 * await tracedAlertRouter.fetch('https://alert-router/notify', {
 *   method: 'POST',
 *   body: JSON.stringify({ message: 'Alert!' })
 * });
 * ```
 */
export function wrapServiceBinding(fetcher: Fetcher, env: object, sourceService: string): Fetcher {
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);

      // Merge in service binding headers
      const contextHeaders = createServiceBindingHeaders(env, sourceService);
      contextHeaders.forEach((value, key) => {
        headers.set(key, value);
      });

      return fetcher.fetch(input, {
        ...init,
        headers,
      });
    },
    connect: fetcher.connect,
  };
}

// =============================================================================
// CORRELATION CHAIN EXTRACTION
// =============================================================================

/**
 * Extract correlation chain from request headers.
 * Returns information about the calling service and trace.
 */
export interface CorrelationChain {
  correlationId: string;
  sourceService?: string;
  targetService?: string;
  featureId?: string;
  traceId?: string;
  spanId?: string;
}

/**
 * Extract correlation chain from incoming request.
 *
 * @param request - Incoming request
 * @returns Correlation chain information
 */
export function extractCorrelationChain(request: Request): CorrelationChain {
  return {
    correlationId:
      request.headers.get(CORRELATION_ID_HEADER) ||
      request.headers.get('x-request-id') ||
      crypto.randomUUID(),
    sourceService: request.headers.get(SOURCE_SERVICE_HEADER) || undefined,
    targetService: request.headers.get(TARGET_SERVICE_HEADER) || undefined,
    featureId: request.headers.get(FEATURE_ID_HEADER) || undefined,
    traceId: extractTraceIdFromRequest(request),
    spanId: extractSpanIdFromRequest(request),
  };
}

/**
 * Extract trace ID from traceparent header.
 */
function extractTraceIdFromRequest(request: Request): string | undefined {
  const traceparent = request.headers.get('traceparent');
  if (!traceparent) return undefined;

  const parts = traceparent.split('-');
  return parts.length >= 2 ? parts[1] : undefined;
}

/**
 * Extract span ID from traceparent header.
 */
function extractSpanIdFromRequest(request: Request): string | undefined {
  const traceparent = request.headers.get('traceparent');
  if (!traceparent) return undefined;

  const parts = traceparent.split('-');
  return parts.length >= 3 ? parts[2] : undefined;
}
