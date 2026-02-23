# Platform Consumer SDK

**`@littlebearapps/platform-consumer-sdk`** — Automatic cost protection, circuit breaking, and telemetry for Cloudflare Workers.

Install in each Worker project. Zero production dependencies.

## Install

```bash
npm install @littlebearapps/platform-consumer-sdk
```

## Quick Start

### Wrap fetch handlers

```typescript
import { withFeatureBudget, CircuitBreakerError, completeTracking } from '@littlebearapps/platform-consumer-sdk';

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
import { withCronBudget, completeTracking } from '@littlebearapps/platform-consumer-sdk';

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const tracked = withCronBudget(env, 'myapp:cron:daily-sync', { ctx, cronExpression: event.cron });
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
import { withQueueBudget, completeTracking } from '@littlebearapps/platform-consumer-sdk';

export default {
  async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext) {
    for (const msg of batch.messages) {
      const tracked = withQueueBudget(env, 'myapp:queue:processor', {
        message: msg.body, queueName: 'my-queue',
      });
      try {
        // Process using tracked.DB, tracked.KV, etc.
        msg.ack();
      } finally {
        ctx.waitUntil(completeTracking(tracked));
      }
    }
  }
};
```

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

## Exports

### Main (`@littlebearapps/platform-consumer-sdk`)

#### Core Wrappers

| Export | Description |
|--------|------------|
| `withFeatureBudget(env, featureId, opts?)` | Wrap `fetch` handlers — proxies bindings with automatic tracking |
| `withCronBudget(env, featureId, opts)` | Wrap `scheduled` handlers (deterministic correlation ID from cron expression) |
| `withQueueBudget(env, featureId, opts?)` | Wrap `queue` handlers (extracts correlation ID from message body) |
| `completeTracking(env)` | Flush pending metrics — call in `finally` or `ctx.waitUntil()` |
| `CircuitBreakerError` | Thrown when a feature's budget is exhausted (has `featureId`, `level`, `reason`) |
| `health(featureId, kv, queue?, ctx?)` | Dual-plane health check (KV connectivity + queue delivery) |

#### Circuit Breaker Management

| Export | Description |
|--------|------------|
| `isFeatureEnabled(featureId, kv)` | Check if a feature is enabled (returns boolean) |
| `setCircuitBreakerStatus(featureId, status, kv, reason?)` | Set GO/STOP status for a feature |
| `clearCircuitBreakerCache()` | Clear per-request circuit breaker cache |

#### Logging and Correlation

| Export | Description |
|--------|------------|
| `createLogger(opts)` | Structured logger with correlation IDs |
| `createLoggerFromEnv(env, opts)` | Logger auto-configured from environment |
| `createLoggerFromRequest(request, env, opts)` | Logger from incoming request context |
| `generateCorrelationId()` | Generate a new correlation ID |
| `getCorrelationId(env)` / `setCorrelationId(env, id)` | Get/set correlation ID on environment |

#### Error Tracking

| Export | Description |
|--------|------------|
| `categoriseError(error)` | Categorise error as `transient`, `client`, `server`, `unknown` |
| `reportError(env, error)` | Report error to telemetry context |
| `reportErrorExplicit(env, code, message)` | Report with explicit code and message |
| `withErrorTracking(env, fn)` | Wrapper that automatically reports errors |
| `trackError(env, error)` | Track error count without reporting |

#### Distributed Tracing (W3C Traceparent)

| Export | Description |
|--------|------------|
| `createTraceContext(request?)` | Create trace context from request headers |
| `extractTraceContext(request)` / `getTraceContext(env)` | Extract/get current trace context |
| `parseTraceparent(header)` / `formatTraceparent(ctx)` | Parse/format W3C traceparent |
| `propagateTraceContext(headers)` | Add trace headers to outgoing requests |
| `createTracedFetch(env)` | Wrapped fetch that auto-propagates trace context |
| `startSpan(name)` / `endSpan(span)` / `failSpan(span, error)` | Span lifecycle management |

#### Timeout Utilities

| Export | Description |
|--------|------------|
| `withTimeout(promise, ms)` | Race a promise against a timeout |
| `withTrackedTimeout(env, promise, ms, feature)` | Timeout with metrics tracking |
| `withRequestTimeout(request, promise)` | Timeout based on request deadline header |
| `TimeoutError` | Error class thrown on timeout |
| `DEFAULT_TIMEOUTS` | Preset timeout values (short: 5s, medium: 15s, long: 30s) |

#### Service Client (Cross-Worker Correlation)

| Export | Description |
|--------|------------|
| `createServiceClient(binding, opts)` | Service binding wrapper with correlation propagation |
| `wrapServiceBinding(binding, opts)` | Lightweight service binding wrapper |
| `createServiceBindingHeaders(env)` | Generate correlation chain headers |
| `extractCorrelationChain(request)` | Extract chain from incoming request |

#### AI Gateway

| Export | Description |
|--------|------------|
| `createAIGatewayFetch(env, gateway, provider)` | AI Gateway request wrapper |
| `createAIGatewayFetchWithBodyParsing(env, gateway, provider)` | With response body parsing |
| `parseAIGatewayUrl(url)` | Extract provider/model from AI Gateway URL |
| `reportAIGatewayUsage(env, provider, model)` | Track AI call metrics |

#### Proxy Utilities

| Export | Description |
|--------|------------|
| `createD1Proxy(db, metrics)` | D1 binding proxy with metrics |
| `createKVProxy(kv, metrics)` | KV binding proxy with metrics |
| `createAIProxy(ai, metrics)` | Workers AI proxy with metrics |
| `createR2Proxy(r2, metrics)` | R2 binding proxy with metrics |
| `createQueueProxy(queue, metrics)` | Queue binding proxy with metrics |
| `createVectorizeProxy(index, metrics)` | Vectorize binding proxy with metrics |
| `getMetrics(proxy)` | Extract accumulated metrics from any proxy |

#### Other Utilities

| Export | Description |
|--------|------------|
| `pingHeartbeat(url, token?)` | Gatus/uptime heartbeat ping |
| `withExponentialBackoff(fn, opts?)` | Retry with exponential backoff (3 attempts) |
| `withHeartbeat(DOClass, config)` | Durable Object class wrapper with heartbeat |
| `PRICING_TIERS` / `PAID_ALLOWANCES` | Cloudflare pricing constants |
| `calculateHourlyCosts(metrics)` / `calculateDailyBillableCosts(usage)` | Cost calculation helpers |
| `KV_KEYS` / `CIRCUIT_STATUS` / `METRIC_FIELDS` / `BINDING_NAMES` | SDK constants |
| `PLATFORM_FEATURES` / `getAllPlatformFeatures()` | Platform worker feature IDs |

### Sub-path Exports (v0.2.0+)

#### `@littlebearapps/platform-consumer-sdk/middleware`

Project-level circuit breaker middleware. Two-tier system: feature-level (SDK core) + project-level (this module).

```typescript
import { createCircuitBreakerMiddleware, CB_PROJECT_KEYS } from '@littlebearapps/platform-consumer-sdk/middleware';

// Hono middleware
const app = new Hono<{ Bindings: Env }>();
app.use('*', createCircuitBreakerMiddleware(CB_PROJECT_KEYS.SCOUT, {
  skipPaths: ['/health', '/healthz'],
}));
```

| Export | Description |
|--------|------------|
| `checkProjectCircuitBreaker(key, kv)` | Simple check — returns Response or null |
| `checkProjectCircuitBreakerDetailed(key, kv)` | Detailed check with status/reason |
| `createCircuitBreakerMiddleware(key, opts?)` | Hono middleware factory |
| `getCircuitBreakerStates(keys, kv)` | Query multiple projects at once |
| `getProjectStatus(key, kv)` / `setProjectStatus(key, status, kv)` | Read/write project CB |
| `isGlobalStopActive(kv)` / `setGlobalStop(active, kv)` | Global kill switch |
| `CB_PROJECT_KEYS` | Pre-defined keys for Scout, Brand Copilot, etc. |
| `PROJECT_CB_STATUS` | Status values: `active`, `warning`, `paused` |

#### `@littlebearapps/platform-consumer-sdk/patterns`

125 static regex patterns for classifying transient (expected operational) errors. Zero I/O.

```typescript
import { classifyErrorAsTransient } from '@littlebearapps/platform-consumer-sdk/patterns';

const result = classifyErrorAsTransient('quotaExceeded: Daily limit reached');
// { isTransient: true, category: 'quota-exhausted' }
```

| Export | Description |
|--------|------------|
| `TRANSIENT_ERROR_PATTERNS` | Array of 125 patterns with regex + category |
| `classifyErrorAsTransient(message)` | Classify a message — returns `{ isTransient, category? }` |

#### `@littlebearapps/platform-consumer-sdk/dynamic-patterns`

AI-discovered patterns loaded from KV at runtime. Constrained DSL with ReDoS protection.

```typescript
import { loadDynamicPatterns, classifyWithDynamicPatterns } from '@littlebearapps/platform-consumer-sdk/dynamic-patterns';

const patterns = await loadDynamicPatterns(env.PLATFORM_CACHE);
const result = classifyWithDynamicPatterns('Custom error message', patterns);
```

| Export | Description |
|--------|------------|
| `loadDynamicPatterns(kv)` | Load approved patterns from KV (5-min cache) |
| `compileDynamicPatterns(rules)` | Compile and validate pattern rules |
| `classifyWithDynamicPatterns(message, patterns)` | Classify against dynamic patterns |
| `exportDynamicPatterns(kv)` | Export patterns for cross-account sync |
| `importDynamicPatterns(kv, rules)` | Import with validation gate |

#### `@littlebearapps/platform-consumer-sdk/heartbeat`

```typescript
import { pingHeartbeat } from '@littlebearapps/platform-consumer-sdk/heartbeat';
await pingHeartbeat('https://status.example.com/api/v1/endpoints/heartbeats_myworker/external');
```

#### `@littlebearapps/platform-consumer-sdk/retry`

```typescript
import { withExponentialBackoff } from '@littlebearapps/platform-consumer-sdk/retry';
const result = await withExponentialBackoff(() => fetchWithRetry(url));
```

#### `@littlebearapps/platform-consumer-sdk/costs`

Cloudflare pricing tiers and cost calculation helpers. Updated for January 2025 pricing.

## Error Handling

`CircuitBreakerError` is thrown when any level of the circuit breaker hierarchy is STOP:

```typescript
try {
  const tracked = withFeatureBudget(env, 'myapp:api:main', { ctx });
  await tracked.DB.prepare('SELECT 1').all();
} catch (e) {
  if (e instanceof CircuitBreakerError) {
    console.log(e.featureId); // 'myapp:api:main'
    console.log(e.level);     // 'feature' | 'project' | 'global'
    console.log(e.reason);    // Optional reason string
    return new Response('Service unavailable', { status: 503 });
  }
}
```

The hierarchy checks in order: **global** (kill switch) > **project** > **feature**.

## Configuration

Budget limits and circuit breaker thresholds are stored in KV (`PLATFORM_CACHE`) under the `CONFIG:FEATURE:` prefix. They're synced from `budgets.yaml` via the Admin SDK's sync script.

## License

MIT
