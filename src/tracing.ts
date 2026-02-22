/// <reference types="@cloudflare/workers-types" />

/**
 * Platform SDK Distributed Tracing
 *
 * W3C Trace Context compliant distributed tracing for cross-service correlation.
 * Implements trace propagation via standard headers (traceparent, tracestate).
 *
 * @see https://www.w3.org/TR/trace-context/
 *
 * @example
 * ```typescript
 * import { createTraceContext, propagateTraceContext } from './lib/platform-sdk';
 *
 * // Extract from incoming request
 * const trace = createTraceContext(request);
 *
 * // Propagate to outgoing request
 * const headers = propagateTraceContext(trace);
 * await fetch('https://api.example.com', { headers });
 * ```
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * W3C Trace Context representation.
 */
export interface TraceContext {
  /** Trace ID - 16 bytes hex (32 chars) */
  traceId: string;
  /** Parent span ID - 8 bytes hex (16 chars) */
  spanId: string;
  /** Trace flags (sampled = 01) */
  traceFlags: number;
  /** Optional tracestate for vendor-specific data */
  traceState?: string;
  /** Indicates if this is a new trace (not extracted from request) */
  isNewTrace: boolean;
}

/**
 * Span representation for nested operations.
 */
export interface Span {
  /** Span ID - 8 bytes hex (16 chars) */
  spanId: string;
  /** Parent span ID */
  parentSpanId: string;
  /** Trace context */
  traceContext: TraceContext;
  /** Operation name */
  name: string;
  /** Start timestamp (ms) */
  startTime: number;
  /** End timestamp (ms) */
  endTime?: number;
  /** Span status */
  status: 'ok' | 'error' | 'unset';
  /** Span attributes */
  attributes: Record<string, string | number | boolean>;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** W3C Trace Context version */
const TRACE_VERSION = '00';

/** W3C Traceparent header name */
const TRACEPARENT_HEADER = 'traceparent';

/** W3C Tracestate header name */
const TRACESTATE_HEADER = 'tracestate';

/** Trace flag: sampled */
const FLAG_SAMPLED = 0x01;

/** Regex for validating traceparent header */
const TRACEPARENT_REGEX = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

// =============================================================================
// ID GENERATION
// =============================================================================

/**
 * Generate a random trace ID (16 bytes = 32 hex chars).
 */
export function generateTraceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generate a random span ID (8 bytes = 16 hex chars).
 */
export function generateSpanId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// =============================================================================
// TRACE CONTEXT MANAGEMENT
// =============================================================================

/**
 * WeakMap to store trace context per environment.
 */
const traceContexts = new WeakMap<object, TraceContext>();

/**
 * Get or create a trace context for an environment.
 */
export function getTraceContext(env: object): TraceContext {
  let ctx = traceContexts.get(env);
  if (!ctx) {
    ctx = createNewTraceContext();
    traceContexts.set(env, ctx);
  }
  return ctx;
}

/**
 * Set a trace context for an environment.
 */
export function setTraceContext(env: object, ctx: TraceContext): void {
  traceContexts.set(env, ctx);
}

/**
 * Create a new trace context (for new requests).
 */
export function createNewTraceContext(): TraceContext {
  return {
    traceId: generateTraceId(),
    spanId: generateSpanId(),
    traceFlags: FLAG_SAMPLED, // Always sampled by default
    isNewTrace: true,
  };
}

// =============================================================================
// PARSING AND SERIALIZATION
// =============================================================================

/**
 * Parse a W3C traceparent header.
 * Format: {version}-{trace-id}-{parent-id}-{trace-flags}
 * Example: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
 */
export function parseTraceparent(header: string): TraceContext | null {
  const match = header.toLowerCase().match(TRACEPARENT_REGEX);
  if (!match) {
    return null;
  }

  const [, version, traceId, spanId, flagsHex] = match;

  // Validate version
  if (version !== TRACE_VERSION) {
    // Future versions may have different formats, but for now only support 00
    return null;
  }

  // Validate trace ID is not all zeros
  if (traceId === '00000000000000000000000000000000') {
    return null;
  }

  // Validate span ID is not all zeros
  if (spanId === '0000000000000000') {
    return null;
  }

  return {
    traceId,
    spanId,
    traceFlags: parseInt(flagsHex, 16),
    isNewTrace: false,
  };
}

/**
 * Format a TraceContext as a W3C traceparent header value.
 */
export function formatTraceparent(ctx: TraceContext): string {
  const flags = ctx.traceFlags.toString(16).padStart(2, '0');
  return `${TRACE_VERSION}-${ctx.traceId}-${ctx.spanId}-${flags}`;
}

// =============================================================================
// REQUEST HANDLING
// =============================================================================

/**
 * Extract trace context from a request.
 * Creates a new child span for the current operation.
 */
export function extractTraceContext(request: Request): TraceContext {
  const traceparent = request.headers.get(TRACEPARENT_HEADER);
  const tracestate = request.headers.get(TRACESTATE_HEADER);

  if (traceparent) {
    const parsed = parseTraceparent(traceparent);
    if (parsed) {
      // Create a new span ID for this operation, keeping the trace ID
      return {
        traceId: parsed.traceId,
        spanId: generateSpanId(), // New span for this operation
        traceFlags: parsed.traceFlags,
        traceState: tracestate || undefined,
        isNewTrace: false,
      };
    }
  }

  // No valid traceparent, create a new trace
  return createNewTraceContext();
}

/**
 * Create trace context from a request and attach to environment.
 * This is the main entry point for incoming requests.
 */
export function createTraceContext(request: Request, env: object): TraceContext {
  const ctx = extractTraceContext(request);
  setTraceContext(env, ctx);
  return ctx;
}

// =============================================================================
// PROPAGATION
// =============================================================================

/**
 * Get headers for propagating trace context to outgoing requests.
 * Creates a new span ID for the outgoing call.
 */
export function propagateTraceContext(ctx: TraceContext): Headers {
  const headers = new Headers();

  // Create a new span ID for the outgoing request (child span)
  const childContext: TraceContext = {
    ...ctx,
    spanId: generateSpanId(),
  };

  headers.set(TRACEPARENT_HEADER, formatTraceparent(childContext));

  if (ctx.traceState) {
    headers.set(TRACESTATE_HEADER, ctx.traceState);
  }

  return headers;
}

/**
 * Merge trace propagation headers into existing headers.
 */
export function addTraceHeaders(
  headers: Headers | Record<string, string>,
  ctx: TraceContext
): Headers {
  const propagationHeaders = propagateTraceContext(ctx);
  const result = headers instanceof Headers ? new Headers(headers) : new Headers(headers);

  propagationHeaders.forEach((value, key) => {
    result.set(key, value);
  });

  return result;
}

/**
 * Create a fetch wrapper that automatically propagates trace context.
 */
export function createTracedFetch(
  ctx: TraceContext
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const propagationHeaders = propagateTraceContext(ctx);

    propagationHeaders.forEach((value, key) => {
      headers.set(key, value);
    });

    return fetch(input, {
      ...init,
      headers,
    });
  };
}

// =============================================================================
// SPAN MANAGEMENT
// =============================================================================

/**
 * Start a new span for an operation.
 */
export function startSpan(ctx: TraceContext, name: string): Span {
  return {
    spanId: generateSpanId(),
    parentSpanId: ctx.spanId,
    traceContext: ctx,
    name,
    startTime: Date.now(),
    status: 'unset',
    attributes: {},
  };
}

/**
 * End a span with success status.
 */
export function endSpan(span: Span): Span {
  return {
    ...span,
    endTime: Date.now(),
    status: span.status === 'unset' ? 'ok' : span.status,
  };
}

/**
 * End a span with error status.
 */
export function failSpan(span: Span, error?: unknown): Span {
  const result: Span = {
    ...span,
    endTime: Date.now(),
    status: 'error',
  };

  if (error instanceof Error) {
    result.attributes['error.type'] = error.name;
    result.attributes['error.message'] = error.message;
  }

  return result;
}

/**
 * Add an attribute to a span.
 */
export function setSpanAttribute(span: Span, key: string, value: string | number | boolean): Span {
  return {
    ...span,
    attributes: {
      ...span.attributes,
      [key]: value,
    },
  };
}

// =============================================================================
// UTILITIES
// =============================================================================

/**
 * Check if a trace context is sampled (should be recorded).
 */
export function isSampled(ctx: TraceContext): boolean {
  return (ctx.traceFlags & FLAG_SAMPLED) !== 0;
}

/**
 * Get a short trace ID for logging (first 8 chars).
 */
export function shortTraceId(ctx: TraceContext): string {
  return ctx.traceId.substring(0, 8);
}

/**
 * Get a short span ID for logging (first 8 chars).
 */
export function shortSpanId(ctx: TraceContext): string {
  return ctx.spanId.substring(0, 8);
}

/**
 * Format trace context for log output.
 */
export function formatTraceForLog(ctx: TraceContext): {
  trace_id: string;
  span_id: string;
  trace_flags: string;
} {
  return {
    trace_id: ctx.traceId,
    span_id: ctx.spanId,
    trace_flags: ctx.traceFlags.toString(16).padStart(2, '0'),
  };
}
