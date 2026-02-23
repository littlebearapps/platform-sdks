import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TimeoutError,
  DEFAULT_TIMEOUTS,
  withTimeout,
  withTrackedTimeout,
  timeoutResponse,
  isTimeoutError,
  withRequestTimeout,
} from '../src/timeout';

// Mock the errors module
vi.mock('../src/errors', () => ({
  reportErrorExplicit: vi.fn(),
}));

import { reportErrorExplicit } from '../src/errors';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// =============================================================================
// TimeoutError
// =============================================================================

describe('TimeoutError', () => {
  it('extends Error', () => {
    const err = new TimeoutError('test_op', 5000, 5001);
    expect(err).toBeInstanceOf(Error);
  });

  it('has name TimeoutError', () => {
    const err = new TimeoutError('test_op', 5000, 5001);
    expect(err.name).toBe('TimeoutError');
  });

  it('has operation property', () => {
    const err = new TimeoutError('fetch_api', 5000, 5001);
    expect(err.operation).toBe('fetch_api');
  });

  it('has timeoutMs property', () => {
    const err = new TimeoutError('test_op', 3000, 3001);
    expect(err.timeoutMs).toBe(3000);
  });

  it('has actualMs property', () => {
    const err = new TimeoutError('test_op', 5000, 4999);
    expect(err.actualMs).toBe(4999);
  });

  it('creates descriptive message', () => {
    const err = new TimeoutError('slow_query', 10000, 10001);
    expect(err.message).toBe("Operation 'slow_query' timed out after 10000ms");
  });
});

// =============================================================================
// DEFAULT_TIMEOUTS
// =============================================================================

describe('DEFAULT_TIMEOUTS', () => {
  it('has short = 5000ms', () => {
    expect(DEFAULT_TIMEOUTS.short).toBe(5000);
  });

  it('has medium = 15000ms', () => {
    expect(DEFAULT_TIMEOUTS.medium).toBe(15000);
  });

  it('has long = 30000ms', () => {
    expect(DEFAULT_TIMEOUTS.long).toBe(30000);
  });

  it('has max = 60000ms', () => {
    expect(DEFAULT_TIMEOUTS.max).toBe(60000);
  });
});

// =============================================================================
// withTimeout
// =============================================================================

describe('withTimeout', () => {
  it('resolves when function completes within timeout', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const resultPromise = withTimeout(fn, 5000, 'test');
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;
    expect(result).toBe('success');
  });

  it('throws TimeoutError when function exceeds timeout', async () => {
    const fn = () =>
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('too late'), 10000);
      });

    const resultPromise = withTimeout(fn, 5000, 'slow_op');
    // Attach rejection handler BEFORE advancing timers to avoid unhandled rejection
    const assertion = expect(resultPromise).rejects.toThrow(TimeoutError);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it('includes operation name in timeout message', async () => {
    const fn = () =>
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('done'), 40000);
      });

    const resultPromise = withTimeout(fn, 30000, 'slow_op');
    const assertion = expect(resultPromise).rejects.toThrow("Operation 'slow_op' timed out after 30000ms");
    await vi.advanceTimersByTimeAsync(30000);
    await assertion;
  });

  it('uses default timeout of 30000ms', async () => {
    const fn = () =>
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('done'), 40000);
      });

    const resultPromise = withTimeout(fn);
    const assertion = expect(resultPromise).rejects.toThrow(TimeoutError);
    await vi.advanceTimersByTimeAsync(30000);
    await assertion;
  });

  it('uses default operation name "operation"', async () => {
    const fn = () =>
      new Promise<never>((resolve) => {
        setTimeout(resolve, 40000);
      });

    const resultPromise = withTimeout(fn);
    const assertion = expect(resultPromise).rejects.toThrow("Operation 'operation' timed out after 30000ms");
    await vi.advanceTimersByTimeAsync(30000);
    await assertion;
  });

  it('propagates non-timeout errors from fn', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('internal error'));
    const resultPromise = withTimeout(fn, 5000, 'test');
    const assertion = expect(resultPromise).rejects.toThrow('internal error');
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
  });

  it('returns typed result from fn', async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const resultPromise = withTimeout<number>(fn, 5000);
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;
    expect(typeof result).toBe('number');
    expect(result).toBe(42);
  });
});

// =============================================================================
// withTrackedTimeout
// =============================================================================

describe('withTrackedTimeout', () => {
  it('returns result on success', async () => {
    const env = {};
    const fn = vi.fn().mockResolvedValue('ok');
    const resultPromise = withTrackedTimeout(env, fn, 5000, 'test');
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;
    expect(result).toBe('ok');
    expect(reportErrorExplicit).not.toHaveBeenCalled();
  });

  it('reports error on timeout', async () => {
    const env = {};
    const fn = () =>
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('late'), 10000);
      });

    const resultPromise = withTrackedTimeout(env, fn, 5000, 'db_query');
    const assertion = expect(resultPromise).rejects.toThrow(TimeoutError);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    expect(reportErrorExplicit).toHaveBeenCalledWith(env, 'TIMEOUT', 'TIMEOUT_DB_QUERY');
  });

  it('uppercases operation name in error code', async () => {
    const env = {};
    const fn = () =>
      new Promise<never>((resolve) => {
        setTimeout(resolve, 10000);
      });

    const resultPromise = withTrackedTimeout(env, fn, 5000, 'fetch_api');
    const assertion = expect(resultPromise).rejects.toThrow(TimeoutError);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    expect(reportErrorExplicit).toHaveBeenCalledWith(env, 'TIMEOUT', 'TIMEOUT_FETCH_API');
  });

  it('does not report non-timeout errors', async () => {
    const env = {};
    const fn = vi.fn().mockRejectedValue(new Error('bad'));
    const resultPromise = withTrackedTimeout(env, fn, 5000);
    const assertion = expect(resultPromise).rejects.toThrow('bad');
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
    expect(reportErrorExplicit).not.toHaveBeenCalled();
  });
});

// =============================================================================
// timeoutResponse
// =============================================================================

describe('timeoutResponse', () => {
  it('returns 504 status', () => {
    const response = timeoutResponse();
    expect(response.status).toBe(504);
  });

  it('returns JSON content type', () => {
    const response = timeoutResponse();
    expect(response.headers.get('Content-Type')).toBe('application/json');
  });

  it('includes error and code in body', async () => {
    const response = timeoutResponse();
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe('Gateway Timeout');
    expect(body.code).toBe('TIMEOUT');
  });

  it('includes operation and timeout_ms when error provided', async () => {
    const err = new TimeoutError('slow_api', 10000, 10001);
    const response = timeoutResponse(err);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.operation).toBe('slow_api');
    expect(body.timeout_ms).toBe(10000);
  });

  it('operation and timeout_ms are undefined when no error', async () => {
    const response = timeoutResponse();
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.operation).toBeUndefined();
    expect(body.timeout_ms).toBeUndefined();
  });
});

// =============================================================================
// isTimeoutError
// =============================================================================

describe('isTimeoutError', () => {
  it('returns true for TimeoutError', () => {
    expect(isTimeoutError(new TimeoutError('test', 1000, 1001))).toBe(true);
  });

  it('returns false for regular Error', () => {
    expect(isTimeoutError(new Error('not timeout'))).toBe(false);
  });

  it('returns false for string', () => {
    expect(isTimeoutError('timeout')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isTimeoutError(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isTimeoutError(undefined)).toBe(false);
  });
});

// =============================================================================
// withRequestTimeout
// =============================================================================

describe('withRequestTimeout', () => {
  it('returns wrapped handler function', () => {
    const handler = vi.fn().mockResolvedValue(new Response('OK'));
    const wrapped = withRequestTimeout(handler);
    expect(typeof wrapped).toBe('function');
  });

  it('passes request, env, ctx to original handler', async () => {
    const handler = vi.fn().mockResolvedValue(new Response('OK'));
    const wrapped = withRequestTimeout(handler, 5000, 'test');
    const request = new Request('https://example.com');
    const env = { DB: {} };
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

    const resultPromise = wrapped(request, env, ctx);
    await vi.advanceTimersByTimeAsync(0);
    await resultPromise;

    expect(handler).toHaveBeenCalledWith(request, env, ctx);
  });

  it('returns handler response on success', async () => {
    const handler = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
    const wrapped = withRequestTimeout(handler, 5000);

    const resultPromise = wrapped(
      new Request('https://example.com'),
      {},
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext
    );
    await vi.advanceTimersByTimeAsync(0);
    const response = await resultPromise;

    expect(response.status).toBe(200);
  });

  it('returns 504 on timeout', async () => {
    const handler = () =>
      new Promise<Response>((resolve) => {
        setTimeout(() => resolve(new Response('late')), 10000);
      });
    const wrapped = withRequestTimeout(handler, 5000, 'api');

    const resultPromise = wrapped(
      new Request('https://example.com'),
      {},
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext
    );
    await vi.advanceTimersByTimeAsync(5000);
    const response = await resultPromise;

    expect(response.status).toBe(504);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe('TIMEOUT');
  });

  it('propagates non-timeout errors', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('db crashed'));
    const wrapped = withRequestTimeout(handler, 5000);

    const resultPromise = wrapped(
      new Request('https://example.com'),
      {},
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext
    );
    const assertion = expect(resultPromise).rejects.toThrow('db crashed');
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
  });
});
