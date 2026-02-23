import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  generateTraceId,
  generateSpanId,
  getTraceContext,
  setTraceContext,
  createNewTraceContext,
  parseTraceparent,
  formatTraceparent,
  extractTraceContext,
  createTraceContext,
  propagateTraceContext,
  addTraceHeaders,
  createTracedFetch,
  startSpan,
  endSpan,
  failSpan,
  setSpanAttribute,
  isSampled,
  shortTraceId,
  shortSpanId,
  formatTraceForLog,
  type TraceContext as TraceContextType,
} from '../src/tracing';

// =============================================================================
// ID GENERATION
// =============================================================================

describe('generateTraceId', () => {
  it('returns a 32-character hex string', () => {
    const id = generateTraceId();
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateTraceId()));
    expect(ids.size).toBe(20);
  });
});

describe('generateSpanId', () => {
  it('returns a 16-character hex string', () => {
    const id = generateSpanId();
    expect(id).toHaveLength(16);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateSpanId()));
    expect(ids.size).toBe(20);
  });
});

// =============================================================================
// TRACE CONTEXT MANAGEMENT
// =============================================================================

describe('getTraceContext', () => {
  it('creates new context on first call for an env', () => {
    const env = { id: 'test-1' };
    const ctx = getTraceContext(env);
    expect(ctx.traceId).toHaveLength(32);
    expect(ctx.spanId).toHaveLength(16);
    expect(ctx.isNewTrace).toBe(true);
  });

  it('returns same context for same env object', () => {
    const env = { id: 'test-2' };
    const ctx1 = getTraceContext(env);
    const ctx2 = getTraceContext(env);
    expect(ctx1).toBe(ctx2);
  });

  it('returns different contexts for different env objects', () => {
    const env1 = { id: 'a' };
    const env2 = { id: 'b' };
    const ctx1 = getTraceContext(env1);
    const ctx2 = getTraceContext(env2);
    expect(ctx1.traceId).not.toBe(ctx2.traceId);
  });
});

describe('setTraceContext', () => {
  it('sets and retrieves context', () => {
    const env = { id: 'test-set' };
    const custom: TraceContextType = {
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      traceFlags: 1,
      isNewTrace: false,
    };
    setTraceContext(env, custom);
    const retrieved = getTraceContext(env);
    expect(retrieved).toBe(custom);
  });
});

describe('createNewTraceContext', () => {
  it('creates context with valid IDs', () => {
    const ctx = createNewTraceContext();
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('sets isNewTrace to true', () => {
    const ctx = createNewTraceContext();
    expect(ctx.isNewTrace).toBe(true);
  });

  it('sets traceFlags to sampled (0x01)', () => {
    const ctx = createNewTraceContext();
    expect(ctx.traceFlags).toBe(0x01);
  });

  it('has no traceState', () => {
    const ctx = createNewTraceContext();
    expect(ctx.traceState).toBeUndefined();
  });
});

// =============================================================================
// PARSING AND SERIALIZATION
// =============================================================================

describe('parseTraceparent', () => {
  const validHeader = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

  it('parses valid traceparent', () => {
    const ctx = parseTraceparent(validHeader);
    expect(ctx).not.toBeNull();
    expect(ctx!.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(ctx!.spanId).toBe('b7ad6b7169203331');
    expect(ctx!.traceFlags).toBe(1);
  });

  it('sets isNewTrace to false', () => {
    const ctx = parseTraceparent(validHeader);
    expect(ctx!.isNewTrace).toBe(false);
  });

  it('returns null for invalid version', () => {
    const result = parseTraceparent('01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    expect(result).toBeNull();
  });

  it('returns null for all-zero trace ID', () => {
    const result = parseTraceparent('00-00000000000000000000000000000000-b7ad6b7169203331-01');
    expect(result).toBeNull();
  });

  it('returns null for all-zero span ID', () => {
    const result = parseTraceparent('00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01');
    expect(result).toBeNull();
  });

  it('returns null for invalid format', () => {
    expect(parseTraceparent('invalid')).toBeNull();
    expect(parseTraceparent('')).toBeNull();
    expect(parseTraceparent('00-abc-def-01')).toBeNull();
  });

  it('is case-insensitive', () => {
    const upper = '00-0AF7651916CD43DD8448EB211C80319C-B7AD6B7169203331-01';
    const ctx = parseTraceparent(upper);
    expect(ctx).not.toBeNull();
    expect(ctx!.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
  });

  it('parses trace flags correctly', () => {
    const unsampled = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00';
    const ctx = parseTraceparent(unsampled);
    expect(ctx!.traceFlags).toBe(0);
  });
});

describe('formatTraceparent', () => {
  it('formats to W3C spec', () => {
    const ctx: TraceContextType = {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: 1,
      isNewTrace: false,
    };
    expect(formatTraceparent(ctx)).toBe(
      '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
    );
  });

  it('pads flags to 2 hex digits', () => {
    const ctx: TraceContextType = {
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      traceFlags: 0,
      isNewTrace: false,
    };
    const result = formatTraceparent(ctx);
    expect(result.endsWith('-00')).toBe(true);
  });

  it('roundtrips with parseTraceparent', () => {
    const original = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const parsed = parseTraceparent(original)!;
    expect(formatTraceparent(parsed)).toBe(original);
  });
});

// =============================================================================
// REQUEST HANDLING
// =============================================================================

describe('extractTraceContext', () => {
  it('extracts context from valid traceparent header', () => {
    const request = new Request('https://example.com', {
      headers: {
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      },
    });
    const ctx = extractTraceContext(request);
    expect(ctx.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(ctx.isNewTrace).toBe(false);
  });

  it('creates new span ID (not the one from header)', () => {
    const request = new Request('https://example.com', {
      headers: {
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      },
    });
    const ctx = extractTraceContext(request);
    expect(ctx.spanId).not.toBe('b7ad6b7169203331');
    expect(ctx.spanId).toHaveLength(16);
  });

  it('preserves tracestate header', () => {
    const request = new Request('https://example.com', {
      headers: {
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
        tracestate: 'vendor=value',
      },
    });
    const ctx = extractTraceContext(request);
    expect(ctx.traceState).toBe('vendor=value');
  });

  it('creates new trace if no traceparent header', () => {
    const request = new Request('https://example.com');
    const ctx = extractTraceContext(request);
    expect(ctx.isNewTrace).toBe(true);
    expect(ctx.traceId).toHaveLength(32);
  });

  it('creates new trace if traceparent is invalid', () => {
    const request = new Request('https://example.com', {
      headers: { traceparent: 'garbage' },
    });
    const ctx = extractTraceContext(request);
    expect(ctx.isNewTrace).toBe(true);
  });
});

describe('createTraceContext', () => {
  it('extracts from request and attaches to env', () => {
    const request = new Request('https://example.com', {
      headers: {
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      },
    });
    const env = { id: 'create-test' };
    const ctx = createTraceContext(request, env);
    expect(ctx.traceId).toBe('0af7651916cd43dd8448eb211c80319c');

    // Should be stored on env
    const stored = getTraceContext(env);
    expect(stored).toBe(ctx);
  });
});

// =============================================================================
// PROPAGATION
// =============================================================================

describe('propagateTraceContext', () => {
  it('returns Headers with traceparent', () => {
    const ctx = createNewTraceContext();
    const headers = propagateTraceContext(ctx);
    const traceparent = headers.get('traceparent');
    expect(traceparent).not.toBeNull();
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
  });

  it('creates new child span ID', () => {
    const ctx = createNewTraceContext();
    const headers = propagateTraceContext(ctx);
    const traceparent = headers.get('traceparent')!;
    const childSpanId = traceparent.split('-')[2];
    expect(childSpanId).not.toBe(ctx.spanId);
  });

  it('preserves trace ID in child', () => {
    const ctx = createNewTraceContext();
    const headers = propagateTraceContext(ctx);
    const traceparent = headers.get('traceparent')!;
    const childTraceId = traceparent.split('-')[1];
    expect(childTraceId).toBe(ctx.traceId);
  });

  it('includes tracestate if present', () => {
    const ctx: TraceContextType = {
      ...createNewTraceContext(),
      traceState: 'vendor=value',
    };
    const headers = propagateTraceContext(ctx);
    expect(headers.get('tracestate')).toBe('vendor=value');
  });

  it('omits tracestate if not present', () => {
    const ctx = createNewTraceContext();
    const headers = propagateTraceContext(ctx);
    expect(headers.get('tracestate')).toBeNull();
  });
});

describe('addTraceHeaders', () => {
  it('accepts Headers instance', () => {
    const ctx = createNewTraceContext();
    const existing = new Headers({ 'Content-Type': 'application/json' });
    const result = addTraceHeaders(existing, ctx);
    expect(result.get('Content-Type')).toBe('application/json');
    expect(result.get('traceparent')).not.toBeNull();
  });

  it('accepts Record<string, string>', () => {
    const ctx = createNewTraceContext();
    const result = addTraceHeaders({ Authorization: 'Bearer xxx' }, ctx);
    expect(result.get('Authorization')).toBe('Bearer xxx');
    expect(result.get('traceparent')).not.toBeNull();
  });

  it('does not mutate original headers', () => {
    const ctx = createNewTraceContext();
    const original = new Headers({ 'X-Custom': 'test' });
    addTraceHeaders(original, ctx);
    expect(original.get('traceparent')).toBeNull();
  });
});

describe('createTracedFetch', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('OK'));
  });

  it('returns a fetch function', () => {
    const ctx = createNewTraceContext();
    const tracedFetch = createTracedFetch(ctx);
    expect(typeof tracedFetch).toBe('function');
  });

  it('adds traceparent header to request', async () => {
    const ctx = createNewTraceContext();
    const tracedFetch = createTracedFetch(ctx);
    await tracedFetch('https://example.com');

    expect(globalThis.fetch).toHaveBeenCalled();
    const callArgs = vi.mocked(globalThis.fetch).mock.calls[0];
    const headers = callArgs[1]?.headers as Headers;
    expect(headers.get('traceparent')).not.toBeNull();
  });

  it('preserves existing init options', async () => {
    const ctx = createNewTraceContext();
    const tracedFetch = createTracedFetch(ctx);
    await tracedFetch('https://example.com', { method: 'POST', body: 'test' });

    const callArgs = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(callArgs[1]?.method).toBe('POST');
    expect(callArgs[1]?.body).toBe('test');
  });
});

// =============================================================================
// SPAN MANAGEMENT
// =============================================================================

describe('startSpan', () => {
  it('creates span with new span ID', () => {
    const ctx = createNewTraceContext();
    const span = startSpan(ctx, 'db_query');
    expect(span.spanId).toHaveLength(16);
    expect(span.spanId).not.toBe(ctx.spanId);
  });

  it('sets parentSpanId to context span ID', () => {
    const ctx = createNewTraceContext();
    const span = startSpan(ctx, 'test');
    expect(span.parentSpanId).toBe(ctx.spanId);
  });

  it('sets name and startTime', () => {
    const ctx = createNewTraceContext();
    const before = Date.now();
    const span = startSpan(ctx, 'my_operation');
    expect(span.name).toBe('my_operation');
    expect(span.startTime).toBeGreaterThanOrEqual(before);
  });

  it('sets status to unset', () => {
    const ctx = createNewTraceContext();
    const span = startSpan(ctx, 'test');
    expect(span.status).toBe('unset');
  });

  it('initialises empty attributes', () => {
    const ctx = createNewTraceContext();
    const span = startSpan(ctx, 'test');
    expect(span.attributes).toEqual({});
  });
});

describe('endSpan', () => {
  it('sets endTime', () => {
    const ctx = createNewTraceContext();
    const span = startSpan(ctx, 'test');
    const ended = endSpan(span);
    expect(ended.endTime).toBeDefined();
    expect(ended.endTime!).toBeGreaterThanOrEqual(span.startTime);
  });

  it('changes unset status to ok', () => {
    const ctx = createNewTraceContext();
    const span = startSpan(ctx, 'test');
    const ended = endSpan(span);
    expect(ended.status).toBe('ok');
  });

  it('preserves error status', () => {
    const ctx = createNewTraceContext();
    const span = startSpan(ctx, 'test');
    const failed = failSpan(span);
    const ended = endSpan(failed);
    expect(ended.status).toBe('error');
  });

  it('returns new span object (immutable)', () => {
    const ctx = createNewTraceContext();
    const span = startSpan(ctx, 'test');
    const ended = endSpan(span);
    expect(ended).not.toBe(span);
  });
});

describe('failSpan', () => {
  it('sets status to error', () => {
    const ctx = createNewTraceContext();
    const span = startSpan(ctx, 'test');
    const failed = failSpan(span);
    expect(failed.status).toBe('error');
  });

  it('sets endTime', () => {
    const ctx = createNewTraceContext();
    const span = startSpan(ctx, 'test');
    const failed = failSpan(span);
    expect(failed.endTime).toBeDefined();
  });

  it('extracts error name and message', () => {
    const ctx = createNewTraceContext();
    const span = startSpan(ctx, 'test');
    const failed = failSpan(span, new TypeError('bad input'));
    expect(failed.attributes['error.type']).toBe('TypeError');
    expect(failed.attributes['error.message']).toBe('bad input');
  });

  it('handles non-Error objects gracefully', () => {
    const ctx = createNewTraceContext();
    const span = startSpan(ctx, 'test');
    const failed = failSpan(span, 'string error');
    expect(failed.status).toBe('error');
    expect(failed.attributes['error.type']).toBeUndefined();
  });

  it('handles no error argument', () => {
    const ctx = createNewTraceContext();
    const span = startSpan(ctx, 'test');
    const failed = failSpan(span);
    expect(failed.status).toBe('error');
    expect(failed.endTime).toBeDefined();
  });
});

describe('setSpanAttribute', () => {
  it('adds attribute to span', () => {
    const ctx = createNewTraceContext();
    const span = startSpan(ctx, 'test');
    const updated = setSpanAttribute(span, 'db.type', 'd1');
    expect(updated.attributes['db.type']).toBe('d1');
  });

  it('returns new span object (immutable)', () => {
    const ctx = createNewTraceContext();
    const span = startSpan(ctx, 'test');
    const updated = setSpanAttribute(span, 'key', 'value');
    expect(updated).not.toBe(span);
    expect(span.attributes['key']).toBeUndefined();
  });

  it('accumulates multiple attributes', () => {
    const ctx = createNewTraceContext();
    let span = startSpan(ctx, 'test');
    span = setSpanAttribute(span, 'a', 1);
    span = setSpanAttribute(span, 'b', true);
    span = setSpanAttribute(span, 'c', 'hello');
    expect(span.attributes).toEqual({ a: 1, b: true, c: 'hello' });
  });
});

// =============================================================================
// UTILITIES
// =============================================================================

describe('isSampled', () => {
  it('returns true when sampled flag is set', () => {
    const ctx = createNewTraceContext();
    expect(isSampled(ctx)).toBe(true);
  });

  it('returns false when flags are 0', () => {
    const ctx: TraceContextType = {
      ...createNewTraceContext(),
      traceFlags: 0,
    };
    expect(isSampled(ctx)).toBe(false);
  });
});

describe('shortTraceId', () => {
  it('returns first 8 characters', () => {
    const ctx: TraceContextType = {
      ...createNewTraceContext(),
      traceId: '0af7651916cd43dd8448eb211c80319c',
    };
    expect(shortTraceId(ctx)).toBe('0af76519');
  });
});

describe('shortSpanId', () => {
  it('returns first 8 characters', () => {
    const ctx: TraceContextType = {
      ...createNewTraceContext(),
      spanId: 'b7ad6b7169203331',
    };
    expect(shortSpanId(ctx)).toBe('b7ad6b71');
  });
});

describe('formatTraceForLog', () => {
  it('returns object with trace_id, span_id, trace_flags', () => {
    const ctx: TraceContextType = {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: 1,
      isNewTrace: false,
    };
    const log = formatTraceForLog(ctx);
    expect(log.trace_id).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(log.span_id).toBe('b7ad6b7169203331');
    expect(log.trace_flags).toBe('01');
  });

  it('pads flags to 2 hex digits', () => {
    const ctx: TraceContextType = {
      ...createNewTraceContext(),
      traceFlags: 0,
    };
    const log = formatTraceForLog(ctx);
    expect(log.trace_flags).toBe('00');
  });
});
