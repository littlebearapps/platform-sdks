/**
 * Unit Tests for Platform SDK Circuit Breaker Middleware
 *
 * Tests project-level CB checks, Hono middleware factory, status queries/writes,
 * global stop, multi-account scenarios, and key generation.
 *
 * @module tests/unit/platform-sdk/middleware
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  // Constants
  PROJECT_CB_STATUS,
  GLOBAL_STOP_KEY,
  CB_PROJECT_KEYS,
  CB_ERROR_CODES,
  BUDGET_STATUS_HEADER,
  // Functions
  createProjectKey,
  checkProjectCircuitBreaker,
  checkProjectCircuitBreakerDetailed,
  createCircuitBreakerMiddleware,
  getCircuitBreakerStates,
  getProjectStatus,
  setProjectStatus,
  isGlobalStopActive,
  setGlobalStop,
  // Types
  type CircuitBreakerStatusValue,
} from '@littlebearapps/platform-consumer-sdk/middleware';

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
// CONSTANTS
// =============================================================================

describe('Constants', () => {
  it('PROJECT_CB_STATUS has correct values', () => {
    expect(PROJECT_CB_STATUS.CLOSED).toBe('active');
    expect(PROJECT_CB_STATUS.WARNING).toBe('warning');
    expect(PROJECT_CB_STATUS.OPEN).toBe('paused');
  });

  it('GLOBAL_STOP_KEY is correct', () => {
    expect(GLOBAL_STOP_KEY).toBe('GLOBAL_STOP_ALL');
  });

  it('CB_PROJECT_KEYS has all known projects', () => {
    expect(CB_PROJECT_KEYS.GLOBAL_STOP).toBe('GLOBAL_STOP_ALL');
    expect(CB_PROJECT_KEYS.SCOUT).toBe('PROJECT:SCOUT:STATUS');
    expect(CB_PROJECT_KEYS.BRAND_COPILOT).toBe('PROJECT:BRAND-COPILOT:STATUS');
    expect(CB_PROJECT_KEYS.AUSTRALIAN_HISTORY_MCP).toBe('PROJECT:AUSTRALIAN-HISTORY-MCP:STATUS');
    expect(CB_PROJECT_KEYS.PLATFORM).toBe('PROJECT:PLATFORM:STATUS');
  });

  it('CB_ERROR_CODES has correct values', () => {
    expect(CB_ERROR_CODES.GLOBAL).toBe('GLOBAL_CIRCUIT_BREAKER');
    expect(CB_ERROR_CODES.PROJECT).toBe('PROJECT_CIRCUIT_BREAKER');
    expect(CB_ERROR_CODES.WARNING).toBe('BUDGET_WARNING');
  });

  it('BUDGET_STATUS_HEADER is correct', () => {
    expect(BUDGET_STATUS_HEADER).toBe('X-Platform-Budget');
  });
});

// =============================================================================
// KEY GENERATION
// =============================================================================

describe('createProjectKey', () => {
  it('generates correct key from lowercase slug', () => {
    expect(createProjectKey('my-project')).toBe('PROJECT:MY-PROJECT:STATUS');
  });

  it('generates correct key from uppercase slug', () => {
    expect(createProjectKey('SCOUT')).toBe('PROJECT:SCOUT:STATUS');
  });

  it('handles mixed case', () => {
    expect(createProjectKey('Brand-Copilot')).toBe('PROJECT:BRAND-COPILOT:STATUS');
  });
});

// =============================================================================
// DETAILED CIRCUIT BREAKER CHECK
// =============================================================================

describe('checkProjectCircuitBreakerDetailed', () => {
  it('returns allowed:true for active (CLOSED) project', async () => {
    const kv = createMockKV({
      [CB_PROJECT_KEYS.SCOUT]: 'active',
    });

    const result = await checkProjectCircuitBreakerDetailed(CB_PROJECT_KEYS.SCOUT, kv);

    expect(result.allowed).toBe(true);
    expect(result.status).toBe('active');
    expect(result.projectId).toBe('scout');
    expect(result.response).toBeNull();
  });

  it('returns allowed:true for null (missing) project status', async () => {
    const kv = createMockKV(); // No data

    const result = await checkProjectCircuitBreakerDetailed(CB_PROJECT_KEYS.SCOUT, kv);

    expect(result.allowed).toBe(true);
    expect(result.status).toBe('active');
    expect(result.response).toBeNull();
  });

  it('returns allowed:true with warning status', async () => {
    const kv = createMockKV({
      [CB_PROJECT_KEYS.SCOUT]: 'warning',
    });

    const result = await checkProjectCircuitBreakerDetailed(CB_PROJECT_KEYS.SCOUT, kv);

    expect(result.allowed).toBe(true);
    expect(result.status).toBe('warning');
    expect(result.response).toBeNull();
  });

  it('returns allowed:false for paused (OPEN) project', async () => {
    const kv = createMockKV({
      [CB_PROJECT_KEYS.SCOUT]: 'paused',
    });

    const result = await checkProjectCircuitBreakerDetailed(CB_PROJECT_KEYS.SCOUT, kv);

    expect(result.allowed).toBe(false);
    expect(result.status).toBe('paused');
    expect(result.response).not.toBeNull();
    expect(result.response!.status).toBe(503);
  });

  it('returns allowed:false when global stop is active', async () => {
    const kv = createMockKV({
      [GLOBAL_STOP_KEY]: 'true',
      [CB_PROJECT_KEYS.SCOUT]: 'active', // Even if project is active
    });

    const result = await checkProjectCircuitBreakerDetailed(CB_PROJECT_KEYS.SCOUT, kv);

    expect(result.allowed).toBe(false);
    expect(result.status).toBe('global_stop');
  });

  it('global stop takes priority over project status', async () => {
    const kv = createMockKV({
      [GLOBAL_STOP_KEY]: 'true',
      [CB_PROJECT_KEYS.SCOUT]: 'paused',
    });

    const result = await checkProjectCircuitBreakerDetailed(CB_PROJECT_KEYS.SCOUT, kv);

    expect(result.status).toBe('global_stop');
  });

  it('503 response has correct headers and body', async () => {
    const kv = createMockKV({
      [CB_PROJECT_KEYS.SCOUT]: 'paused',
    });

    const result = await checkProjectCircuitBreakerDetailed(CB_PROJECT_KEYS.SCOUT, kv);
    const response = result.response!;

    expect(response.status).toBe(503);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('Retry-After')).toBe('1800');
    expect(response.headers.get('X-Circuit-Breaker')).toBe('PROJECT_CIRCUIT_BREAKER');

    const body = await response.json() as Record<string, unknown>;
    expect(body.success).toBe(false);
    expect(body.code).toBe('PROJECT_CIRCUIT_BREAKER');
  });

  it('global stop 503 has 1 hour retry', async () => {
    const kv = createMockKV({
      [GLOBAL_STOP_KEY]: 'true',
    });

    const result = await checkProjectCircuitBreakerDetailed(CB_PROJECT_KEYS.SCOUT, kv);
    const response = result.response!;

    expect(response.headers.get('Retry-After')).toBe('3600');
    expect(response.headers.get('X-Circuit-Breaker')).toBe('GLOBAL_CIRCUIT_BREAKER');
  });

  it('extracts project ID from custom key', async () => {
    const kv = createMockKV();
    const customKey = createProjectKey('my-custom-project');

    const result = await checkProjectCircuitBreakerDetailed(customKey, kv);

    expect(result.projectId).toBe('my-custom-project');
  });
});

// =============================================================================
// SIMPLE CIRCUIT BREAKER CHECK
// =============================================================================

describe('checkProjectCircuitBreaker', () => {
  it('returns null for active project', async () => {
    const kv = createMockKV({ [CB_PROJECT_KEYS.SCOUT]: 'active' });
    const response = await checkProjectCircuitBreaker(CB_PROJECT_KEYS.SCOUT, kv);
    expect(response).toBeNull();
  });

  it('returns null for warning project', async () => {
    const kv = createMockKV({ [CB_PROJECT_KEYS.SCOUT]: 'warning' });
    const response = await checkProjectCircuitBreaker(CB_PROJECT_KEYS.SCOUT, kv);
    expect(response).toBeNull();
  });

  it('returns 503 Response for paused project', async () => {
    const kv = createMockKV({ [CB_PROJECT_KEYS.SCOUT]: 'paused' });
    const response = await checkProjectCircuitBreaker(CB_PROJECT_KEYS.SCOUT, kv);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(503);
  });

  it('returns 503 Response for global stop', async () => {
    const kv = createMockKV({ [GLOBAL_STOP_KEY]: 'true' });
    const response = await checkProjectCircuitBreaker(CB_PROJECT_KEYS.SCOUT, kv);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(503);
  });
});

// =============================================================================
// PROJECT STATUS QUERIES
// =============================================================================

describe('getProjectStatus', () => {
  it('returns status for existing project', async () => {
    const kv = createMockKV({ [CB_PROJECT_KEYS.SCOUT]: 'warning' });
    const status = await getProjectStatus(kv, CB_PROJECT_KEYS.SCOUT);
    expect(status).toBe('warning');
  });

  it('returns null for missing project', async () => {
    const kv = createMockKV();
    const status = await getProjectStatus(kv, CB_PROJECT_KEYS.SCOUT);
    expect(status).toBeNull();
  });
});

describe('getCircuitBreakerStates', () => {
  it('returns all known project states by default', async () => {
    const kv = createMockKV({
      [CB_PROJECT_KEYS.SCOUT]: 'active',
      [CB_PROJECT_KEYS.BRAND_COPILOT]: 'warning',
      [CB_PROJECT_KEYS.PLATFORM]: 'paused',
    });

    const states = await getCircuitBreakerStates(kv);

    expect(states.globalStop).toBeNull(); // No global stop
    expect(states.scout).toBe('active');
    expect(states['brand-copilot']).toBe('warning');
    expect(states.platform).toBe('paused');
    expect(states['australian-history-mcp']).toBeNull(); // Not set
  });

  it('returns global_stop when active', async () => {
    const kv = createMockKV({ [GLOBAL_STOP_KEY]: 'true' });

    const states = await getCircuitBreakerStates(kv);
    expect(states.globalStop).toBe('global_stop');
  });

  it('accepts custom project keys', async () => {
    const customKey = createProjectKey('my-project');
    const kv = createMockKV({ [customKey]: 'warning' });

    const states = await getCircuitBreakerStates(kv, [customKey]);

    expect(states['my-project']).toBe('warning');
    // Should not have other projects
    expect(states.scout).toBeUndefined();
  });

  it('handles single-project KV (multi-account scenario)', async () => {
    // In multi-account, Scout's KV only has Scout's key
    const kv = createMockKV({ [CB_PROJECT_KEYS.SCOUT]: 'active' });

    const states = await getCircuitBreakerStates(kv, [CB_PROJECT_KEYS.SCOUT]);

    expect(states.scout).toBe('active');
    expect(Object.keys(states).filter((k) => k !== 'globalStop')).toHaveLength(1);
  });
});

// =============================================================================
// STATUS WRITES
// =============================================================================

describe('setProjectStatus', () => {
  it('writes status with default TTL', async () => {
    const kv = createMockKV();

    await setProjectStatus(kv, CB_PROJECT_KEYS.SCOUT, 'paused');

    expect(kv.put).toHaveBeenCalledWith(
      CB_PROJECT_KEYS.SCOUT,
      'paused',
      { expirationTtl: 86400 }
    );
  });

  it('writes status with custom TTL', async () => {
    const kv = createMockKV();

    await setProjectStatus(kv, CB_PROJECT_KEYS.SCOUT, 'warning', 3600);

    expect(kv.put).toHaveBeenCalledWith(
      CB_PROJECT_KEYS.SCOUT,
      'warning',
      { expirationTtl: 3600 }
    );
  });

  it('status is readable after write', async () => {
    const kv = createMockKV();

    await setProjectStatus(kv, CB_PROJECT_KEYS.SCOUT, 'paused');

    const status = await getProjectStatus(kv, CB_PROJECT_KEYS.SCOUT);
    expect(status).toBe('paused');
  });
});

// =============================================================================
// GLOBAL STOP
// =============================================================================

describe('isGlobalStopActive', () => {
  it('returns true when global stop is set', async () => {
    const kv = createMockKV({ [GLOBAL_STOP_KEY]: 'true' });
    expect(await isGlobalStopActive(kv)).toBe(true);
  });

  it('returns false when global stop is not set', async () => {
    const kv = createMockKV();
    expect(await isGlobalStopActive(kv)).toBe(false);
  });

  it('returns false for any value other than "true"', async () => {
    const kv = createMockKV({ [GLOBAL_STOP_KEY]: 'false' });
    expect(await isGlobalStopActive(kv)).toBe(false);
  });
});

describe('setGlobalStop', () => {
  it('enables global stop', async () => {
    const kv = createMockKV();

    await setGlobalStop(kv, true);

    expect(kv.put).toHaveBeenCalledWith(GLOBAL_STOP_KEY, 'true');
    expect(await isGlobalStopActive(kv)).toBe(true);
  });

  it('disables global stop by deleting key', async () => {
    const kv = createMockKV({ [GLOBAL_STOP_KEY]: 'true' });

    await setGlobalStop(kv, false);

    expect(kv.delete).toHaveBeenCalledWith(GLOBAL_STOP_KEY);
    expect(await isGlobalStopActive(kv)).toBe(false);
  });
});

// =============================================================================
// HONO MIDDLEWARE
// =============================================================================

describe('createCircuitBreakerMiddleware', () => {
  function createMockContext(
    path: string,
    kvData: Record<string, string> = {}
  ) {
    const kv = createMockKV(kvData);
    let nextCalled = false;
    const mockResponse = new Response('OK', { status: 200 });

    return {
      c: {
        env: { PLATFORM_CACHE: kv },
        req: { path },
        res: mockResponse,
      },
      next: vi.fn(async () => {
        nextCalled = true;
      }),
      get nextCalled() { return nextCalled; },
      kv,
    };
  }

  describe('default skip paths', () => {
    it('skips /health endpoint', async () => {
      const { c, next } = createMockContext('/health', {
        [CB_PROJECT_KEYS.SCOUT]: 'paused',
      });
      const middleware = createCircuitBreakerMiddleware(CB_PROJECT_KEYS.SCOUT);

      await middleware(c, next);
      expect(next).toHaveBeenCalled();
    });

    it('skips /healthz endpoint', async () => {
      const { c, next } = createMockContext('/healthz', {
        [CB_PROJECT_KEYS.SCOUT]: 'paused',
      });
      const middleware = createCircuitBreakerMiddleware(CB_PROJECT_KEYS.SCOUT);

      await middleware(c, next);
      expect(next).toHaveBeenCalled();
    });

    it('skips /_health endpoint', async () => {
      const { c, next } = createMockContext('/_health', {
        [CB_PROJECT_KEYS.SCOUT]: 'paused',
      });
      const middleware = createCircuitBreakerMiddleware(CB_PROJECT_KEYS.SCOUT);

      await middleware(c, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('custom skip paths', () => {
    it('skips custom paths (Brand Copilot style)', async () => {
      const { c, next } = createMockContext('/.well-known/openid-configuration', {
        [CB_PROJECT_KEYS.BRAND_COPILOT]: 'paused',
      });
      const middleware = createCircuitBreakerMiddleware(CB_PROJECT_KEYS.BRAND_COPILOT, {
        skipPaths: ['/health', '/healthz', '/_health', '/.well-known/', '/oauth/'],
      });

      await middleware(c, next);
      expect(next).toHaveBeenCalled();
    });

    it('skips /oauth/ paths', async () => {
      const { c, next } = createMockContext('/oauth/callback', {
        [CB_PROJECT_KEYS.BRAND_COPILOT]: 'paused',
      });
      const middleware = createCircuitBreakerMiddleware(CB_PROJECT_KEYS.BRAND_COPILOT, {
        skipPaths: ['/health', '/.well-known/', '/oauth/'],
      });

      await middleware(c, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('CB states', () => {
    it('passes through for active (CLOSED) status', async () => {
      const { c, next } = createMockContext('/api/data', {
        [CB_PROJECT_KEYS.SCOUT]: 'active',
      });
      const middleware = createCircuitBreakerMiddleware(CB_PROJECT_KEYS.SCOUT);

      const response = await middleware(c, next);
      expect(next).toHaveBeenCalled();
      expect(response).toBeUndefined(); // next() was called, no explicit return
    });

    it('blocks with 503 for paused (OPEN) status', async () => {
      const { c, next } = createMockContext('/api/data', {
        [CB_PROJECT_KEYS.SCOUT]: 'paused',
      });
      const middleware = createCircuitBreakerMiddleware(CB_PROJECT_KEYS.SCOUT);

      const response = await middleware(c, next);
      expect(next).not.toHaveBeenCalled();
      expect(response).toBeInstanceOf(Response);
      expect((response as Response).status).toBe(503);
    });

    it('blocks with 503 for global stop', async () => {
      const { c, next } = createMockContext('/api/data', {
        [GLOBAL_STOP_KEY]: 'true',
      });
      const middleware = createCircuitBreakerMiddleware(CB_PROJECT_KEYS.SCOUT);

      const response = await middleware(c, next);
      expect(next).not.toHaveBeenCalled();
      expect(response).toBeInstanceOf(Response);
      expect((response as Response).status).toBe(503);
    });

    it('adds warning header for WARNING status', async () => {
      const { c, next } = createMockContext('/api/data', {
        [CB_PROJECT_KEYS.SCOUT]: 'warning',
      });
      const middleware = createCircuitBreakerMiddleware(CB_PROJECT_KEYS.SCOUT);

      const response = await middleware(c, next);
      expect(next).toHaveBeenCalled();
      expect(response).toBeInstanceOf(Response);
      expect((response as Response).headers.get(BUDGET_STATUS_HEADER)).toBe('Warning');
    });

    it('passes through for null (missing) status', async () => {
      const { c, next } = createMockContext('/api/data');
      const middleware = createCircuitBreakerMiddleware(CB_PROJECT_KEYS.SCOUT);

      await middleware(c, next);
      expect(next).toHaveBeenCalled();
    });
  });
});

// =============================================================================
// MULTI-ACCOUNT SCENARIOS
// =============================================================================

describe('multi-account scenarios', () => {
  it('single-project KV returns null for other projects', async () => {
    // Scout account only has Scout key
    const kv = createMockKV({
      [CB_PROJECT_KEYS.SCOUT]: 'active',
    });

    const scoutStatus = await getProjectStatus(kv, CB_PROJECT_KEYS.SCOUT);
    expect(scoutStatus).toBe('active');

    // Querying BC returns null (not "active" — it's genuinely unknown)
    const bcStatus = await getProjectStatus(kv, CB_PROJECT_KEYS.BRAND_COPILOT);
    expect(bcStatus).toBeNull();
  });

  it('checkProjectCircuitBreakerDetailed treats null as active', async () => {
    const kv = createMockKV(); // Empty KV

    const result = await checkProjectCircuitBreakerDetailed(CB_PROJECT_KEYS.SCOUT, kv);
    expect(result.allowed).toBe(true);
    expect(result.status).toBe('active');
  });

  it('per-account setProjectStatus + getProjectStatus roundtrip', async () => {
    const kv = createMockKV();

    await setProjectStatus(kv, CB_PROJECT_KEYS.SCOUT, 'warning', 3600);

    const status = await getProjectStatus(kv, CB_PROJECT_KEYS.SCOUT);
    expect(status).toBe('warning');

    // Other project is unaffected
    const bcStatus = await getProjectStatus(kv, CB_PROJECT_KEYS.BRAND_COPILOT);
    expect(bcStatus).toBeNull();
  });

  it('custom project key for new/future projects', async () => {
    const customKey = createProjectKey('new-saas');
    const kv = createMockKV();

    await setProjectStatus(kv, customKey, 'active');
    const status = await getProjectStatus(kv, customKey);
    expect(status).toBe('active');

    const states = await getCircuitBreakerStates(kv, [customKey]);
    expect(states['new-saas']).toBe('active');
  });
});
