# Circuit Breakers

The SDK implements a three-tier circuit breaker hierarchy to protect against runaway costs at different granularities.

## Hierarchy

```
Global Kill Switch (GLOBAL_STOP_ALL)
    │  Blocks everything immediately
    ↓
Project Level (PROJECT:{SLUG}:STATUS)
    │  Request-gating: active / warning / paused
    ↓
Feature Level (CONFIG:FEATURE:{id}:STATUS)
    │  Budget enforcement: GO / STOP
    ↓
Your Code Executes
```

Each level is checked independently. If any level blocks, the request is stopped.

## Feature-Level Circuit Breaker (SDK Core)

This is the default protection built into `withFeatureBudget`. It checks KV on first binding access and throws `CircuitBreakerError` if the feature is stopped.

### How It Works

1. The Platform backend monitors daily usage per feature via telemetry
2. When usage exceeds the budget defined in `budgets.yaml`, the backend writes `STOP` to KV
3. On the next request, the SDK reads KV and throws `CircuitBreakerError`
4. Budget resets daily (or as configured)

### KV Keys

| Key Pattern | Value | Set By |
|-------------|-------|--------|
| `CONFIG:FEATURE:{featureId}:STATUS` | `GO` or `STOP` | Budget enforcement worker |
| `CONFIG:FEATURE:{featureId}:REASON` | Human-readable reason | Budget enforcement worker |
| `CONFIG:FEATURE:{featureId}:DISABLED_AT` | ISO timestamp | Budget enforcement worker |
| `CONFIG:FEATURE:{featureId}:AUTO_RESET_AT` | ISO timestamp | Budget enforcement worker |

### Handling CircuitBreakerError

```typescript
import { withFeatureBudget, CircuitBreakerError } from '@littlebearapps/platform-consumer-sdk';

try {
  const tracked = withFeatureBudget(env, 'myapp:api:main', { ctx });
  // CircuitBreakerError is thrown on first binding access, not here
  await tracked.DB.prepare('SELECT 1').all();
} catch (e) {
  if (e instanceof CircuitBreakerError) {
    console.log(e.featureId); // 'myapp:api:main'
    console.log(e.level);     // 'feature' | 'project' | 'global'
    console.log(e.reason);    // 'Daily D1 write budget exceeded (50,000/50,000)'
    return new Response('Service temporarily unavailable', {
      status: 503,
      headers: { 'Retry-After': '3600' },
    });
  }
  throw e;
}
```

### Manual Override

Re-enable a stopped feature:

```typescript
import { setCircuitBreakerStatus } from '@littlebearapps/platform-consumer-sdk';

// Re-enable
await setCircuitBreakerStatus('myapp:api:main', 'GO', env.PLATFORM_CACHE);

// Manually stop with reason
await setCircuitBreakerStatus('myapp:api:main', 'STOP', env.PLATFORM_CACHE, 'Maintenance window');
```

Or via wrangler CLI:

```bash
wrangler kv key put CONFIG:FEATURE:myapp:api:main:STATUS GO --namespace-id YOUR_KV_ID
```

### Check Without Throwing

```typescript
import { isFeatureEnabled } from '@littlebearapps/platform-consumer-sdk';

const enabled = await isFeatureEnabled('myapp:api:main', env.PLATFORM_CACHE);
if (!enabled) {
  return Response.json({ degraded: true, reason: 'Feature budget reached' });
}
```

### Skip Circuit Breaker Check

For non-critical paths where you want tracking but not protection:

```typescript
const tracked = withFeatureBudget(env, 'myapp:api:main', {
  ctx,
  checkCircuitBreaker: false, // Skip KV check
});
```

## Project-Level Circuit Breaker (Middleware)

Imported from the `/middleware` sub-path. This provides request-gating at the project level — blocking or warning all requests to a project, not just individual features.

### States

| State | KV Value | Behaviour |
|-------|----------|-----------|
| `active` | `active` | Normal operation |
| `warning` | `warning` | Requests pass, `X-Platform-Budget: Warning` header added |
| `paused` | `paused` | 503 response, `Retry-After: 1800` (30 minutes) |

### KV Keys

| Key | Purpose |
|-----|---------|
| `PROJECT:SCOUT:STATUS` | Scout project status |
| `PROJECT:BRAND-COPILOT:STATUS` | Brand Copilot project status |
| `PROJECT:PLATFORM:STATUS` | Platform project status |
| `PROJECT:{SLUG}:STATUS` | Any project (use `createProjectKey(slug)`) |
| `GLOBAL_STOP_ALL` | Global kill switch — blocks all projects |

### Usage with Hono

```typescript
import { createCircuitBreakerMiddleware, CB_PROJECT_KEYS } from '@littlebearapps/platform-consumer-sdk/middleware';

const app = new Hono<{ Bindings: Env }>();

app.use('*', createCircuitBreakerMiddleware(CB_PROJECT_KEYS.SCOUT, {
  skipPaths: ['/health', '/healthz', '/_health'],
}));

app.get('/api/data', async (c) => {
  // Only reached if project is active or warning
  return c.json({ data: 'ok' });
});
```

### Usage Without Hono

```typescript
import { checkProjectCircuitBreaker, CB_PROJECT_KEYS } from '@littlebearapps/platform-consumer-sdk/middleware';

export default {
  async fetch(request: Request, env: Env) {
    const blocked = await checkProjectCircuitBreaker(CB_PROJECT_KEYS.SCOUT, env.PLATFORM_CACHE);
    if (blocked) return blocked; // 503 Response

    // Normal handling
    return new Response('OK');
  }
};
```

### Manual Project Control

```typescript
import { setProjectStatus, isGlobalStopActive, setGlobalStop } from '@littlebearapps/platform-consumer-sdk/middleware';

// Pause a project (24-hour TTL by default)
await setProjectStatus(env.PLATFORM_CACHE, 'PROJECT:SCOUT:STATUS', 'paused', 86400);

// Resume
await setProjectStatus(env.PLATFORM_CACHE, 'PROJECT:SCOUT:STATUS', 'active');

// Global emergency stop
await setGlobalStop(env.PLATFORM_CACHE, true);

// Check if global stop is active
const stopped = await isGlobalStopActive(env.PLATFORM_CACHE);
```

See [Middleware Guide](middleware.md) for more details.

## Global Kill Switch

The ultimate safety mechanism. Setting `GLOBAL_STOP_ALL` to `true` in KV blocks all features and all projects immediately.

```bash
# Emergency stop
wrangler kv key put GLOBAL_STOP_ALL true --namespace-id YOUR_KV_ID

# Resume
wrangler kv key delete GLOBAL_STOP_ALL --namespace-id YOUR_KV_ID
```

Or programmatically:

```typescript
import { setGlobalStop } from '@littlebearapps/platform-consumer-sdk/middleware';

await setGlobalStop(env.PLATFORM_CACHE, true);  // Block everything
await setGlobalStop(env.PLATFORM_CACHE, false); // Resume (deletes key)
```

## Multi-Project Status Query

Check the status of multiple projects at once:

```typescript
import { getCircuitBreakerStates, CB_PROJECT_KEYS } from '@littlebearapps/platform-consumer-sdk/middleware';

const states = await getCircuitBreakerStates(env.PLATFORM_CACHE, [
  CB_PROJECT_KEYS.SCOUT,
  CB_PROJECT_KEYS.BRAND_COPILOT,
  CB_PROJECT_KEYS.PLATFORM,
]);

// states = {
//   'PROJECT:SCOUT:STATUS': { status: 'active', ... },
//   'PROJECT:BRAND-COPILOT:STATUS': { status: 'warning', ... },
//   'PROJECT:PLATFORM:STATUS': { status: 'active', ... },
// }
```

## How Feature-Level and Project-Level Interact

Both systems operate independently:

- **Feature-level** (SDK core): Checked inside `withFeatureBudget` on first binding access. Throws `CircuitBreakerError`. Granularity: per-feature.
- **Project-level** (middleware): Checked at request entry before any business logic. Returns 503 Response. Granularity: per-project.

A request can pass the project-level check but still be blocked by a feature-level circuit breaker if that specific feature's budget is exhausted. Conversely, pausing a project at the project level blocks all requests regardless of individual feature status.

For maximum protection, use both:

```typescript
import { createCircuitBreakerMiddleware, CB_PROJECT_KEYS } from '@littlebearapps/platform-consumer-sdk/middleware';
import { withFeatureBudget, CircuitBreakerError } from '@littlebearapps/platform-consumer-sdk';

const app = new Hono<{ Bindings: Env }>();

// Project-level gate (blocks all requests if paused)
app.use('*', createCircuitBreakerMiddleware(CB_PROJECT_KEYS.SCOUT));

app.get('/api/scan', async (c) => {
  const tracked = withFeatureBudget(c.env, 'scout:scanner:main', { ctx: c.executionCtx });
  try {
    // Feature-level gate (blocks if this specific feature's budget is exhausted)
    const result = await tracked.DB.prepare('SELECT * FROM scans LIMIT 10').all();
    return c.json(result);
  } catch (e) {
    if (e instanceof CircuitBreakerError) {
      return c.json({ error: 'Scanner budget exhausted' }, 503);
    }
    throw e;
  } finally {
    c.executionCtx.waitUntil(completeTracking(tracked));
  }
});
```
