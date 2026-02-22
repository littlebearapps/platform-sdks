/**
 * Unit Tests for Platform SDK Cron/Queue Budget Helpers
 *
 * Tests withCronBudget() and withQueueBudget() helper functions.
 *
 * @module tests/unit/platform-sdk/cron-queue-budget
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  withCronBudget,
  withQueueBudget,
  completeTracking,
  clearCircuitBreakerCache,
} from '@littlebearapps/platform-sdk';
import { getTelemetryContext } from '@littlebearapps/platform-sdk';
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

function createMockKV() {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ keys: [] }),
  } as unknown as KVNamespace;
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

function createMockEnv() {
  return {
    PLATFORM_CACHE: createMockKV(),
    PLATFORM_TELEMETRY: createMockQueue(),
    DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({ success: true }),
        all: vi.fn().mockResolvedValue({ results: [] }),
        first: vi.fn().mockResolvedValue(null),
      })),
    } as unknown as D1Database,
  };
}

// =============================================================================
// SETUP
// =============================================================================

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-31T12:00:00.000Z'));
  clearCircuitBreakerCache();
});

afterEach(() => {
  vi.useRealTimers();
});

// =============================================================================
// withCronBudget TESTS
// =============================================================================

describe('withCronBudget', () => {
  it('generates correlation ID from cron expression', () => {
    const env = createMockEnv();
    const ctx = createMockExecutionContext();

    const trackedEnv = withCronBudget(env, 'platform:cron:cleanup', {
      ctx,
      cronExpression: '0 0 * * *',
    });

    const telemetryCtx = getTelemetryContext(trackedEnv);
    expect(telemetryCtx).toBeDefined();
    expect(telemetryCtx!.correlationId).toMatch(/^cron:0-0-\*-\*-\*:\d+$/);
  });

  it('generates manual correlation ID without cron expression', () => {
    const env = createMockEnv();
    const ctx = createMockExecutionContext();

    const trackedEnv = withCronBudget(env, 'platform:cron:cleanup', {
      ctx,
    });

    const telemetryCtx = getTelemetryContext(trackedEnv);
    expect(telemetryCtx).toBeDefined();
    expect(telemetryCtx!.correlationId).toMatch(/^cron:manual:\d+$/);
  });

  it('passes ctx to withFeatureBudget', () => {
    const env = createMockEnv();
    const ctx = createMockExecutionContext();

    const trackedEnv = withCronBudget(env, 'platform:cron:cleanup', {
      ctx,
      cronExpression: '0 * * * *',
    });

    const telemetryCtx = getTelemetryContext(trackedEnv);
    expect(telemetryCtx).toBeDefined();
    expect(telemetryCtx!.ctx).toBe(ctx);
  });

  it('passes externalCostUsd through', () => {
    const env = createMockEnv();
    const ctx = createMockExecutionContext();

    const trackedEnv = withCronBudget(env, 'platform:cron:cleanup', {
      ctx,
      cronExpression: '0 0 * * *',
      externalCostUsd: 0.05,
    });

    const telemetryCtx = getTelemetryContext(trackedEnv);
    expect(telemetryCtx).toBeDefined();
    expect(telemetryCtx!.externalCostUsd).toBe(0.05);
  });

  it('returns a proxied environment', async () => {
    const env = createMockEnv();
    const ctx = createMockExecutionContext();

    const trackedEnv = withCronBudget(env, 'platform:cron:cleanup', {
      ctx,
      cronExpression: '0 0 * * *',
    });

    // Verify it has the health method from TrackedEnv
    expect(typeof trackedEnv.health).toBe('function');
  });

  it('handles complex cron expressions', () => {
    const env = createMockEnv();
    const ctx = createMockExecutionContext();

    const trackedEnv = withCronBudget(env, 'platform:cron:audit', {
      ctx,
      cronExpression: '0 6 * * 1', // Weekly on Monday at 6am
    });

    const telemetryCtx = getTelemetryContext(trackedEnv);
    expect(telemetryCtx!.correlationId).toMatch(/^cron:0-6-\*-\*-1:\d+$/);
  });
});

// =============================================================================
// withQueueBudget TESTS
// =============================================================================

describe('withQueueBudget', () => {
  it('extracts correlation ID from message body', () => {
    const env = createMockEnv();

    const message = {
      correlation_id: 'existing-correlation-123',
      data: 'some payload',
    };

    const trackedEnv = withQueueBudget(env, 'platform:queue:process', {
      message,
      queueName: 'platform-telemetry',
    });

    const telemetryCtx = getTelemetryContext(trackedEnv);
    expect(telemetryCtx).toBeDefined();
    expect(telemetryCtx!.correlationId).toBe('existing-correlation-123');
  });

  it('generates correlation ID when not in message', () => {
    const env = createMockEnv();

    const message = {
      data: 'some payload without correlation',
    };

    const trackedEnv = withQueueBudget(env, 'platform:queue:process', {
      message,
      queueName: 'platform-telemetry',
    });

    const telemetryCtx = getTelemetryContext(trackedEnv);
    expect(telemetryCtx).toBeDefined();
    expect(telemetryCtx!.correlationId).toMatch(/^queue:platform-telemetry:\d+:[a-z0-9]+$/);
  });

  it('uses "unknown" queue name when not provided', () => {
    const env = createMockEnv();

    const trackedEnv = withQueueBudget(env, 'platform:queue:process', {
      message: { data: 'test' },
    });

    const telemetryCtx = getTelemetryContext(trackedEnv);
    expect(telemetryCtx!.correlationId).toMatch(/^queue:unknown:\d+:[a-z0-9]+$/);
  });

  it('handles null/undefined message gracefully', () => {
    const env = createMockEnv();

    const trackedEnv = withQueueBudget(env, 'platform:queue:process', {
      queueName: 'my-queue',
    });

    const telemetryCtx = getTelemetryContext(trackedEnv);
    expect(telemetryCtx!.correlationId).toMatch(/^queue:my-queue:\d+:[a-z0-9]+$/);
  });

  it('handles primitive message types gracefully', () => {
    const env = createMockEnv();

    // Message is a string, not an object
    const trackedEnv = withQueueBudget(env, 'platform:queue:process', {
      message: 'just a string' as unknown,
      queueName: 'string-queue',
    });

    const telemetryCtx = getTelemetryContext(trackedEnv);
    expect(telemetryCtx!.correlationId).toMatch(/^queue:string-queue:\d+:[a-z0-9]+$/);
  });

  it('passes externalCostUsd through', () => {
    const env = createMockEnv();

    const trackedEnv = withQueueBudget(env, 'platform:queue:process', {
      message: { data: 'test' },
      queueName: 'my-queue',
      externalCostUsd: 0.1,
    });

    const telemetryCtx = getTelemetryContext(trackedEnv);
    expect(telemetryCtx!.externalCostUsd).toBe(0.1);
  });

  it('returns a proxied environment', () => {
    const env = createMockEnv();

    const trackedEnv = withQueueBudget(env, 'platform:queue:process', {
      message: { data: 'test' },
    });

    expect(typeof trackedEnv.health).toBe('function');
  });

  it('works with empty options', () => {
    const env = createMockEnv();

    const trackedEnv = withQueueBudget(env, 'platform:queue:process');

    const telemetryCtx = getTelemetryContext(trackedEnv);
    expect(telemetryCtx).toBeDefined();
    expect(telemetryCtx!.correlationId).toMatch(/^queue:unknown:\d+:[a-z0-9]+$/);
  });
});

// =============================================================================
// INTEGRATION TESTS
// =============================================================================

describe('Cron/Queue Budget Integration', () => {
  it('cron handler telemetry context has correct correlation ID format', () => {
    const env = createMockEnv();
    const ctx = createMockExecutionContext();

    const trackedEnv = withCronBudget(env, 'platform:cron:cleanup', {
      ctx,
      cronExpression: '0 0 * * *',
    });

    // Verify telemetry context is set correctly
    const telemetryCtx = getTelemetryContext(trackedEnv);
    expect(telemetryCtx).toBeDefined();
    expect(telemetryCtx!.featureId).toBe('platform:cron:cleanup');
    expect(telemetryCtx!.correlationId).toMatch(/^cron:0-0-\*-\*-\*:\d+$/);
    expect(telemetryCtx!.ctx).toBe(ctx);
  });

  it('queue handler preserves correlation ID from message', () => {
    const env = createMockEnv();

    const message = {
      correlation_id: 'original-request-123',
      task: 'process-data',
    };

    const trackedEnv = withQueueBudget(env, 'platform:queue:process', {
      message,
      queueName: 'task-queue',
    });

    // Verify telemetry context has the preserved correlation ID
    const telemetryCtx = getTelemetryContext(trackedEnv);
    expect(telemetryCtx).toBeDefined();
    expect(telemetryCtx!.featureId).toBe('platform:queue:process');
    expect(telemetryCtx!.correlationId).toBe('original-request-123');
  });

  it('withCronBudget and withQueueBudget both return TrackedEnv', () => {
    const env = createMockEnv();
    const ctx = createMockExecutionContext();

    const cronTracked = withCronBudget(env, 'platform:cron:test', { ctx });
    const queueTracked = withQueueBudget(env, 'platform:queue:test', {});

    // Both should have health() method from TrackedEnv
    expect(typeof cronTracked.health).toBe('function');
    expect(typeof queueTracked.health).toBe('function');

    // Both should expose original bindings
    expect(cronTracked.DB).toBeDefined();
    expect(queueTracked.DB).toBeDefined();
  });
});
