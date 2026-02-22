/**
 * Unit Tests for Platform SDK Telemetry
 *
 * Tests queue-based telemetry message formatting and flushing.
 *
 * @module tests/unit/platform-sdk/telemetry
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  setTelemetryContext,
  getTelemetryContext,
  clearTelemetryContext,
  flushMetrics,
  reportUsage,
  type TelemetryContext,
} from '@littlebearapps/platform-sdk';
import { createMetricsAccumulator } from '@littlebearapps/platform-sdk';
import type { TelemetryMessage } from '@littlebearapps/platform-sdk';

// =============================================================================
// MOCK FACTORIES
// =============================================================================

function createMockQueue() {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    sendBatch: vi.fn().mockResolvedValue(undefined),
  } as unknown as Queue<TelemetryMessage>;
}

function createMockExecutionContext() {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil: vi.fn((promise: Promise<unknown>) => {
      promises.push(promise);
    }),
    passThroughOnException: vi.fn(),
    _promises: promises,
  } as unknown as ExecutionContext & { _promises: Promise<unknown>[] };
}

// =============================================================================
// TELEMETRY CONTEXT TESTS
// =============================================================================

describe('Telemetry Context Management', () => {
  it('stores and retrieves context', () => {
    const env = {};
    const context: TelemetryContext = {
      featureId: 'scout:ocr:process',
      metrics: createMetricsAccumulator(),
      startTime: Date.now(),
    };

    setTelemetryContext(env, context);
    const retrieved = getTelemetryContext(env);

    expect(retrieved).toBe(context);
  });

  it('returns undefined for untracked env', () => {
    const env = {};
    const retrieved = getTelemetryContext(env);

    expect(retrieved).toBeUndefined();
  });

  it('clears context', () => {
    const env = {};
    const context: TelemetryContext = {
      featureId: 'scout:ocr:process',
      metrics: createMetricsAccumulator(),
      startTime: Date.now(),
    };

    setTelemetryContext(env, context);
    clearTelemetryContext(env);
    const retrieved = getTelemetryContext(env);

    expect(retrieved).toBeUndefined();
  });

  it('uses WeakMap semantics (different objects have different contexts)', () => {
    const env1 = {};
    const env2 = {};
    const context1: TelemetryContext = {
      featureId: 'feature:one:a',
      metrics: createMetricsAccumulator(),
      startTime: Date.now(),
    };
    const context2: TelemetryContext = {
      featureId: 'feature:two:b',
      metrics: createMetricsAccumulator(),
      startTime: Date.now(),
    };

    setTelemetryContext(env1, context1);
    setTelemetryContext(env2, context2);

    expect(getTelemetryContext(env1)).toBe(context1);
    expect(getTelemetryContext(env2)).toBe(context2);
  });
});

// =============================================================================
// FLUSH METRICS TESTS
// =============================================================================

describe('flushMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends message to queue with correct format', async () => {
    const env = {};
    const queue = createMockQueue();
    const metrics = createMetricsAccumulator();
    metrics.d1Reads = 10;
    metrics.kvWrites = 5;

    const context: TelemetryContext = {
      featureId: 'scout:ocr:process',
      metrics,
      startTime: Date.now(),
      queue,
    };

    setTelemetryContext(env, context);
    await flushMetrics(env);

    expect(queue.send).toHaveBeenCalledTimes(1);
    const sentMessage = (queue.send as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as TelemetryMessage;

    expect(sentMessage.feature_key).toBe('scout:ocr:process');
    expect(sentMessage.project).toBe('scout');
    expect(sentMessage.category).toBe('ocr');
    expect(sentMessage.feature).toBe('process');
    expect(sentMessage.metrics.d1Reads).toBe(10);
    expect(sentMessage.metrics.kvWrites).toBe(5);
    expect(sentMessage.timestamp).toBeDefined();
  });

  it('excludes zero-value metrics', async () => {
    const env = {};
    const queue = createMockQueue();
    const metrics = createMetricsAccumulator();
    metrics.d1Reads = 5;
    // All other metrics are 0

    const context: TelemetryContext = {
      featureId: 'test:a:b',
      metrics,
      startTime: Date.now(),
      queue,
    };

    setTelemetryContext(env, context);
    await flushMetrics(env);

    const sentMessage = (queue.send as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as TelemetryMessage;

    expect(sentMessage.metrics.d1Reads).toBe(5);
    expect(sentMessage.metrics.d1Writes).toBeUndefined();
    expect(sentMessage.metrics.kvReads).toBeUndefined();
  });

  it('skips sending when no metrics to report', async () => {
    const env = {};
    const queue = createMockQueue();
    const metrics = createMetricsAccumulator();
    // All metrics are 0

    const context: TelemetryContext = {
      featureId: 'test:a:b',
      metrics,
      startTime: Date.now(),
      queue,
    };

    setTelemetryContext(env, context);
    await flushMetrics(env);

    expect(queue.send).not.toHaveBeenCalled();
  });

  it('clears context after flush', async () => {
    const env = {};
    const queue = createMockQueue();
    const metrics = createMetricsAccumulator();
    metrics.d1Reads = 1;

    const context: TelemetryContext = {
      featureId: 'test:a:b',
      metrics,
      startTime: Date.now(),
      queue,
    };

    setTelemetryContext(env, context);
    await flushMetrics(env);

    expect(getTelemetryContext(env)).toBeUndefined();
  });

  it('warns but does not throw when context is missing', async () => {
    const env = {};
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await flushMetrics(env); // Should not throw

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('uses waitUntil when context has ctx', async () => {
    const env = {};
    const queue = createMockQueue();
    const ctx = createMockExecutionContext();
    const metrics = createMetricsAccumulator();
    metrics.d1Reads = 1;

    const context: TelemetryContext = {
      featureId: 'test:a:b',
      metrics,
      startTime: Date.now(),
      queue,
      ctx,
    };

    setTelemetryContext(env, context);
    await flushMetrics(env);

    expect(ctx.waitUntil).toHaveBeenCalled();
  });

  it('handles missing queue gracefully', async () => {
    const env = {};
    const metrics = createMetricsAccumulator();
    metrics.d1Reads = 1;
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const context: TelemetryContext = {
      featureId: 'test:a:b',
      metrics,
      startTime: Date.now(),
      // No queue
    };

    setTelemetryContext(env, context);
    await flushMetrics(env); // Should not throw

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('handles queue errors gracefully', async () => {
    const env = {};
    const queue = createMockQueue();
    (queue.send as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Queue error'));
    const metrics = createMetricsAccumulator();
    metrics.d1Reads = 1;
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const context: TelemetryContext = {
      featureId: 'test:a:b',
      metrics,
      startTime: Date.now(),
      queue,
    };

    setTelemetryContext(env, context);
    await flushMetrics(env); // Should not throw

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// =============================================================================
// REPORT USAGE TESTS
// =============================================================================

describe('reportUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends message with correct format', async () => {
    const queue = createMockQueue();

    await reportUsage('brand-copilot:scanner:github', { d1Reads: 100, kvWrites: 50 }, queue);

    expect(queue.send).toHaveBeenCalledTimes(1);
    const sentMessage = (queue.send as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as TelemetryMessage;

    expect(sentMessage.feature_key).toBe('brand-copilot:scanner:github');
    expect(sentMessage.project).toBe('brand-copilot');
    expect(sentMessage.category).toBe('scanner');
    expect(sentMessage.feature).toBe('github');
    expect(sentMessage.metrics.d1Reads).toBe(100);
    expect(sentMessage.metrics.kvWrites).toBe(50);
  });

  it('skips sending when metrics are empty', async () => {
    const queue = createMockQueue();

    await reportUsage('test:a:b', {}, queue);

    expect(queue.send).not.toHaveBeenCalled();
  });

  it('uses waitUntil when ctx is provided', async () => {
    const queue = createMockQueue();
    const ctx = createMockExecutionContext();

    await reportUsage('test:a:b', { d1Reads: 1 }, queue, ctx);

    expect(ctx.waitUntil).toHaveBeenCalled();
  });

  it('throws on invalid feature ID format', async () => {
    const queue = createMockQueue();

    await expect(reportUsage('invalid-format', { d1Reads: 1 }, queue)).rejects.toThrow(
      'Invalid featureId format'
    );
  });

  it('throws on feature ID with wrong number of parts', async () => {
    const queue = createMockQueue();

    await expect(reportUsage('only:two', { d1Reads: 1 }, queue)).rejects.toThrow(
      'Invalid featureId format'
    );

    await expect(reportUsage('too:many:parts:here', { d1Reads: 1 }, queue)).rejects.toThrow(
      'Invalid featureId format'
    );
  });
});

// =============================================================================
// TELEMETRY MESSAGE FORMAT TESTS
// =============================================================================

describe('Telemetry Message Format', () => {
  it('includes timestamp in milliseconds', async () => {
    const env = {};
    const queue = createMockQueue();
    const metrics = createMetricsAccumulator();
    metrics.d1Reads = 1;

    const before = Date.now();

    const context: TelemetryContext = {
      featureId: 'test:a:b',
      metrics,
      startTime: Date.now(),
      queue,
    };

    setTelemetryContext(env, context);
    await flushMetrics(env);

    const after = Date.now();
    const sentMessage = (queue.send as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as TelemetryMessage;

    expect(sentMessage.timestamp).toBeGreaterThanOrEqual(before);
    expect(sentMessage.timestamp).toBeLessThanOrEqual(after);
  });

  it('parses feature ID into components correctly', async () => {
    const queue = createMockQueue();

    await reportUsage('my-project:my-category:my-feature', { d1Reads: 1 }, queue);

    const sentMessage = (queue.send as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as TelemetryMessage;

    expect(sentMessage.feature_key).toBe('my-project:my-category:my-feature');
    expect(sentMessage.project).toBe('my-project');
    expect(sentMessage.category).toBe('my-category');
    expect(sentMessage.feature).toBe('my-feature');
  });

  it('converts aiModelCounts Map to aiModelBreakdown object', async () => {
    const env = {};
    const queue = createMockQueue();
    const metrics = createMetricsAccumulator();
    metrics.aiRequests = 5;
    metrics.aiModelCounts.set('@cf/meta/llama-3.2-3b-instruct', 3);
    metrics.aiModelCounts.set('@cf/qwen/qwen2.5-coder-32b-instruct', 2);

    const context: TelemetryContext = {
      featureId: 'test:ai:models',
      metrics,
      startTime: Date.now(),
      queue,
    };

    setTelemetryContext(env, context);
    await flushMetrics(env);

    const sentMessage = (queue.send as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as TelemetryMessage;

    expect(sentMessage.metrics.aiRequests).toBe(5);
    expect(sentMessage.metrics.aiModelBreakdown).toBeDefined();
    expect(sentMessage.metrics.aiModelBreakdown!['@cf/meta/llama-3.2-3b-instruct']).toBe(3);
    expect(sentMessage.metrics.aiModelBreakdown!['@cf/qwen/qwen2.5-coder-32b-instruct']).toBe(2);
  });

  it('excludes aiModelBreakdown when Map is empty', async () => {
    const env = {};
    const queue = createMockQueue();
    const metrics = createMetricsAccumulator();
    metrics.aiRequests = 1;
    // aiModelCounts is empty Map (unusual but possible)

    const context: TelemetryContext = {
      featureId: 'test:ai:empty',
      metrics,
      startTime: Date.now(),
      queue,
    };

    setTelemetryContext(env, context);
    await flushMetrics(env);

    const sentMessage = (queue.send as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as TelemetryMessage;

    expect(sentMessage.metrics.aiRequests).toBe(1);
    expect(sentMessage.metrics.aiModelBreakdown).toBeUndefined();
  });

  it('calculates DO latency stats correctly', async () => {
    const env = {};
    const queue = createMockQueue();
    const metrics = createMetricsAccumulator();
    metrics.doRequests = 5;
    // Simulate 5 latency samples: 10, 20, 30, 40, 50 ms
    metrics.doLatencyMs = [10, 20, 30, 40, 50];
    metrics.doTotalLatencyMs = 150;

    const context: TelemetryContext = {
      featureId: 'test:do:latency',
      metrics,
      startTime: Date.now(),
      queue,
    };

    setTelemetryContext(env, context);
    await flushMetrics(env);

    const sentMessage = (queue.send as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as TelemetryMessage;

    expect(sentMessage.metrics.doRequests).toBe(5);
    expect(sentMessage.metrics.doAvgLatencyMs).toBe(30); // 150/5
    expect(sentMessage.metrics.doMaxLatencyMs).toBe(50);
    expect(sentMessage.metrics.doP99LatencyMs).toBe(50); // With 5 samples, p99 index is 4
  });

  it('excludes DO latency stats when no samples', async () => {
    const env = {};
    const queue = createMockQueue();
    const metrics = createMetricsAccumulator();
    metrics.doRequests = 1;
    // No latency samples (edge case)
    metrics.doLatencyMs = [];
    metrics.doTotalLatencyMs = 0;

    const context: TelemetryContext = {
      featureId: 'test:do:empty',
      metrics,
      startTime: Date.now(),
      queue,
    };

    setTelemetryContext(env, context);
    await flushMetrics(env);

    const sentMessage = (queue.send as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as TelemetryMessage;

    expect(sentMessage.metrics.doRequests).toBe(1);
    expect(sentMessage.metrics.doAvgLatencyMs).toBeUndefined();
    expect(sentMessage.metrics.doMaxLatencyMs).toBeUndefined();
    expect(sentMessage.metrics.doP99LatencyMs).toBeUndefined();
  });

  it('calculates p99 correctly with larger sample size', async () => {
    const env = {};
    const queue = createMockQueue();
    const metrics = createMetricsAccumulator();
    metrics.doRequests = 100;
    // 100 samples: 1, 2, 3, ..., 100 ms
    metrics.doLatencyMs = Array.from({ length: 100 }, (_, i) => i + 1);
    metrics.doTotalLatencyMs = 5050; // Sum of 1 to 100

    const context: TelemetryContext = {
      featureId: 'test:do:p99',
      metrics,
      startTime: Date.now(),
      queue,
    };

    setTelemetryContext(env, context);
    await flushMetrics(env);

    const sentMessage = (queue.send as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as TelemetryMessage;

    expect(sentMessage.metrics.doAvgLatencyMs).toBeCloseTo(50.5, 5);
    expect(sentMessage.metrics.doMaxLatencyMs).toBe(100);
    // p99 index = ceil(100 * 0.99) - 1 = 99 - 1 = 98, value at index 98 is 99
    expect(sentMessage.metrics.doP99LatencyMs).toBe(99);
  });
});
