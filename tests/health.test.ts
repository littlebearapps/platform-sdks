/**
 * Unit Tests for Platform SDK Health Check
 *
 * Tests the health() method on TrackedEnv returned by withFeatureBudget().
 *
 * @module tests/unit/platform-sdk/health
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  withFeatureBudget,
  health,
  clearCircuitBreakerCache,
} from '@littlebearapps/platform-sdk';
import { KV_KEYS, CIRCUIT_STATUS } from '@littlebearapps/platform-sdk';
import type { TelemetryMessage } from '@littlebearapps/platform-sdk';

// =============================================================================
// MOCK KV NAMESPACE
// =============================================================================

function createMockKV() {
  const store = new Map<string, string>();

  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    put: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    delete: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
    list: vi.fn(() => Promise.resolve({ keys: [], list_complete: true })),
    _store: store,
  } as unknown as KVNamespace & { _store: Map<string, string> };
}

// =============================================================================
// MOCK QUEUE
// =============================================================================

function createMockQueue() {
  const messages: TelemetryMessage[] = [];

  return {
    send: vi.fn((msg: TelemetryMessage) => {
      messages.push(msg);
      return Promise.resolve();
    }),
    sendBatch: vi.fn((msgs: { body: TelemetryMessage }[]) => {
      messages.push(...msgs.map((m) => m.body));
      return Promise.resolve();
    }),
    _messages: messages,
  } as unknown as Queue<TelemetryMessage> & { _messages: TelemetryMessage[] };
}

// =============================================================================
// HEALTH() STANDALONE FUNCTION TESTS
// =============================================================================

describe('health() function', () => {
  let mockKV: ReturnType<typeof createMockKV>;
  let mockQueue: ReturnType<typeof createMockQueue>;

  beforeEach(() => {
    mockKV = createMockKV();
    mockQueue = createMockQueue();
    clearCircuitBreakerCache();
  });

  it('returns healthy when KV is accessible and no circuit breakers are set', async () => {
    const result = await health('test:category:feature', mockKV, mockQueue);

    expect(result.healthy).toBe(true);
    expect(result.controlPlane.healthy).toBe(true);
    expect(result.controlPlane.status).toBe('GO');
    expect(result.dataPlane.healthy).toBe(true);
    expect(result.dataPlane.queueSent).toBe(true);
    expect(result.project).toBe('test');
    expect(result.feature).toBe('test:category:feature');
  });

  it('detects STOP status from feature circuit breaker', async () => {
    mockKV._store.set(KV_KEYS.featureStatus('test:category:feature'), CIRCUIT_STATUS.STOP);

    const result = await health('test:category:feature', mockKV, mockQueue);

    expect(result.healthy).toBe(true); // Health check itself succeeds
    expect(result.controlPlane.healthy).toBe(true);
    expect(result.controlPlane.status).toBe('STOP'); // But status shows STOP
  });

  it('detects STOP status from project circuit breaker', async () => {
    mockKV._store.set(KV_KEYS.projectStatus('test'), CIRCUIT_STATUS.STOP);

    const result = await health('test:category:feature', mockKV, mockQueue);

    expect(result.controlPlane.status).toBe('STOP');
  });

  it('detects STOP status from global circuit breaker', async () => {
    mockKV._store.set(KV_KEYS.globalStatus(), CIRCUIT_STATUS.STOP);

    const result = await health('test:category:feature', mockKV, mockQueue);

    expect(result.controlPlane.status).toBe('STOP');
  });

  it('sends heartbeat message to queue', async () => {
    await health('test:category:feature', mockKV, mockQueue);

    expect(mockQueue.send).toHaveBeenCalledTimes(1);
    const sentMsg = mockQueue._messages[0];
    expect(sentMsg.is_heartbeat).toBe(true);
    expect(sentMsg.feature_key).toBe('test:category:feature');
    expect(sentMsg.project).toBe('test');
    expect(sentMsg.category).toBe('category');
    expect(sentMsg.feature).toBe('feature');
  });

  it('handles KV failure gracefully', async () => {
    const failingKV = {
      get: vi.fn(() => Promise.reject(new Error('KV unavailable'))),
      put: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    } as unknown as KVNamespace;

    const result = await health('test:category:feature', failingKV, mockQueue);

    expect(result.healthy).toBe(false);
    expect(result.controlPlane.healthy).toBe(false);
    expect(result.controlPlane.status).toBe('UNKNOWN');
    expect(result.controlPlane.error).toContain('KV unavailable');
  });

  it('handles queue failure gracefully', async () => {
    const failingQueue = {
      send: vi.fn(() => Promise.reject(new Error('Queue unavailable'))),
      sendBatch: vi.fn(),
    } as unknown as Queue<TelemetryMessage>;

    const result = await health('test:category:feature', mockKV, failingQueue);

    expect(result.healthy).toBe(false);
    expect(result.controlPlane.healthy).toBe(true);
    expect(result.dataPlane.healthy).toBe(false);
    expect(result.dataPlane.queueSent).toBe(false);
    expect(result.dataPlane.error).toContain('Queue unavailable');
  });

  it('works without queue (data plane skipped)', async () => {
    const result = await health('test:category:feature', mockKV);

    expect(result.healthy).toBe(true);
    expect(result.controlPlane.healthy).toBe(true);
    expect(result.dataPlane.healthy).toBe(true);
    expect(result.dataPlane.queueSent).toBe(false);
  });
});

// =============================================================================
// trackedEnv.health() METHOD TESTS
// =============================================================================

describe('trackedEnv.health() method', () => {
  let mockKV: ReturnType<typeof createMockKV>;
  let mockQueue: ReturnType<typeof createMockQueue>;

  beforeEach(() => {
    mockKV = createMockKV();
    mockQueue = createMockQueue();
    clearCircuitBreakerCache();
  });

  it('exposes health() method on tracked environment', () => {
    const env = {
      PLATFORM_CACHE: mockKV,
      PLATFORM_TELEMETRY: mockQueue,
    };

    const trackedEnv = withFeatureBudget(env, 'test:category:feature', {
      checkCircuitBreaker: false,
      reportTelemetry: false,
    });

    expect(typeof trackedEnv.health).toBe('function');
  });

  it('health() method returns HealthResult', async () => {
    const env = {
      PLATFORM_CACHE: mockKV,
      PLATFORM_TELEMETRY: mockQueue,
    };

    const trackedEnv = withFeatureBudget(env, 'test:category:feature', {
      checkCircuitBreaker: false,
      reportTelemetry: false,
    });

    const result = await trackedEnv.health();

    expect(result).toHaveProperty('healthy');
    expect(result).toHaveProperty('controlPlane');
    expect(result).toHaveProperty('dataPlane');
    expect(result).toHaveProperty('project');
    expect(result).toHaveProperty('feature');
    expect(result).toHaveProperty('timestamp');
  });

  it('health() uses correct featureId from withFeatureBudget', async () => {
    const env = {
      PLATFORM_CACHE: mockKV,
      PLATFORM_TELEMETRY: mockQueue,
    };

    const trackedEnv = withFeatureBudget(env, 'my-project:my-category:my-feature', {
      checkCircuitBreaker: false,
      reportTelemetry: false,
    });

    const result = await trackedEnv.health();

    expect(result.project).toBe('my-project');
    expect(result.feature).toBe('my-project:my-category:my-feature');
  });

  it('health() detects circuit breaker status', async () => {
    mockKV._store.set(KV_KEYS.featureStatus('test:category:feature'), CIRCUIT_STATUS.STOP);

    const env = {
      PLATFORM_CACHE: mockKV,
      PLATFORM_TELEMETRY: mockQueue,
    };

    const trackedEnv = withFeatureBudget(env, 'test:category:feature', {
      checkCircuitBreaker: false, // Don't throw, just check
      reportTelemetry: false,
    });

    const result = await trackedEnv.health();

    expect(result.controlPlane.status).toBe('STOP');
  });

  it('health() sends heartbeat to queue', async () => {
    const env = {
      PLATFORM_CACHE: mockKV,
      PLATFORM_TELEMETRY: mockQueue,
    };

    const trackedEnv = withFeatureBudget(env, 'test:category:feature', {
      checkCircuitBreaker: false,
      reportTelemetry: false,
    });

    await trackedEnv.health();

    expect(mockQueue.send).toHaveBeenCalledTimes(1);
    const sentMsg = mockQueue._messages[0];
    expect(sentMsg.is_heartbeat).toBe(true);
  });
});
