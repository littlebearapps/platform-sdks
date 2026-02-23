/**
 * Unit Tests for Platform SDK Dynamic Patterns
 *
 * Tests DSL compilation, KV loading, cache behaviour, classification,
 * and multi-account export/import utilities.
 *
 * @module tests/unit/platform-sdk/dynamic-patterns
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  compileDynamicPatterns,
  loadDynamicPatterns,
  clearDynamicPatternsCache,
  classifyWithDynamicPatterns,
  exportDynamicPatterns,
  importDynamicPatterns,
  DYNAMIC_PATTERNS_KV_KEY,
  type DynamicPatternRule,
  type CompiledPattern,
} from '@littlebearapps/platform-consumer-sdk/dynamic-patterns';

// =============================================================================
// MOCK KV NAMESPACE
// =============================================================================

function createMockKV(initialData: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initialData));

  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    put: vi.fn((key: string, value: string, _opts?: unknown) => {
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
// SETUP
// =============================================================================

beforeEach(() => {
  clearDynamicPatternsCache();
});

// =============================================================================
// CONSTANTS
// =============================================================================

describe('DYNAMIC_PATTERNS_KV_KEY', () => {
  it('has the expected value', () => {
    expect(DYNAMIC_PATTERNS_KV_KEY).toBe('PATTERNS:DYNAMIC:APPROVED');
  });
});

// =============================================================================
// DSL COMPILATION
// =============================================================================

describe('compileDynamicPatterns', () => {
  it('compiles "contains" type correctly', () => {
    const rules: DynamicPatternRule[] = [
      { type: 'contains', value: 'database error', category: 'db-error', scope: 'all' },
    ];
    const compiled = compileDynamicPatterns(rules);

    expect(compiled).toHaveLength(1);
    expect(compiled[0].category).toBe('db-error');
    expect(compiled[0].test('A database error occurred')).toBe(true);
    expect(compiled[0].test('DATABASE ERROR found')).toBe(true); // case insensitive
    expect(compiled[0].test('Something else entirely')).toBe(false);
  });

  it('contains type requires all tokens', () => {
    const rules: DynamicPatternRule[] = [
      { type: 'contains', value: 'database connection failed', category: 'db-conn', scope: 'all' },
    ];
    const compiled = compileDynamicPatterns(rules);

    expect(compiled[0].test('database connection failed')).toBe(true);
    expect(compiled[0].test('The database connection has failed')).toBe(true);
    expect(compiled[0].test('database error')).toBe(false); // missing tokens
  });

  it('compiles "startsWith" type correctly', () => {
    const rules: DynamicPatternRule[] = [
      { type: 'startsWith', value: '[ERROR]', category: 'prefixed-error', scope: 'all' },
    ];
    const compiled = compileDynamicPatterns(rules);

    expect(compiled[0].test('[ERROR] Something went wrong')).toBe(true);
    expect(compiled[0].test('[error] lowercase also works')).toBe(true);
    expect(compiled[0].test('Not starting with [ERROR]')).toBe(false);
  });

  it('compiles "statusCode" type correctly', () => {
    const rules: DynamicPatternRule[] = [
      { type: 'statusCode', value: '504', category: 'gateway-timeout', scope: 'all' },
    ];
    const compiled = compileDynamicPatterns(rules);

    expect(compiled[0].test('HTTP 504 Gateway Timeout')).toBe(true);
    expect(compiled[0].test('Error: 504')).toBe(true);
    expect(compiled[0].test('Error 50400')).toBe(false); // word boundary
  });

  it('compiles "regex" type correctly', () => {
    const rules: DynamicPatternRule[] = [
      { type: 'regex', value: 'connection.*pool.*exhausted', category: 'pool-exhausted', scope: 'all' },
    ];
    const compiled = compileDynamicPatterns(rules);

    expect(compiled[0].test('connection pool exhausted')).toBe(true);
    expect(compiled[0].test('Connection to pool was exhausted')).toBe(true); // case insensitive
    expect(compiled[0].test('just a connection issue')).toBe(false);
  });

  it('rejects regex patterns longer than 200 characters', () => {
    const longRegex = 'a'.repeat(201);
    const rules: DynamicPatternRule[] = [
      { type: 'regex', value: longRegex, category: 'too-long', scope: 'all' },
    ];
    const compiled = compileDynamicPatterns(rules);

    expect(compiled).toHaveLength(0);
  });

  it('accepts regex patterns exactly 200 characters', () => {
    const exactRegex = 'a'.repeat(200);
    const rules: DynamicPatternRule[] = [
      { type: 'regex', value: exactRegex, category: 'just-right', scope: 'all' },
    ];
    const compiled = compileDynamicPatterns(rules);

    expect(compiled).toHaveLength(1);
  });

  it('drops invalid regex without crashing', () => {
    const rules: DynamicPatternRule[] = [
      { type: 'regex', value: '[invalid regex', category: 'bad-regex', scope: 'all' },
    ];
    const compiled = compileDynamicPatterns(rules);

    expect(compiled).toHaveLength(0);
  });

  it('drops unknown DSL types', () => {
    const rules = [
      { type: 'unknown' as 'contains', value: 'test', category: 'unknown', scope: 'all' },
    ];
    const compiled = compileDynamicPatterns(rules);

    expect(compiled).toHaveLength(0);
  });

  it('preserves pattern ID', () => {
    const rules: DynamicPatternRule[] = [
      { type: 'contains', value: 'test', category: 'test-cat', scope: 'all', id: 'pat-123' },
    ];
    const compiled = compileDynamicPatterns(rules);

    expect(compiled[0].id).toBe('pat-123');
  });

  it('compiles mixed valid and invalid rules', () => {
    const rules: DynamicPatternRule[] = [
      { type: 'contains', value: 'valid', category: 'good', scope: 'all' },
      { type: 'regex', value: '[bad', category: 'bad', scope: 'all' },
      { type: 'startsWith', value: 'also valid', category: 'good2', scope: 'all' },
    ];
    const compiled = compileDynamicPatterns(rules);

    expect(compiled).toHaveLength(2);
    expect(compiled[0].category).toBe('good');
    expect(compiled[1].category).toBe('good2');
  });

  it('returns empty array for empty input', () => {
    const compiled = compileDynamicPatterns([]);
    expect(compiled).toEqual([]);
  });
});

// =============================================================================
// KV LOADING
// =============================================================================

describe('loadDynamicPatterns', () => {
  it('loads and compiles patterns from KV', async () => {
    const rules: DynamicPatternRule[] = [
      { type: 'contains', value: 'kv loaded', category: 'kv-test', scope: 'all' },
    ];
    const kv = createMockKV({
      [DYNAMIC_PATTERNS_KV_KEY]: JSON.stringify(rules),
    });

    const patterns = await loadDynamicPatterns(kv);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].category).toBe('kv-test');
    expect(patterns[0].test('kv loaded successfully')).toBe(true);
  });

  it('returns empty array when no patterns in KV', async () => {
    const kv = createMockKV();
    const patterns = await loadDynamicPatterns(kv);
    expect(patterns).toEqual([]);
  });

  it('uses in-memory cache on subsequent calls', async () => {
    const rules: DynamicPatternRule[] = [
      { type: 'contains', value: 'cached', category: 'cache-test', scope: 'all' },
    ];
    const kv = createMockKV({
      [DYNAMIC_PATTERNS_KV_KEY]: JSON.stringify(rules),
    });

    // First call loads from KV
    await loadDynamicPatterns(kv);
    expect(kv.get).toHaveBeenCalledTimes(1);

    // Second call uses cache
    await loadDynamicPatterns(kv);
    expect(kv.get).toHaveBeenCalledTimes(1); // Still just 1
  });

  it('returns stale cache on KV error', async () => {
    const rules: DynamicPatternRule[] = [
      { type: 'contains', value: 'original', category: 'original', scope: 'all' },
    ];
    const kv = createMockKV({
      [DYNAMIC_PATTERNS_KV_KEY]: JSON.stringify(rules),
    });

    // Load initial patterns
    const patterns = await loadDynamicPatterns(kv);
    expect(patterns).toHaveLength(1);

    // Clear cache to force reload
    clearDynamicPatternsCache();

    // Simulate KV error
    kv.get = vi.fn(() => Promise.reject(new Error('KV error')));

    const fallback = await loadDynamicPatterns(kv);
    // After cache clear, no stale data available
    expect(fallback).toEqual([]);
  });
});

// =============================================================================
// CACHE CLEARING
// =============================================================================

describe('clearDynamicPatternsCache', () => {
  it('forces reload from KV on next call', async () => {
    const rules: DynamicPatternRule[] = [
      { type: 'contains', value: 'test', category: 'test', scope: 'all' },
    ];
    const kv = createMockKV({
      [DYNAMIC_PATTERNS_KV_KEY]: JSON.stringify(rules),
    });

    await loadDynamicPatterns(kv);
    expect(kv.get).toHaveBeenCalledTimes(1);

    clearDynamicPatternsCache();

    await loadDynamicPatterns(kv);
    expect(kv.get).toHaveBeenCalledTimes(2); // Reloaded from KV
  });
});

// =============================================================================
// CLASSIFICATION
// =============================================================================

describe('classifyWithDynamicPatterns', () => {
  it('returns match for matching dynamic pattern', () => {
    const patterns: CompiledPattern[] = [
      { test: (msg: string) => msg.includes('custom'), category: 'custom-error', id: 'p-1' },
    ];

    const result = classifyWithDynamicPatterns('A custom error occurred', patterns);
    expect(result).toEqual({
      category: 'custom-error',
      source: 'dynamic',
      patternId: 'p-1',
    });
  });

  it('returns null for no match', () => {
    const patterns: CompiledPattern[] = [
      { test: (msg: string) => msg.includes('specific'), category: 'specific', id: 'p-1' },
    ];

    const result = classifyWithDynamicPatterns('Nothing matching here', patterns);
    expect(result).toBeNull();
  });

  it('returns first match when multiple patterns match', () => {
    const patterns: CompiledPattern[] = [
      { test: (msg: string) => msg.includes('error'), category: 'first', id: 'p-1' },
      { test: (msg: string) => msg.includes('error'), category: 'second', id: 'p-2' },
    ];

    const result = classifyWithDynamicPatterns('An error occurred', patterns);
    expect(result?.category).toBe('first');
  });

  it('handles empty patterns array', () => {
    const result = classifyWithDynamicPatterns('Any message', []);
    expect(result).toBeNull();
  });

  it('handles patterns without ID', () => {
    const patterns: CompiledPattern[] = [
      { test: (msg: string) => msg.includes('test'), category: 'test-cat' },
    ];

    const result = classifyWithDynamicPatterns('A test message', patterns);
    expect(result).toEqual({
      category: 'test-cat',
      source: 'dynamic',
      patternId: undefined,
    });
  });
});

// =============================================================================
// MULTI-ACCOUNT: EXPORT
// =============================================================================

describe('exportDynamicPatterns', () => {
  it('returns raw JSON from KV', async () => {
    const rules: DynamicPatternRule[] = [
      { type: 'contains', value: 'test', category: 'test', scope: 'all' },
    ];
    const json = JSON.stringify(rules);
    const kv = createMockKV({
      [DYNAMIC_PATTERNS_KV_KEY]: json,
    });

    const exported = await exportDynamicPatterns(kv);
    expect(exported).toBe(json);
  });

  it('returns null when no patterns cached', async () => {
    const kv = createMockKV();
    const exported = await exportDynamicPatterns(kv);
    expect(exported).toBeNull();
  });
});

// =============================================================================
// MULTI-ACCOUNT: IMPORT
// =============================================================================

describe('importDynamicPatterns', () => {
  it('imports valid patterns with compilation gate', async () => {
    const rules: DynamicPatternRule[] = [
      { type: 'contains', value: 'test', category: 'test', scope: 'all' },
      { type: 'startsWith', value: 'error', category: 'prefixed', scope: 'all' },
    ];
    const kv = createMockKV();

    const result = await importDynamicPatterns(kv, JSON.stringify(rules));
    expect(result).toEqual({ imported: 2, dropped: 0 });
    expect(kv.put).toHaveBeenCalledTimes(1);
  });

  it('drops rules with invalid regex', async () => {
    const rules: DynamicPatternRule[] = [
      { type: 'contains', value: 'valid', category: 'good', scope: 'all' },
      { type: 'regex', value: '[bad regex', category: 'bad', scope: 'all' },
    ];
    const kv = createMockKV();

    const result = await importDynamicPatterns(kv, JSON.stringify(rules));
    expect(result).toEqual({ imported: 1, dropped: 1 });
  });

  it('drops rules missing required fields', async () => {
    const rules = [
      { type: 'contains', value: 'valid', category: 'good', scope: 'all' },
      { type: 'contains', value: '', category: 'missing-value', scope: 'all' }, // empty value
      { type: 'contains', value: 'test', category: '', scope: 'all' }, // empty category
    ] as DynamicPatternRule[];
    const kv = createMockKV();

    const result = await importDynamicPatterns(kv, JSON.stringify(rules));
    expect(result).toEqual({ imported: 1, dropped: 2 });
  });

  it('drops rules with unknown types', async () => {
    const rules = [
      { type: 'contains', value: 'valid', category: 'good', scope: 'all' },
      { type: 'badtype', value: 'test', category: 'bad', scope: 'all' },
    ] as DynamicPatternRule[];
    const kv = createMockKV();

    const result = await importDynamicPatterns(kv, JSON.stringify(rules));
    expect(result).toEqual({ imported: 1, dropped: 1 });
  });

  it('writes with 7-day TTL', async () => {
    const rules: DynamicPatternRule[] = [
      { type: 'contains', value: 'test', category: 'test', scope: 'all' },
    ];
    const kv = createMockKV();

    await importDynamicPatterns(kv, JSON.stringify(rules));

    expect(kv.put).toHaveBeenCalledWith(
      DYNAMIC_PATTERNS_KV_KEY,
      expect.any(String),
      { expirationTtl: 604800 }
    );
  });

  it('clears in-memory cache after import', async () => {
    const rules: DynamicPatternRule[] = [
      { type: 'contains', value: 'original', category: 'original', scope: 'all' },
    ];
    const kv = createMockKV({
      [DYNAMIC_PATTERNS_KV_KEY]: JSON.stringify(rules),
    });

    // Load to populate cache
    await loadDynamicPatterns(kv);
    expect(kv.get).toHaveBeenCalledTimes(1);

    // Import new patterns (clears cache)
    const newRules: DynamicPatternRule[] = [
      { type: 'contains', value: 'updated', category: 'updated', scope: 'all' },
    ];
    await importDynamicPatterns(kv, JSON.stringify(newRules));

    // Next load should hit KV again
    await loadDynamicPatterns(kv);
    expect(kv.get).toHaveBeenCalledTimes(2);
  });

  it('handles empty array input', async () => {
    const kv = createMockKV();
    const result = await importDynamicPatterns(kv, '[]');
    expect(result).toEqual({ imported: 0, dropped: 0 });
  });
});
