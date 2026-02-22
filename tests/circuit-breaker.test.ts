/**
 * Unit Tests for Platform SDK Circuit Breaker
 *
 * Tests circuit breaker status checks, error throwing, and KV key management.
 *
 * @module tests/unit/platform-sdk/circuit-breaker
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  CircuitBreakerError,
  isFeatureEnabled,
  setCircuitBreakerStatus,
  clearCircuitBreakerCache,
} from '@littlebearapps/platform-sdk';
import { KV_KEYS, CIRCUIT_STATUS } from '@littlebearapps/platform-sdk';

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
// CIRCUIT BREAKER ERROR TESTS
// =============================================================================

describe('CircuitBreakerError', () => {
  it('creates error with correct properties', () => {
    const error = new CircuitBreakerError('scout:ocr:process', 'feature', 'Budget exceeded');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(CircuitBreakerError);
    expect(error.name).toBe('CircuitBreakerError');
    expect(error.featureId).toBe('scout:ocr:process');
    expect(error.level).toBe('feature');
    expect(error.reason).toBe('Budget exceeded');
  });

  it('creates error message with reason', () => {
    const error = new CircuitBreakerError('scout:ocr:process', 'feature', 'Budget exceeded');

    expect(error.message).toContain('scout:ocr:process');
    expect(error.message).toContain('feature level');
    expect(error.message).toContain('Budget exceeded');
  });

  it('creates error message without reason', () => {
    const error = new CircuitBreakerError('scout:ocr:process', 'project');

    expect(error.message).toContain('scout:ocr:process');
    expect(error.message).toContain('project level');
    expect(error.reason).toBeUndefined();
  });

  it('handles different levels', () => {
    const featureError = new CircuitBreakerError('test:a:b', 'feature');
    const projectError = new CircuitBreakerError('test:a:b', 'project');
    const globalError = new CircuitBreakerError('test:a:b', 'global');

    expect(featureError.level).toBe('feature');
    expect(projectError.level).toBe('project');
    expect(globalError.level).toBe('global');
  });
});

// =============================================================================
// KV KEY PATTERNS TESTS
// =============================================================================

describe('KV Key Patterns', () => {
  it('generates correct feature status key', () => {
    const key = KV_KEYS.featureStatus('scout:ocr:process');
    expect(key).toBe('CONFIG:FEATURE:scout:ocr:process:STATUS');
  });

  it('generates correct project status key', () => {
    const key = KV_KEYS.projectStatus('scout');
    expect(key).toBe('CONFIG:PROJECT:scout:STATUS');
  });

  it('generates correct global status key', () => {
    const key = KV_KEYS.globalStatus();
    expect(key).toBe('CONFIG:GLOBAL:STATUS');
  });

  it('generates correct feature reason key', () => {
    const key = KV_KEYS.featureReason('scout:ocr:process');
    expect(key).toBe('CONFIG:FEATURE:scout:ocr:process:REASON');
  });

  it('generates correct legacy enabled key', () => {
    const key = KV_KEYS.legacy.enabled('scout:ocr:process');
    expect(key).toBe('FEATURE:scout:ocr:process:enabled');
  });
});

// =============================================================================
// CIRCUIT STATUS CONSTANTS TESTS
// =============================================================================

describe('Circuit Status Constants', () => {
  it('has GO status', () => {
    expect(CIRCUIT_STATUS.GO).toBe('GO');
  });

  it('has STOP status', () => {
    expect(CIRCUIT_STATUS.STOP).toBe('STOP');
  });
});

// =============================================================================
// isFeatureEnabled TESTS
// =============================================================================

describe('isFeatureEnabled', () => {
  let kv: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    kv = createMockKV();
    clearCircuitBreakerCache();
  });

  it('returns true when no circuit breaker keys exist', async () => {
    const result = await isFeatureEnabled('scout:ocr:process', kv);
    expect(result).toBe(true);
  });

  it('returns true when feature status is GO', async () => {
    kv._store.set(KV_KEYS.featureStatus('scout:ocr:process'), CIRCUIT_STATUS.GO);

    const result = await isFeatureEnabled('scout:ocr:process', kv);
    expect(result).toBe(true);
  });

  it('returns false when feature status is STOP', async () => {
    kv._store.set(KV_KEYS.featureStatus('scout:ocr:process'), CIRCUIT_STATUS.STOP);

    const result = await isFeatureEnabled('scout:ocr:process', kv);
    expect(result).toBe(false);
  });

  it('returns false when project status is STOP', async () => {
    kv._store.set(KV_KEYS.projectStatus('scout'), CIRCUIT_STATUS.STOP);

    const result = await isFeatureEnabled('scout:ocr:process', kv);
    expect(result).toBe(false);
  });

  it('returns false when global status is STOP', async () => {
    kv._store.set(KV_KEYS.globalStatus(), CIRCUIT_STATUS.STOP);

    const result = await isFeatureEnabled('scout:ocr:process', kv);
    expect(result).toBe(false);
  });

  it('returns false when legacy enabled is false', async () => {
    kv._store.set(KV_KEYS.legacy.enabled('scout:ocr:process'), 'false');

    const result = await isFeatureEnabled('scout:ocr:process', kv);
    expect(result).toBe(false);
  });
});

// =============================================================================
// setCircuitBreakerStatus TESTS
// =============================================================================

describe('setCircuitBreakerStatus', () => {
  let kv: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    kv = createMockKV();
    clearCircuitBreakerCache();
  });

  it('sets STOP status with reason', async () => {
    await setCircuitBreakerStatus('scout:ocr:process', 'STOP', kv, 'Budget exceeded');

    expect(kv._store.get(KV_KEYS.featureStatus('scout:ocr:process'))).toBe(CIRCUIT_STATUS.STOP);
    expect(kv._store.get(KV_KEYS.featureReason('scout:ocr:process'))).toBe('Budget exceeded');
    expect(kv._store.has(KV_KEYS.featureDisabledAt('scout:ocr:process'))).toBe(true);
  });

  it('sets STOP status without reason', async () => {
    await setCircuitBreakerStatus('scout:ocr:process', 'STOP', kv);

    expect(kv._store.get(KV_KEYS.featureStatus('scout:ocr:process'))).toBe(CIRCUIT_STATUS.STOP);
    expect(kv._store.has(KV_KEYS.featureReason('scout:ocr:process'))).toBe(false);
  });

  it('clears all keys when setting GO', async () => {
    // First set STOP
    kv._store.set(KV_KEYS.featureStatus('scout:ocr:process'), CIRCUIT_STATUS.STOP);
    kv._store.set(KV_KEYS.featureReason('scout:ocr:process'), 'Budget exceeded');
    kv._store.set(KV_KEYS.featureDisabledAt('scout:ocr:process'), Date.now().toString());
    kv._store.set(KV_KEYS.featureAutoResetAt('scout:ocr:process'), Date.now().toString());

    // Then set GO
    await setCircuitBreakerStatus('scout:ocr:process', 'GO', kv);

    expect(kv._store.has(KV_KEYS.featureStatus('scout:ocr:process'))).toBe(false);
    expect(kv._store.has(KV_KEYS.featureReason('scout:ocr:process'))).toBe(false);
    expect(kv._store.has(KV_KEYS.featureDisabledAt('scout:ocr:process'))).toBe(false);
    expect(kv._store.has(KV_KEYS.featureAutoResetAt('scout:ocr:process'))).toBe(false);
  });

  it('calls delete for each key when setting GO', async () => {
    await setCircuitBreakerStatus('scout:ocr:process', 'GO', kv);

    expect(kv.delete).toHaveBeenCalledWith(KV_KEYS.featureStatus('scout:ocr:process'));
    expect(kv.delete).toHaveBeenCalledWith(KV_KEYS.featureReason('scout:ocr:process'));
    expect(kv.delete).toHaveBeenCalledWith(KV_KEYS.featureDisabledAt('scout:ocr:process'));
    expect(kv.delete).toHaveBeenCalledWith(KV_KEYS.featureAutoResetAt('scout:ocr:process'));
  });

  it('sets disabledAt timestamp when STOP', async () => {
    const before = Date.now();
    await setCircuitBreakerStatus('scout:ocr:process', 'STOP', kv, 'Test');
    const after = Date.now();

    const disabledAt = parseInt(kv._store.get(KV_KEYS.featureDisabledAt('scout:ocr:process'))!, 10);
    expect(disabledAt).toBeGreaterThanOrEqual(before);
    expect(disabledAt).toBeLessThanOrEqual(after);
  });
});

// =============================================================================
// FEATURE ID VALIDATION TESTS
// =============================================================================

describe('Feature ID Validation', () => {
  it('accepts valid feature IDs', async () => {
    const kv = createMockKV();

    // These should not throw
    await expect(isFeatureEnabled('project:category:feature', kv)).resolves.toBe(true);
    await expect(isFeatureEnabled('my-project:my-category:my-feature', kv)).resolves.toBe(true);
    await expect(isFeatureEnabled('a:b:c', kv)).resolves.toBe(true);
  });
});
