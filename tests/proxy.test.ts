/**
 * Unit Tests for Platform SDK Proxy
 *
 * Tests resource detection and metric interception for D1, KV, AI, and Vectorize.
 *
 * @module tests/unit/platform-sdk/proxy
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createD1Proxy,
  createKVProxy,
  createAIProxy,
  createVectorizeProxy,
  createEnvProxy,
  isD1Database,
  isKVNamespace,
  isAIBinding,
  isVectorizeIndex,
} from '@littlebearapps/platform-sdk';
import { createMetricsAccumulator } from '@littlebearapps/platform-sdk';

// =============================================================================
// MOCK FACTORIES
// =============================================================================

function createMockD1Database() {
  const mockStatement = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({
      success: true,
      meta: { changes: 1, rows_read: 0 },
      results: [],
    }),
    all: vi.fn().mockResolvedValue({
      success: true,
      meta: { changes: 0, rows_read: 5 },
      results: [{ id: 1 }, { id: 2 }],
    }),
    first: vi.fn().mockResolvedValue({ id: 1 }),
    raw: vi.fn().mockResolvedValue([]),
  };

  return {
    prepare: vi.fn().mockReturnValue(mockStatement),
    batch: vi
      .fn()
      .mockResolvedValue([{ success: true, meta: { changes: 2, rows_read: 10 }, results: [] }]),
    dump: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
    exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
    _statement: mockStatement,
  } as unknown as D1Database & { _statement: typeof mockStatement };
}

function createMockKVNamespace() {
  return {
    get: vi.fn().mockResolvedValue('value'),
    getWithMetadata: vi.fn().mockResolvedValue({ value: 'value', metadata: {} }),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ keys: [], list_complete: true, cursor: '' }),
  } as unknown as KVNamespace;
}

function createMockAI() {
  return {
    run: vi.fn().mockResolvedValue({ response: 'AI response' }),
  } as unknown as Ai;
}

function createMockVectorize() {
  return {
    query: vi.fn().mockResolvedValue({ matches: [] }),
    insert: vi.fn().mockResolvedValue({ mutationId: '123' }),
    upsert: vi.fn().mockResolvedValue({ mutationId: '456' }),
    deleteByIds: vi.fn().mockResolvedValue({ mutationId: '789' }),
    getByIds: vi.fn().mockResolvedValue({ vectors: [] }),
    describe: vi.fn().mockResolvedValue({ dimensions: 768, count: 100 }),
  } as unknown as VectorizeIndex;
}

// =============================================================================
// TYPE GUARD TESTS
// =============================================================================

describe('Type Guards', () => {
  describe('isD1Database', () => {
    it('returns true for D1 database objects', () => {
      const db = createMockD1Database();
      expect(isD1Database(db)).toBe(true);
    });

    it('returns false for KV namespace', () => {
      const kv = createMockKVNamespace();
      expect(isD1Database(kv)).toBe(false);
    });

    it('returns false for null', () => {
      expect(isD1Database(null)).toBe(false);
    });

    it('returns false for primitive values', () => {
      expect(isD1Database('string')).toBe(false);
      expect(isD1Database(123)).toBe(false);
    });
  });

  describe('isKVNamespace', () => {
    it('returns true for KV namespace objects', () => {
      const kv = createMockKVNamespace();
      expect(isKVNamespace(kv)).toBe(true);
    });

    it('returns false for D1 database (has prepare)', () => {
      const db = createMockD1Database();
      expect(isKVNamespace(db)).toBe(false);
    });
  });

  describe('isAIBinding', () => {
    it('returns true for AI binding objects', () => {
      const ai = createMockAI();
      expect(isAIBinding(ai)).toBe(true);
    });

    it('returns false for non-AI objects', () => {
      expect(isAIBinding({ notRun: () => {} })).toBe(false);
    });
  });

  describe('isVectorizeIndex', () => {
    it('returns true for Vectorize index objects', () => {
      const vectorize = createMockVectorize();
      expect(isVectorizeIndex(vectorize)).toBe(true);
    });

    it('returns false for partial objects', () => {
      expect(isVectorizeIndex({ query: vi.fn() })).toBe(false);
    });
  });
});

// =============================================================================
// D1 PROXY TESTS
// =============================================================================

describe('D1 Proxy', () => {
  it('tracks writes from run()', async () => {
    const db = createMockD1Database();
    const metrics = createMetricsAccumulator();
    const proxied = createD1Proxy(db, metrics);

    await proxied.prepare('INSERT INTO test VALUES (?)').bind('value').run();

    expect(metrics.d1Writes).toBe(1);
    expect(metrics.d1RowsWritten).toBe(1);
  });

  it('tracks reads from all()', async () => {
    const db = createMockD1Database();
    const metrics = createMetricsAccumulator();
    const proxied = createD1Proxy(db, metrics);

    await proxied.prepare('SELECT * FROM test').all();

    expect(metrics.d1Reads).toBe(5);
    expect(metrics.d1RowsRead).toBe(5);
  });

  it('tracks batch operations', async () => {
    const db = createMockD1Database();
    const metrics = createMetricsAccumulator();
    const proxied = createD1Proxy(db, metrics);

    await proxied.batch([db.prepare('INSERT'), db.prepare('INSERT')]);

    expect(metrics.d1Writes).toBe(2);
    expect(metrics.d1Reads).toBe(10);
  });

  it('handles statement chaining with bind()', async () => {
    const db = createMockD1Database();
    const metrics = createMetricsAccumulator();
    const proxied = createD1Proxy(db, metrics);

    // Chain multiple operations
    const stmt = proxied.prepare('SELECT * FROM test WHERE id = ?');
    const bound = stmt.bind(1);
    await bound.all();

    expect(metrics.d1Reads).toBe(5);
  });

  it('tracks dump() as a read', async () => {
    const db = createMockD1Database();
    const metrics = createMetricsAccumulator();
    const proxied = createD1Proxy(db, metrics);

    await proxied.dump();

    expect(metrics.d1Reads).toBe(1);
  });
});

// =============================================================================
// KV PROXY TESTS
// =============================================================================

describe('KV Proxy', () => {
  it('tracks get() as read', async () => {
    const kv = createMockKVNamespace();
    const metrics = createMetricsAccumulator();
    const proxied = createKVProxy(kv, metrics);

    await proxied.get('key');

    expect(metrics.kvReads).toBe(1);
  });

  it('tracks getWithMetadata() as read', async () => {
    const kv = createMockKVNamespace();
    const metrics = createMetricsAccumulator();
    const proxied = createKVProxy(kv, metrics);

    await proxied.getWithMetadata('key');

    expect(metrics.kvReads).toBe(1);
  });

  it('tracks put() as write', async () => {
    const kv = createMockKVNamespace();
    const metrics = createMetricsAccumulator();
    const proxied = createKVProxy(kv, metrics);

    await proxied.put('key', 'value');

    expect(metrics.kvWrites).toBe(1);
  });

  it('tracks delete() as delete', async () => {
    const kv = createMockKVNamespace();
    const metrics = createMetricsAccumulator();
    const proxied = createKVProxy(kv, metrics);

    await proxied.delete('key');

    expect(metrics.kvDeletes).toBe(1);
  });

  it('tracks list() as list', async () => {
    const kv = createMockKVNamespace();
    const metrics = createMetricsAccumulator();
    const proxied = createKVProxy(kv, metrics);

    await proxied.list();

    expect(metrics.kvLists).toBe(1);
  });

  it('accumulates multiple operations', async () => {
    const kv = createMockKVNamespace();
    const metrics = createMetricsAccumulator();
    const proxied = createKVProxy(kv, metrics);

    await proxied.get('key1');
    await proxied.get('key2');
    await proxied.put('key3', 'value');
    await proxied.delete('key4');

    expect(metrics.kvReads).toBe(2);
    expect(metrics.kvWrites).toBe(1);
    expect(metrics.kvDeletes).toBe(1);
  });
});

// =============================================================================
// AI PROXY TESTS
// =============================================================================

describe('AI Proxy', () => {
  it('tracks run() calls', async () => {
    const ai = createMockAI();
    const metrics = createMetricsAccumulator();
    const proxied = createAIProxy(ai, metrics);

    await proxied.run('@cf/meta/llama-2-7b-chat-int8', { prompt: 'Hello' });

    expect(metrics.aiRequests).toBe(1);
  });

  it('accumulates multiple AI calls', async () => {
    const ai = createMockAI();
    const metrics = createMetricsAccumulator();
    const proxied = createAIProxy(ai, metrics);

    await proxied.run('@cf/meta/llama-2-7b-chat-int8', { prompt: 'Hello' });
    await proxied.run('@cf/meta/llama-2-7b-chat-int8', { prompt: 'World' });

    expect(metrics.aiRequests).toBe(2);
  });

  it('tracks per-model breakdown with string model name', async () => {
    const ai = createMockAI();
    const metrics = createMetricsAccumulator();
    const proxied = createAIProxy(ai, metrics);

    await proxied.run('@cf/meta/llama-3.2-3b-instruct', { prompt: 'Hello' });
    await proxied.run('@cf/meta/llama-3.2-3b-instruct', { prompt: 'World' });
    await proxied.run('@cf/openai/whisper-tiny-en', { audio: [] });

    expect(metrics.aiRequests).toBe(3);
    expect(metrics.aiModelCounts.get('@cf/meta/llama-3.2-3b-instruct')).toBe(2);
    expect(metrics.aiModelCounts.get('@cf/openai/whisper-tiny-en')).toBe(1);
  });

  it('tracks per-model breakdown with object model name', async () => {
    const ai = createMockAI();
    const metrics = createMetricsAccumulator();
    const proxied = createAIProxy(ai, metrics);

    // Some AI models can be passed as objects with a name property
    await proxied.run(
      // @ts-expect-error - Testing object model format that proxy handles but Ai type doesn't reflect
      { name: '@cf/stabilityai/stable-diffusion-xl-base-1.0' },
      {
        prompt: 'A cat',
      }
    );

    expect(metrics.aiRequests).toBe(1);
    expect(metrics.aiModelCounts.get('@cf/stabilityai/stable-diffusion-xl-base-1.0')).toBe(1);
  });

  it('accumulates model counts across multiple calls', async () => {
    const ai = createMockAI();
    const metrics = createMetricsAccumulator();
    const proxied = createAIProxy(ai, metrics);

    // Multiple calls to different models
    await proxied.run('@cf/meta/llama-3.2-3b-instruct', { prompt: 'First' });
    await proxied.run('@cf/qwen/qwen2.5-coder-32b-instruct', { prompt: 'Second' });
    await proxied.run('@cf/meta/llama-3.2-3b-instruct', { prompt: 'Third' });
    await proxied.run('@cf/qwen/qwen2.5-coder-32b-instruct', { prompt: 'Fourth' });
    await proxied.run('@cf/qwen/qwen2.5-coder-32b-instruct', { prompt: 'Fifth' });

    expect(metrics.aiRequests).toBe(5);
    expect(metrics.aiModelCounts.size).toBe(2);
    expect(metrics.aiModelCounts.get('@cf/meta/llama-3.2-3b-instruct')).toBe(2);
    expect(metrics.aiModelCounts.get('@cf/qwen/qwen2.5-coder-32b-instruct')).toBe(3);
  });
});

// =============================================================================
// VECTORIZE PROXY TESTS
// =============================================================================

describe('Vectorize Proxy', () => {
  it('tracks query() calls', async () => {
    const vectorize = createMockVectorize();
    const metrics = createMetricsAccumulator();
    const proxied = createVectorizeProxy(vectorize, metrics);

    await proxied.query([0.1, 0.2, 0.3], { topK: 10 });

    expect(metrics.vectorizeQueries).toBe(1);
  });

  it('tracks insert() with vector count', async () => {
    const vectorize = createMockVectorize();
    const metrics = createMetricsAccumulator();
    const proxied = createVectorizeProxy(vectorize, metrics);

    await proxied.insert([
      { id: '1', values: [0.1, 0.2] },
      { id: '2', values: [0.3, 0.4] },
      { id: '3', values: [0.5, 0.6] },
    ]);

    expect(metrics.vectorizeInserts).toBe(3);
  });

  it('tracks upsert() with vector count', async () => {
    const vectorize = createMockVectorize();
    const metrics = createMetricsAccumulator();
    const proxied = createVectorizeProxy(vectorize, metrics);

    await proxied.upsert([
      { id: '1', values: [0.1, 0.2] },
      { id: '2', values: [0.3, 0.4] },
    ]);

    expect(metrics.vectorizeInserts).toBe(2);
  });

  it('deleteByIds() works (not tracked - Analytics Engine 20 double limit)', async () => {
    const vectorize = createMockVectorize();
    const metrics = createMetricsAccumulator();
    const proxied = createVectorizeProxy(vectorize, metrics);

    // Deletes still work, just not tracked in telemetry
    await proxied.deleteByIds(['id1', 'id2', 'id3', 'id4']);
    expect(vectorize.deleteByIds).toHaveBeenCalledWith(['id1', 'id2', 'id3', 'id4']);
  });

  it('tracks getByIds() as query', async () => {
    const vectorize = createMockVectorize();
    const metrics = createMetricsAccumulator();
    const proxied = createVectorizeProxy(vectorize, metrics);

    await proxied.getByIds(['id1', 'id2']);

    expect(metrics.vectorizeQueries).toBe(1);
  });
});

// =============================================================================
// ENVIRONMENT PROXY TESTS
// =============================================================================

describe('Environment Proxy', () => {
  it('wraps D1 databases automatically', async () => {
    const env = {
      DB: createMockD1Database(),
      CACHE: createMockKVNamespace(),
    };
    const metrics = createMetricsAccumulator();
    const proxied = createEnvProxy(env, metrics);

    await proxied.DB.prepare('SELECT 1').all();

    expect(metrics.d1Reads).toBe(5);
  });

  it('wraps KV namespaces automatically', async () => {
    const env = {
      DB: createMockD1Database(),
      CACHE: createMockKVNamespace(),
    };
    const metrics = createMetricsAccumulator();
    const proxied = createEnvProxy(env, metrics);

    await proxied.CACHE.get('key');

    expect(metrics.kvReads).toBe(1);
  });

  it('does not wrap PLATFORM_CACHE', async () => {
    const platformCache = createMockKVNamespace();
    const env = {
      PLATFORM_CACHE: platformCache,
      OTHER_KV: createMockKVNamespace(),
    };
    const metrics = createMetricsAccumulator();
    const proxied = createEnvProxy(env, metrics);

    // PLATFORM_CACHE should not be tracked
    await proxied.PLATFORM_CACHE.get('key');
    expect(metrics.kvReads).toBe(0);

    // OTHER_KV should be tracked
    await proxied.OTHER_KV.get('key');
    expect(metrics.kvReads).toBe(1);
  });

  it('does not wrap PLATFORM_TELEMETRY', () => {
    const queue = {
      send: vi.fn(),
      sendBatch: vi.fn(),
    };
    const env = {
      PLATFORM_TELEMETRY: queue,
    };
    const metrics = createMetricsAccumulator();
    const proxied = createEnvProxy(env, metrics);

    // Should return the original queue unchanged
    expect(proxied.PLATFORM_TELEMETRY).toBe(queue);
  });

  it('caches wrapped bindings for repeated access', async () => {
    const env = {
      DB: createMockD1Database(),
    };
    const metrics = createMetricsAccumulator();
    const proxied = createEnvProxy(env, metrics);

    const first = proxied.DB;
    const second = proxied.DB;

    expect(first).toBe(second);
  });

  it('passes through non-binding properties unchanged', () => {
    const env = {
      API_KEY: 'secret',
      DEBUG: true,
      COUNT: 42,
    };
    const metrics = createMetricsAccumulator();
    const proxied = createEnvProxy(env, metrics);

    expect(proxied.API_KEY).toBe('secret');
    expect(proxied.DEBUG).toBe(true);
    expect(proxied.COUNT).toBe(42);
  });
});

// =============================================================================
// DURABLE OBJECTS LATENCY TESTS
// =============================================================================

describe('Durable Objects Proxy Latency', () => {
  function createMockDONamespace() {
    const mockStub = {
      id: { toString: () => 'mock-id' },
      fetch: vi.fn().mockResolvedValue(new Response('ok')),
    };
    return {
      get: vi.fn().mockReturnValue(mockStub),
      idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-id' }),
      idFromString: vi.fn().mockReturnValue({ toString: () => 'mock-id' }),
      newUniqueId: vi.fn().mockReturnValue({ toString: () => 'mock-id' }),
      _stub: mockStub,
    } as unknown as DurableObjectNamespace & { _stub: typeof mockStub };
  }

  it('tracks latency on successful fetch', async () => {
    const ns = createMockDONamespace();
    const metrics = createMetricsAccumulator();
    const { createDOProxy } = await import('@littlebearapps/platform-sdk');
    const proxied = createDOProxy(ns, metrics);

    const stub = proxied.get(ns.idFromName('test'));
    await stub.fetch('https://do.internal/test');

    expect(metrics.doRequests).toBe(1);
    expect(metrics.doLatencyMs.length).toBe(1);
    expect(metrics.doLatencyMs[0]).toBeGreaterThanOrEqual(0);
    expect(metrics.doTotalLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('tracks latency even when fetch fails', async () => {
    const ns = createMockDONamespace();
    ns._stub.fetch = vi.fn().mockRejectedValue(new Error('DO error'));
    const metrics = createMetricsAccumulator();
    const { createDOProxy } = await import('@littlebearapps/platform-sdk');
    const proxied = createDOProxy(ns, metrics);

    const stub = proxied.get(ns.idFromName('test'));
    await expect(stub.fetch('https://do.internal/test')).rejects.toThrow('DO error');

    // Latency should still be tracked even on failure
    expect(metrics.doRequests).toBe(1);
    expect(metrics.doLatencyMs.length).toBe(1);
    expect(metrics.doTotalLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('accumulates latency across multiple fetches', async () => {
    const ns = createMockDONamespace();
    const metrics = createMetricsAccumulator();
    const { createDOProxy } = await import('@littlebearapps/platform-sdk');
    const proxied = createDOProxy(ns, metrics);

    const stub = proxied.get(ns.idFromName('test'));
    await stub.fetch('https://do.internal/1');
    await stub.fetch('https://do.internal/2');
    await stub.fetch('https://do.internal/3');

    expect(metrics.doRequests).toBe(3);
    expect(metrics.doLatencyMs.length).toBe(3);
    expect(metrics.doTotalLatencyMs).toBeGreaterThanOrEqual(0);
    // Total should equal sum of individual latencies
    const sum = metrics.doLatencyMs.reduce((a, b) => a + b, 0);
    expect(metrics.doTotalLatencyMs).toBeCloseTo(sum, 5);
  });
});
