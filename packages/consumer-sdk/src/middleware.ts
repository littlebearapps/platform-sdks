/// <reference types="@cloudflare/workers-types" />

/**
 * Circuit Breaker Middleware
 *
 * Project-level circuit breaker middleware for Cloudflare Workers.
 * Extracted from platform/main with multi-account improvements.
 *
 * Two-tier circuit breaker system:
 * - Feature-level (SDK core): `CIRCUIT_STATUS` (GO/STOP) — per-feature budget enforcement
 * - Project-level (this module): `PROJECT_CB_STATUS` (active/warning/paused) — request-level gating
 *
 * Status levels:
 * - 'active' (CLOSED): Normal operation, all requests pass through
 * - 'warning' (WARNING): Soft limit exceeded, requests pass but with logging
 * - 'paused' (OPEN): Hard limit exceeded (1.5x soft), requests blocked with 503
 *
 * @example Simple check
 * ```typescript
 * import { checkProjectCircuitBreaker, CB_PROJECT_KEYS } from '@littlebearapps/platform-consumer-sdk/middleware';
 *
 * const cbResponse = await checkProjectCircuitBreaker(CB_PROJECT_KEYS.SCOUT, env.PLATFORM_CACHE);
 * if (cbResponse) return cbResponse;
 * ```
 *
 * @example Hono middleware
 * ```typescript
 * import { createCircuitBreakerMiddleware, CB_PROJECT_KEYS } from '@littlebearapps/platform-consumer-sdk/middleware';
 *
 * const app = new Hono<{ Bindings: Env }>();
 * app.use('*', createCircuitBreakerMiddleware(CB_PROJECT_KEYS.SCOUT));
 * // Brand Copilot: skip OAuth paths
 * app.use('*', createCircuitBreakerMiddleware(CB_PROJECT_KEYS.BRAND_COPILOT, {
 *   skipPaths: ['/health', '/healthz', '/_health', '/.well-known/', '/oauth/'],
 * }));
 * ```
 */

import { createLogger, type Logger } from './logging';

// =============================================================================
// MODULE LOGGER (lazy-initialised to avoid global scope crypto calls)
// =============================================================================

let _log: Logger | null = null;
function getLog(): Logger {
  if (!_log) {
    _log = createLogger({
      worker: 'platform-sdk',
      featureId: 'platform:sdk:circuit-breaker',
    });
  }
  return _log;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Project-level circuit breaker status values.
 * Distinct from CIRCUIT_STATUS (GO/STOP) which is feature-level.
 *
 * | Layer | Constant | KV Key Pattern | Values | Purpose |
 * |-------|----------|---------------|--------|---------|
 * | Feature-level | CIRCUIT_STATUS | CONFIG:FEATURE:{id}:STATUS | GO / STOP | Per-feature budget |
 * | Project-level | PROJECT_CB_STATUS | PROJECT:{SLUG}:STATUS | active / warning / paused | Request gating |
 */
export const PROJECT_CB_STATUS = {
  /** Normal operation — all requests pass through */
  CLOSED: 'active',
  /** Soft limit exceeded — requests pass with warnings logged */
  WARNING: 'warning',
  /** Hard limit exceeded — requests blocked with 503 */
  OPEN: 'paused',
} as const;

export type CircuitBreakerStatusValue = (typeof PROJECT_CB_STATUS)[keyof typeof PROJECT_CB_STATUS];

/** KV key for global stop — affects ALL services (manual emergency stop) */
export const GLOBAL_STOP_KEY = 'GLOBAL_STOP_ALL';

/**
 * Known project circuit breaker KV keys.
 * Use createProjectKey() for custom/new projects.
 */
export const CB_PROJECT_KEYS = {
  /** Global stop — affects ALL services (manual emergency stop) */
  GLOBAL_STOP: GLOBAL_STOP_KEY,
  /** Scout worker status */
  SCOUT: 'PROJECT:SCOUT:STATUS',
  /** Brand Copilot worker status */
  BRAND_COPILOT: 'PROJECT:BRAND-COPILOT:STATUS',
  /** Australian History MCP (semantic-librarian) worker status */
  AUSTRALIAN_HISTORY_MCP: 'PROJECT:AUSTRALIAN-HISTORY-MCP:STATUS',
  /** Platform worker status (self-monitoring) */
  PLATFORM: 'PROJECT:PLATFORM:STATUS',
} as const;

/** Circuit breaker response codes */
export const CB_ERROR_CODES = {
  GLOBAL: 'GLOBAL_CIRCUIT_BREAKER',
  PROJECT: 'PROJECT_CIRCUIT_BREAKER',
  WARNING: 'BUDGET_WARNING',
} as const;

/** Response header for budget status visibility */
export const BUDGET_STATUS_HEADER = 'X-Platform-Budget';

/** Default paths to skip in circuit breaker middleware (health endpoints) */
const DEFAULT_SKIP_PATHS = ['/health', '/healthz', '/_health'];

// =============================================================================
// TYPES
// =============================================================================

export interface CircuitBreakerErrorResponse {
  error: string;
  code: string;
  retryAfterSeconds: number;
}

/** Result of circuit breaker check with detailed status information */
export interface CircuitBreakerCheckResult {
  /** Whether the request should be allowed */
  allowed: boolean;
  /** Current status: 'active' | 'warning' | 'paused' | 'global_stop' */
  status: CircuitBreakerStatusValue | 'global_stop';
  /** Project ID extracted from key */
  projectId: string;
  /** Response to return if blocked (null if allowed) */
  response: Response | null;
}

/** Options for createCircuitBreakerMiddleware */
export interface CircuitBreakerMiddlewareOptions {
  /**
   * Paths to skip circuit breaker checks (allows monitoring during circuit break).
   * Checks if request path starts with any of these values.
   * @default ['/health', '/healthz', '/_health']
   */
  skipPaths?: string[];
}

// =============================================================================
// KEY GENERATION
// =============================================================================

/**
 * Generate a PROJECT:{SLUG}:STATUS key from a project slug.
 * Use this for custom/new projects not in CB_PROJECT_KEYS.
 *
 * @param slug - Project slug (will be uppercased)
 * @returns KV key in format PROJECT:{SLUG}:STATUS
 *
 * @example
 * ```typescript
 * const key = createProjectKey('my-project');
 * // 'PROJECT:MY-PROJECT:STATUS'
 * ```
 */
export function createProjectKey(slug: string): string {
  return `PROJECT:${slug.toUpperCase()}:STATUS`;
}

/**
 * Extract project ID from KV key for logging.
 */
function extractProjectId(projectKey: string): string {
  const match = projectKey.match(/PROJECT:([^:]+):STATUS/);
  return match ? match[1].toLowerCase() : 'unknown';
}

// =============================================================================
// CIRCUIT BREAKER CHECKS
// =============================================================================

/**
 * Check circuit breaker status and return detailed result.
 *
 * @param projectKey - The KV key for the project status (use CB_PROJECT_KEYS or createProjectKey)
 * @param kv - KV namespace binding (PLATFORM_CACHE)
 * @returns Detailed check result with status, projectId, and response if blocked
 */
export async function checkProjectCircuitBreakerDetailed(
  projectKey: string,
  kv: KVNamespace
): Promise<CircuitBreakerCheckResult> {
  const projectId = extractProjectId(projectKey);

  // 1. Check global stop first (affects all services)
  const globalStop = await kv.get(GLOBAL_STOP_KEY);
  if (globalStop === 'true') {
    return {
      allowed: false,
      status: 'global_stop',
      projectId,
      response: createCircuitBreakerResponse({
        error: 'Service temporarily unavailable due to global circuit breaker',
        code: CB_ERROR_CODES.GLOBAL,
        retryAfterSeconds: 3600,
      }),
    };
  }

  // 2. Check project-specific status
  const projectStatus = (await kv.get(projectKey)) as CircuitBreakerStatusValue | null;

  // OPEN (paused): Hard limit exceeded — block request
  if (projectStatus === PROJECT_CB_STATUS.OPEN) {
    return {
      allowed: false,
      status: PROJECT_CB_STATUS.OPEN,
      projectId,
      response: createCircuitBreakerResponse({
        error: 'Service paused due to resource limits exceeded',
        code: CB_ERROR_CODES.PROJECT,
        retryAfterSeconds: 1800,
      }),
    };
  }

  // WARNING: Soft limit exceeded — allow with logging
  if (projectStatus === PROJECT_CB_STATUS.WARNING) {
    getLog().warn('Request allowed despite budget warning', undefined, {
      type: 'budget_exceeded',
      project: projectId,
      status: 'warning',
    });

    return {
      allowed: true,
      status: PROJECT_CB_STATUS.WARNING,
      projectId,
      response: null,
    };
  }

  // CLOSED (active or null): Normal operation
  return {
    allowed: true,
    status: PROJECT_CB_STATUS.CLOSED,
    projectId,
    response: null,
  };
}

/**
 * Simple circuit breaker check — returns a Response to block, or null to proceed.
 *
 * @param projectKey - The KV key for the project status (use CB_PROJECT_KEYS or createProjectKey)
 * @param kv - KV namespace binding (PLATFORM_CACHE)
 * @returns Response if circuit is tripped (return immediately), null if OK to proceed
 */
export async function checkProjectCircuitBreaker(
  projectKey: string,
  kv: KVNamespace
): Promise<Response | null> {
  const result = await checkProjectCircuitBreakerDetailed(projectKey, kv);
  return result.response;
}

// =============================================================================
// STATUS QUERIES
// =============================================================================

/**
 * Get the circuit breaker status for a single project.
 * Primary API for per-account use in multi-account deployments.
 *
 * @param kv - KV namespace
 * @param projectKey - PROJECT:{SLUG}:STATUS key
 * @returns Current status value or null if not set
 */
export async function getProjectStatus(
  kv: KVNamespace,
  projectKey: string
): Promise<CircuitBreakerStatusValue | null> {
  return (await kv.get(projectKey)) as CircuitBreakerStatusValue | null;
}

/**
 * Get circuit breaker states for multiple projects.
 * Returns a dynamic record (not hardcoded booleans) for multi-account flexibility.
 *
 * @param kv - KV namespace
 * @param projectKeys - Project keys to check (defaults to all known projects)
 * @returns Record of project slug -> status value
 */
export async function getCircuitBreakerStates(
  kv: KVNamespace,
  projectKeys?: string[]
): Promise<Record<string, CircuitBreakerStatusValue | 'global_stop' | null>> {
  const keys =
    projectKeys ??
    Object.values(CB_PROJECT_KEYS).filter((k) => k !== CB_PROJECT_KEYS.GLOBAL_STOP);

  const globalStop = await kv.get(GLOBAL_STOP_KEY);

  const results: Record<string, CircuitBreakerStatusValue | 'global_stop' | null> = {
    globalStop: globalStop === 'true' ? 'global_stop' : null,
  };

  const statuses = await Promise.all(keys.map((k) => kv.get(k)));
  keys.forEach((key, i) => {
    const slug = key.match(/PROJECT:([^:]+):STATUS/)?.[1]?.toLowerCase() ?? key;
    results[slug] = statuses[i] as CircuitBreakerStatusValue | null;
  });

  return results;
}

// =============================================================================
// STATUS WRITES
// =============================================================================

/**
 * Set project circuit breaker status in KV.
 * Used by budget-enforcement and platform-agent to write CB state.
 *
 * @param kv - Target KV namespace (local or remote)
 * @param projectKey - PROJECT:{SLUG}:STATUS key
 * @param status - active/warning/paused
 * @param ttlSeconds - Expiry (default 86400 = 24h, matches budget-enforcement)
 */
export async function setProjectStatus(
  kv: KVNamespace,
  projectKey: string,
  status: CircuitBreakerStatusValue,
  ttlSeconds: number = 86400
): Promise<void> {
  await kv.put(projectKey, status, { expirationTtl: ttlSeconds });
}

// =============================================================================
// GLOBAL STOP
// =============================================================================

/**
 * Check if global stop is active.
 *
 * @param kv - KV namespace
 * @returns true if global stop is enabled
 */
export async function isGlobalStopActive(kv: KVNamespace): Promise<boolean> {
  return (await kv.get(GLOBAL_STOP_KEY)) === 'true';
}

/**
 * Set global stop on a specific KV namespace.
 *
 * @param kv - Target KV namespace
 * @param enabled - true to enable global stop, false to disable
 */
export async function setGlobalStop(kv: KVNamespace, enabled: boolean): Promise<void> {
  if (enabled) {
    await kv.put(GLOBAL_STOP_KEY, 'true');
  } else {
    await kv.delete(GLOBAL_STOP_KEY);
  }
}

// =============================================================================
// HONO MIDDLEWARE FACTORY
// =============================================================================

/**
 * Hono middleware factory for circuit breaker checks.
 *
 * Features:
 * - Blocks requests when OPEN (paused) with 503 response
 * - Allows requests when WARNING but adds X-Platform-Budget: Warning header
 * - Normal passthrough when CLOSED (active)
 * - Skips configurable paths (default: health endpoints)
 *
 * Uses loose Hono types (no Hono dependency).
 *
 * @param projectKey - The KV key for the project status
 * @param options - Middleware options (e.g., custom skipPaths)
 * @returns Hono-compatible middleware function
 */
export function createCircuitBreakerMiddleware(
  projectKey: string,
  options?: CircuitBreakerMiddlewareOptions
) {
  const skipPaths = options?.skipPaths ?? DEFAULT_SKIP_PATHS;

  return async (
    c: {
      env: { PLATFORM_CACHE: KVNamespace };
      req: { path: string };
      res: Response;
    },
    next: () => Promise<void | Response>
  ): Promise<void | Response> => {
    // Skip configured paths (allows monitoring during circuit break)
    const path = c.req.path;
    if (skipPaths.some((skip) => path === skip || path.startsWith(skip))) {
      return next();
    }

    const result = await checkProjectCircuitBreakerDetailed(projectKey, c.env.PLATFORM_CACHE);

    // OPEN: Block request with 503
    if (!result.allowed && result.response) {
      return result.response;
    }

    // WARNING: Allow but add header for client visibility
    if (result.status === PROJECT_CB_STATUS.WARNING) {
      await next();
      const response = c.res;
      const newResponse = new Response(response.body, response);
      newResponse.headers.set(BUDGET_STATUS_HEADER, 'Warning');
      return newResponse;
    }

    // CLOSED: Normal passthrough
    return next();
  };
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Create a standard 503 circuit breaker response.
 */
function createCircuitBreakerResponse(errorInfo: CircuitBreakerErrorResponse): Response {
  return new Response(
    JSON.stringify({
      success: false,
      error: errorInfo.error,
      code: errorInfo.code,
      retryAfterSeconds: errorInfo.retryAfterSeconds,
    }),
    {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(errorInfo.retryAfterSeconds),
        'X-Circuit-Breaker': errorInfo.code,
      },
    }
  );
}
