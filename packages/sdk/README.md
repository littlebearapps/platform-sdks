# Platform Consumer SDK

**`@littlebearapps/platform-sdk`** — Automatic cost protection, circuit breaking, and telemetry for Cloudflare Workers.

Install in each Worker project. Zero infrastructure dependencies.

## Install

```bash
npm install @littlebearapps/platform-sdk
```

## Quick Start

### Wrap fetch handlers

```typescript
import { withFeatureBudget, CircuitBreakerError, completeTracking } from '@littlebearapps/platform-sdk';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const tracked = withFeatureBudget(env, 'myapp:api:main', { ctx });
    try {
      const result = await tracked.DB.prepare('SELECT * FROM users LIMIT 100').all();
      return Response.json(result);
    } catch (e) {
      if (e instanceof CircuitBreakerError) {
        return Response.json({ error: 'Feature temporarily disabled' }, { status: 503 });
      }
      throw e;
    } finally {
      ctx.waitUntil(completeTracking(tracked));
    }
  }
};
```

### Wrap cron handlers

```typescript
import { withCronBudget, completeTracking } from '@littlebearapps/platform-sdk';

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const tracked = withCronBudget(env, 'myapp:cron:daily-sync', { ctx });
    try {
      // Your cron logic using tracked.DB, tracked.KV, etc.
    } finally {
      ctx.waitUntil(completeTracking(tracked));
    }
  }
};
```

### Wrap queue handlers

```typescript
import { withQueueBudget, completeTracking } from '@littlebearapps/platform-sdk';

export default {
  async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext) {
    const tracked = withQueueBudget(env, 'myapp:queue:processor', { ctx });
    try {
      for (const msg of batch.messages) {
        // Process using tracked.DB, tracked.KV, etc.
        msg.ack();
      }
    } finally {
      ctx.waitUntil(completeTracking(tracked));
    }
  }
};
```

## Exports

### Main (`@littlebearapps/platform-sdk`)

| Export | Description |
|--------|------------|
| `withFeatureBudget()` | Wrap `fetch` handlers — proxies bindings with automatic tracking |
| `withCronBudget()` | Wrap `scheduled` handlers |
| `withQueueBudget()` | Wrap `queue` handlers |
| `CircuitBreakerError` | Thrown when a feature's budget is exhausted |
| `completeTracking()` | Flush pending metrics (call in `finally` or `ctx.waitUntil`) |
| `createLogger()` | Structured logger with correlation IDs |
| `createLoggerFromRequest()` | Logger from incoming request context |
| `pingHeartbeat()` | Gatus/Uptime heartbeat integration |
| `health()` | Health check helper with heartbeat support |
| `withRetry()` | Retry with exponential backoff |
| `withTimeout()` | Timeout wrapper for async operations |

### Sub-path Exports (v0.2.0+)

| Export | Description |
|--------|------------|
| `@littlebearapps/platform-sdk/middleware` | Project-level circuit breaker middleware (Hono-compatible) |
| `@littlebearapps/platform-sdk/patterns` | 56 static transient error patterns for Cloudflare Workers |
| `@littlebearapps/platform-sdk/dynamic-patterns` | Runtime pattern loading from KV with ReDoS-safe DSL |
| `@littlebearapps/platform-sdk/heartbeat` | Heartbeat helpers for Gatus/uptime monitoring |
| `@littlebearapps/platform-sdk/retry` | Retry utilities with backoff |
| `@littlebearapps/platform-sdk/costs` | Cloudflare pricing constants |

## Required Bindings

Add to your `wrangler.jsonc`:

```jsonc
{
  "kv_namespaces": [
    { "binding": "PLATFORM_CACHE", "id": "YOUR_KV_NAMESPACE_ID" }
  ],
  "queues": {
    "producers": [
      { "binding": "TELEMETRY_QUEUE", "queue": "your-telemetry-queue" }
    ]
  }
}
```

## Configuration

Budget limits and circuit breaker thresholds are stored in KV (`PLATFORM_CACHE`) under the `CONFIG:FEATURE:` prefix. They're synced from `budgets.yaml` via the Admin SDK's sync script.

## License

MIT
