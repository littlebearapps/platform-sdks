# Project-Level Middleware

The `/middleware` sub-path export provides project-level circuit breakers — request-gating that blocks or warns all traffic to an entire project, independent of individual feature budgets.

## Import

```typescript
import {
  createCircuitBreakerMiddleware,
  checkProjectCircuitBreaker,
  checkProjectCircuitBreakerDetailed,
  CB_PROJECT_KEYS,
  PROJECT_CB_STATUS,
} from '@littlebearapps/platform-consumer-sdk/middleware';
```

## Hono Middleware

The recommended approach for Hono-based workers:

```typescript
import { Hono } from 'hono';
import { createCircuitBreakerMiddleware, CB_PROJECT_KEYS } from '@littlebearapps/platform-consumer-sdk/middleware';

type Bindings = {
  PLATFORM_CACHE: KVNamespace;
  DB: D1Database;
};

const app = new Hono<{ Bindings: Bindings }>();

// Apply to all routes
app.use('*', createCircuitBreakerMiddleware(CB_PROJECT_KEYS.SCOUT, {
  skipPaths: ['/health', '/healthz', '/_health'],
}));

app.get('/health', (c) => c.json({ status: 'ok' }));

app.get('/api/data', async (c) => {
  // Only reached if project status is active or warning
  const data = await c.env.DB.prepare('SELECT * FROM items LIMIT 10').all();
  return c.json(data);
});

export default app;
```

### Middleware Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `skipPaths` | `string[]` | `['/health', '/healthz', '/_health']` | Paths that bypass the circuit breaker |

### Behaviour by State

| Project State | HTTP Response | Headers |
|--------------|--------------|---------|
| `active` | Request passes through | None |
| `warning` | Request passes through | `X-Platform-Budget: Warning` |
| `paused` | 503 Service Unavailable | `Retry-After: 1800` |

The `X-Platform-Budget: Warning` header lets downstream clients or monitoring detect that a project is approaching its limits.

## Plain Workers (No Hono)

For workers without Hono, use the simple check function:

```typescript
import { checkProjectCircuitBreaker, CB_PROJECT_KEYS } from '@littlebearapps/platform-consumer-sdk/middleware';

export default {
  async fetch(request: Request, env: Env) {
    // Returns a 503 Response if paused, or null if OK
    const blocked = await checkProjectCircuitBreaker(CB_PROJECT_KEYS.SCOUT, env.PLATFORM_CACHE);
    if (blocked) return blocked;

    // Normal handling
    return new Response('Hello');
  }
};
```

### Detailed Check

For more control over the response:

```typescript
import { checkProjectCircuitBreakerDetailed, CB_PROJECT_KEYS } from '@littlebearapps/platform-consumer-sdk/middleware';

const result = await checkProjectCircuitBreakerDetailed(CB_PROJECT_KEYS.SCOUT, env.PLATFORM_CACHE);

if (!result.allowed) {
  // result.status = 'paused'
  // result.projectId = 'PROJECT:SCOUT:STATUS'
  // result.response = 503 Response object
  return result.response;
}

if (result.status === 'warning') {
  // Project is in warning state — request is allowed but approaching limits
  console.log('Budget warning for project', result.projectId);
}
```

## Pre-Defined Project Keys

The SDK exports keys for known projects:

```typescript
import { CB_PROJECT_KEYS } from '@littlebearapps/platform-consumer-sdk/middleware';

CB_PROJECT_KEYS.SCOUT              // 'PROJECT:SCOUT:STATUS'
CB_PROJECT_KEYS.BRAND_COPILOT      // 'PROJECT:BRAND-COPILOT:STATUS'
CB_PROJECT_KEYS.AUSTRALIAN_HISTORY_MCP // 'PROJECT:AUSTRALIAN-HISTORY-MCP:STATUS'
CB_PROJECT_KEYS.PLATFORM           // 'PROJECT:PLATFORM:STATUS'
```

### Custom Project Keys

For your own projects, generate the key:

```typescript
import { createProjectKey } from '@littlebearapps/platform-consumer-sdk/middleware';

const key = createProjectKey('my-project');
// 'PROJECT:MY-PROJECT:STATUS'
```

## Global Stop

The global stop overrides all project-level checks:

```typescript
import { isGlobalStopActive, setGlobalStop } from '@littlebearapps/platform-consumer-sdk/middleware';

// Check
const stopped = await isGlobalStopActive(env.PLATFORM_CACHE);

// Enable (blocks everything)
await setGlobalStop(env.PLATFORM_CACHE, true);

// Disable (deletes key, resumes normal operation)
await setGlobalStop(env.PLATFORM_CACHE, false);
```

The global stop is checked first in all project-level checks. If active, the response includes `X-Circuit-Breaker-Level: global`.

## Status Management

Read and write project status directly:

```typescript
import { getProjectStatus, setProjectStatus, PROJECT_CB_STATUS } from '@littlebearapps/platform-consumer-sdk/middleware';

// Read current status
const status = await getProjectStatus(env.PLATFORM_CACHE, 'PROJECT:SCOUT:STATUS');
// null (no key), 'active', 'warning', or 'paused'

// Set status with TTL (auto-recovers after TTL expires)
await setProjectStatus(env.PLATFORM_CACHE, 'PROJECT:SCOUT:STATUS', 'paused', 3600); // 1 hour

// Set status without TTL (persists until manually changed)
await setProjectStatus(env.PLATFORM_CACHE, 'PROJECT:SCOUT:STATUS', 'active');
```

## No Hono Dependency

The middleware uses loose structural types — it's compatible with Hono but does not import or depend on it. Any framework that provides `{ env: { PLATFORM_CACHE: KVNamespace } }` context and `next()` will work.
