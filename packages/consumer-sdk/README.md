# Platform Consumer SDK

**`@littlebearapps/platform-consumer-sdk`** — Automatic cost protection, circuit breaking, and telemetry for Cloudflare Workers.

Install in each Worker project. Zero production dependencies. Ships raw TypeScript (bundled by wrangler).

## Install

```bash
npm install @littlebearapps/platform-consumer-sdk
```

### tsconfig Requirement

The SDK ships raw `.ts` source files that wrangler bundles at deploy time. Your `tsconfig.json` must use:

```json
{
  "compilerOptions": {
    "moduleResolution": "bundler"
  }
}
```

This is the default for new wrangler projects. If you see TypeScript errors after installing, check this setting first.

## Quick Start

### Wrap fetch handlers

```typescript
import { withFeatureBudget, completeTracking, CircuitBreakerError } from '@littlebearapps/platform-consumer-sdk';

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

`PLATFORM_CACHE` stores circuit breaker state and budget configuration. `TELEMETRY_QUEUE` carries metrics to the Platform backend.

## How It Works

When you call `withFeatureBudget(env, featureId, options)`, the SDK wraps your environment object with a **three-layer proxy stack**:

### Layer 1 — Metrics Proxy

Every binding on `env` (`DB`, `KV`, `AI`, `R2`, `QUEUE`, etc.) is wrapped with a type-specific proxy that intercepts method calls and increments counters in a per-request `MetricsAccumulator`. For example, `tracked.DB.prepare(sql).all()` increments `d1Reads` and records `d1RowsRead` from the query metadata.

**What gets tracked automatically:**

| Binding | Metrics Tracked |
|---------|----------------|
| D1 | `d1Reads`, `d1Writes`, `d1RowsRead`, `d1RowsWritten` (per-statement via `meta`) |
| KV | `kvReads` (get/getWithMetadata), `kvWrites` (put), `kvDeletes`, `kvLists` |
| R2 | `r2ClassA` (put/delete/list/multipart), `r2ClassB` (get/head) |
| Workers AI | `aiRequests`, model breakdown via `aiModelCounts` |
| Vectorize | `vectorizeQueries` (query/getByIds), `vectorizeInserts` (insert/upsert) |
| Queue | `queueMessages` (send/sendBatch) |
| Durable Objects | `doRequests`, latency tracking (avg/max/p99) |
| Workflow | `workflowInvocations` (create/createBatch) |

### Layer 2 — Circuit Breaker Proxy

Wraps the metrics proxy. On the **first access** to a non-Platform binding (lazy/deferred — not at `withFeatureBudget` call time), the SDK checks three KV keys in parallel:

1. `CONFIG:GLOBAL:STATUS` — Global kill switch
2. `CONFIG:PROJECT:{project}:STATUS` — Project-level stop
3. `CONFIG:FEATURE:{featureId}:STATUS` — Feature-level stop (set by budget enforcement)

If any returns `STOP`, a `CircuitBreakerError` is thrown. The check result is cached for the remainder of the request.

**Synchronous builder methods** (`prepare`, `bind`, `get`, `idFromName`, `idFromString`, `fetch`, `connect`) are bound to the original target rather than async-wrapped. This means `CircuitBreakerError` is thrown by the subsequent async method (e.g. `.all()`, `.run()`), not by the builder itself. This also prevents "Illegal invocation" errors on native Cloudflare Fetcher bindings.

### Layer 3 — Health/Fetch Proxy

Adds two methods to the tracked env:

- `tracked.health()` — Dual-plane health check (KV connectivity + queue delivery test)
- `tracked.fetch(url, init)` — Standard fetch that auto-detects AI Gateway URLs and tracks usage

### Telemetry Flush

When you call `completeTracking(tracked)`, the SDK:

1. Reads the `MetricsAccumulator` from the tracked env
2. Builds a `TelemetryMessage` (skips if all metrics are zero and no errors)
3. Sends to `TELEMETRY_QUEUE` via `queue.send()` — **fails open** (logs but never throws)
4. Clears the tracking context

**Important**: `completeTracking` must be called on the object returned by `withFeatureBudget`, not on the original `env`. The tracking context is stored in a `WeakMap` keyed on the proxy object.

## Feature ID Convention

Feature IDs follow the format `project:category:feature` — three colon-separated parts:

| Example | Project | Category | Feature |
|---------|---------|----------|---------|
| `scout:ocr:process` | scout | ocr | process |
| `brand-copilot:scanner:github` | brand-copilot | scanner | github |
| `myapp:api:main` | myapp | api | main |
| `myapp:cron:daily-sync` | myapp | cron | daily-sync |
| `myapp:queue:processor` | myapp | queue | processor |

**Conventions:**
- Use **kebab-case** for all parts
- `project` should match your `services.yaml` project key
- `category` groups features by billing/operational concern: `api`, `cron`, `queue`, `scanner`, `connector`, `ai`, `do`
- `feature` identifies the specific operation
- Each unique feature ID is a separate budget-trackable unit in `budgets.yaml`

See [Feature ID Guide](../../docs/consumer-sdk/feature-ids.md) for detailed conventions and budget registration.

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
| `createLogger(opts)` | Structured JSON logger with correlation IDs |
| `createLoggerFromEnv(env, worker, featureId?)` | Logger auto-configured from environment |
| `createLoggerFromRequest(request, env, worker, featureId?)` | Logger from incoming request headers (`x-correlation-id`, `cf-ray`) |
| `generateCorrelationId()` | Generate a new UUID correlation ID |
| `getCorrelationId(env)` / `setCorrelationId(env, id)` | Get/set correlation ID on environment |

#### Error Tracking

| Export | Description |
|--------|------------|
| `categoriseError(error)` | Categorise as VALIDATION, NETWORK, AUTH, RATE_LIMIT, D1_ERROR, etc. |
| `reportError(env, error)` | Report error to telemetry context (increments `errorCount`) |
| `reportErrorExplicit(env, category, code?)` | Report with explicit category and code |
| `withErrorTracking(env, fn)` | Wrapper that automatically reports errors on catch (re-throws) |
| `trackError(metrics, error)` | Track error count directly on a metrics accumulator |
| `hasErrors(env)` / `getErrorCount(env)` | Query error state from context |

#### Distributed Tracing (W3C Traceparent)

| Export | Description |
|--------|------------|
| `createTraceContext(request, env)` | Extract or create trace context, stores on env |
| `extractTraceContext(request)` | Parse incoming `traceparent` header, create new span ID |
| `getTraceContext(env)` / `setTraceContext(env, ctx)` | Get/set trace context on environment |
| `parseTraceparent(header)` / `formatTraceparent(ctx)` | Parse/format W3C `00-{traceId}-{spanId}-{flags}` |
| `propagateTraceContext(ctx)` | Create child span headers for outgoing requests |
| `createTracedFetch(ctx)` | Wrapped `fetch` that auto-propagates trace context |
| `startSpan(ctx, name)` / `endSpan(span)` / `failSpan(span, error)` | Span lifecycle management |

#### Timeout Utilities

| Export | Description |
|--------|------------|
| `withTimeout(fn, timeoutMs?, operation?)` | Race an async function against a timeout (default 30s) |
| `withTrackedTimeout(env, fn, timeoutMs, operation)` | Timeout with automatic error reporting to telemetry |
| `withRequestTimeout(handler, timeoutMs, operation)` | Wrap an entire Worker fetch handler with a 504 timeout |
| `timeoutResponse(error?)` | Generate a 504 Gateway Timeout response |
| `TimeoutError` | Error class with `operation`, `timeoutMs`, `actualMs` properties |
| `DEFAULT_TIMEOUTS` | Presets: `short` (5s), `medium` (15s), `long` (30s), `max` (60s) |

#### Service Client (Cross-Worker Correlation)

| Export | Description |
|--------|------------|
| `createServiceClient(env, sourceService, opts?)` | Service binding wrapper with correlation + trace propagation |
| `wrapServiceBinding(fetcher, env, sourceService)` | Lightweight Fetcher wrapper that merges context headers |
| `createServiceBindingHeaders(env, sourceService)` | Generate correlation + trace headers for manual use |
| `extractCorrelationChain(request)` | Extract `{ correlationId, sourceService, traceId, ... }` from incoming request |

#### AI Gateway

| Export | Description |
|--------|------------|
| `createAIGatewayFetch(env)` | Drop-in `fetch` replacement that auto-detects AI Gateway URLs |
| `createAIGatewayFetchWithBodyParsing(env)` | Same but also parses request body for model name (more accurate) |
| `parseAIGatewayUrl(url)` | Extract `{ provider, model, accountId, gatewayId }` from AI Gateway URL |
| `reportAIGatewayUsage(env, provider, model)` | Track AI call metrics manually |

Supported providers: `google-ai-studio`, `openai`, `deepseek`, `anthropic`, `workers-ai`, `azure-openai`, `bedrock`, `groq`, `mistral`, `perplexity`.

#### Proxy Utilities

| Export | Description |
|--------|------------|
| `createD1Proxy(db, metrics)` | D1 binding proxy with metrics |
| `createKVProxy(kv, metrics)` | KV binding proxy with metrics |
| `createAIProxy(ai, metrics)` | Workers AI proxy with metrics |
| `createR2Proxy(r2, metrics)` | R2 binding proxy with metrics |
| `createQueueProxy(queue, metrics)` | Queue binding proxy with metrics |
| `createVectorizeProxy(index, metrics)` | Vectorize binding proxy with metrics |
| `createDOProxy(ns, metrics)` | Durable Object namespace proxy with latency tracking |
| `createWorkflowProxy(workflow, metrics)` | Workflow binding proxy with metrics |
| `createEnvProxy(env, metrics)` | Top-level env proxy (auto-detects binding types) |
| `getMetrics(env)` | Extract accumulated metrics from a tracked env |

#### Other Utilities

| Export | Description |
|--------|------------|
| `pingHeartbeat(ctx, url, token, success?)` | Non-blocking Gatus/uptime heartbeat ping |
| `withExponentialBackoff(fn, attempts?)` | Retry with exponential backoff (default 3 attempts, 100ms base) |
| `withHeartbeat(DOClass, config)` | Durable Object mixin with alarm-based heartbeats |
| `PRICING_TIERS` / `PAID_ALLOWANCES` | Cloudflare pricing constants (Workers Paid plan) |
| `calculateHourlyCosts(metrics)` | Hourly cost breakdown with prorated allowances |
| `calculateDailyBillableCosts(usage, daysElapsed, daysInPeriod)` | Daily billable costs with partial-month proration |
| `KV_KEYS` | Key generation functions: `featureStatus(id)`, `projectStatus(id)`, `globalStatus()`, etc. |
| `CIRCUIT_STATUS` | `{ GO: 'GO', STOP: 'STOP' }` |
| `METRIC_FIELDS` | 20-element Analytics Engine field mapping (positions locked) |
| `BINDING_NAMES` | `{ PLATFORM_CACHE, PLATFORM_TELEMETRY }` |
| `PLATFORM_FEATURES` / `getAllPlatformFeatures()` | Pre-defined feature IDs for Platform workers |

### Sub-path Exports

#### `@littlebearapps/platform-consumer-sdk/middleware`

Project-level circuit breaker middleware. Two-tier system: feature-level (SDK core, GO/STOP) + project-level (this module, active/warning/paused).

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
| `checkProjectCircuitBreaker(key, kv)` | Simple check — returns 503 Response or null |
| `checkProjectCircuitBreakerDetailed(key, kv)` | Detailed check with status, reason, and response |
| `createCircuitBreakerMiddleware(key, opts?)` | Hono-compatible middleware factory |
| `getCircuitBreakerStates(kv, keys?)` | Query multiple projects at once |
| `getProjectStatus(kv, key)` / `setProjectStatus(kv, key, status, ttl?)` | Read/write project CB state |
| `isGlobalStopActive(kv)` / `setGlobalStop(kv, enabled)` | Global kill switch |
| `createProjectKey(slug)` | Generate `PROJECT:{SLUG}:STATUS` key |
| `CB_PROJECT_KEYS` | Pre-defined keys for Scout, Brand Copilot, Platform, etc. |
| `PROJECT_CB_STATUS` | Status values: `active`, `warning`, `paused` |

See [Middleware Guide](../../docs/consumer-sdk/middleware.md) for detailed usage.

#### `@littlebearapps/platform-consumer-sdk/patterns`

125 static regex patterns for classifying transient (expected operational) errors. Zero I/O — pure in-memory matching.

```typescript
import { classifyErrorAsTransient } from '@littlebearapps/platform-consumer-sdk/patterns';

const result = classifyErrorAsTransient('quotaExceeded: Daily limit reached');
// { isTransient: true, category: 'quota-exhausted' }
```

| Export | Description |
|--------|------------|
| `TRANSIENT_ERROR_PATTERNS` | Array of 125 patterns with regex + category |
| `classifyErrorAsTransient(message)` | Classify a message — returns `{ isTransient, category? }` |

Categories include: `quota-exhausted`, `rate-limited`, `service-unavailable`, `timeout`, `connection-refused`, `connection-timeout`, `dns-not-found`, `d1-rate-limited`, `do-reset`, `r2-internal-error`, and many more.

#### `@littlebearapps/platform-consumer-sdk/dynamic-patterns`

AI-discovered patterns loaded from KV at runtime. Constrained DSL with ReDoS protection.

```typescript
import { loadDynamicPatterns, classifyWithDynamicPatterns } from '@littlebearapps/platform-consumer-sdk/dynamic-patterns';

const patterns = await loadDynamicPatterns(env.PLATFORM_CACHE);
const result = classifyWithDynamicPatterns('Custom error message', patterns);
```

| Export | Description |
|--------|------------|
| `loadDynamicPatterns(kv)` | Load approved patterns from KV (5-minute in-memory cache) |
| `compileDynamicPatterns(rules)` | Compile and validate pattern rules |
| `classifyWithDynamicPatterns(message, patterns)` | Classify against loaded patterns |
| `exportDynamicPatterns(kv)` | Export patterns JSON for cross-account sync |
| `importDynamicPatterns(kv, json)` | Import with validation gate (compiles as safety check) |
| `clearDynamicPatternsCache()` | Clear in-memory cache (for testing or post-update) |

DSL types: `contains` (all tokens must appear), `startsWith`, `statusCode` (word-boundary match), `regex` (200-char limit).

#### `@littlebearapps/platform-consumer-sdk/heartbeat`

```typescript
import { pingHeartbeat } from '@littlebearapps/platform-consumer-sdk/heartbeat';

// Non-blocking — uses ctx.waitUntil internally
pingHeartbeat(ctx, 'https://status.example.com/api/v1/endpoints/heartbeats_myworker/external', token);
```

#### `@littlebearapps/platform-consumer-sdk/retry`

```typescript
import { withExponentialBackoff } from '@littlebearapps/platform-consumer-sdk/retry';

// 3 attempts: immediate, 100ms, 200ms (max 1s backoff)
const result = await withExponentialBackoff(() => fetchExternalAPI(url));
```

#### `@littlebearapps/platform-consumer-sdk/costs`

Cloudflare pricing tiers and cost calculation helpers. Updated for current Workers Paid plan pricing.

```typescript
import { calculateHourlyCosts, PRICING_TIERS, PAID_ALLOWANCES } from '@littlebearapps/platform-consumer-sdk/costs';

const costs = calculateHourlyCosts(hourlyMetrics);
// { workers, d1, kv, r2, durableObjects, vectorize, aiGateway, workersAI, pages, queues, workflows, total }
```

## Error Handling

`CircuitBreakerError` is thrown when any level of the circuit breaker hierarchy is STOP:

```typescript
try {
  const tracked = withFeatureBudget(env, 'myapp:api:main', { ctx });
  await tracked.DB.prepare('SELECT 1').all(); // CB check happens here (first binding access)
} catch (e) {
  if (e instanceof CircuitBreakerError) {
    console.log(e.featureId); // 'myapp:api:main'
    console.log(e.level);     // 'feature' | 'project' | 'global'
    console.log(e.reason);    // Optional reason string
    return new Response('Service unavailable', { status: 503 });
  }
}
```

The hierarchy checks in order: **global** (kill switch) > **project** > **feature**. If any level returns STOP, the error includes which level triggered it.

## Configuration

Budget limits and circuit breaker thresholds are stored in KV (`PLATFORM_CACHE`) under the `CONFIG:FEATURE:` prefix. They're synced from `budgets.yaml` via the Admin SDK's sync script.

Requires a Platform backend — scaffold one with [`@littlebearapps/platform-admin-sdk`](https://www.npmjs.com/package/@littlebearapps/platform-admin-sdk).

## Updating

```bash
npm update @littlebearapps/platform-consumer-sdk
```

The Consumer SDK is a **pure library** with zero side effects on update. No database migrations, no KV writes, no config changes. New features are additive and backward compatible within the same major version.

## SDKOptions Reference

Options accepted by `withFeatureBudget`:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `ctx` | `ExecutionContext` | — | Enables `waitUntil` for non-blocking telemetry flush |
| `checkCircuitBreaker` | `boolean` | `true` | Whether to check KV for STOP status |
| `reportTelemetry` | `boolean` | `true` | Whether to queue metrics on completion |
| `cacheKv` | `KVNamespace` | `env.PLATFORM_CACHE` | Override KV namespace for CB checks |
| `telemetryQueue` | `Queue` | `env.PLATFORM_TELEMETRY` | Override telemetry queue |
| `correlationId` | `string` | auto-generated UUID | Request tracing ID |
| `externalCostUsd` | `number` | `0` | Add external API costs (OpenAI, Apify, etc.) |

## Troubleshooting

**`ReferenceError: PLATFORM_CACHE is not defined`**
Add the KV binding to your `wrangler.jsonc`. See [Required Bindings](#required-bindings).

**Metrics not appearing in Platform dashboard**
Check that `TELEMETRY_QUEUE` is bound and the queue exists. The SDK **never throws** if the queue binding is missing — telemetry is silently dropped. Verify with `wrangler queues list`.

**`CircuitBreakerError` on every request**
A circuit breaker is stuck in STOP state. Check KV:
```bash
wrangler kv key get CONFIG:FEATURE:myapp:api:main:STATUS --namespace-id YOUR_KV_ID
```
Reset with:
```bash
wrangler kv key put CONFIG:FEATURE:myapp:api:main:STATUS GO --namespace-id YOUR_KV_ID
```

**Feature usage not tracked**
Verify the feature ID is registered in `budgets.yaml` and you've run `npm run sync:config` to push it to KV.

**`Illegal invocation` when accessing service bindings**
This was fixed in v1.0.0. The SDK now correctly binds native Fetcher methods (`fetch`, `connect`) rather than wrapping them in async proxies. Upgrade to v1.0.0+.

**`completeTracking` seems to have no effect**
`completeTracking` must be called on the object returned by `withFeatureBudget`, not the original `env`. The tracking context is stored in a `WeakMap` keyed on the proxy object:
```typescript
// Correct
const tracked = withFeatureBudget(env, 'myapp:api:main', { ctx });
await completeTracking(tracked);

// Wrong — env has no tracking context
await completeTracking(env);
```

**TypeScript errors after installing**
Ensure `"moduleResolution": "bundler"` in your `tsconfig.json`. The SDK ships raw `.ts` source, not compiled `.js` + `.d.ts`. Also ensure `@cloudflare/workers-types` is installed as a dev dependency.

**`Cannot find module '@littlebearapps/platform-consumer-sdk/middleware'`**
Sub-path exports require `"moduleResolution": "bundler"` or `"nodenext"`. The `"node"` resolution strategy does not support `exports` map in `package.json`.

See [Troubleshooting Guide](../../docs/consumer-sdk/troubleshooting.md) for more issues and solutions.

## Further Reading

- [Architecture Concepts](../../docs/consumer-sdk/concepts.md) — Proxy system deep dive
- [Circuit Breakers](../../docs/consumer-sdk/circuit-breakers.md) — Three-tier protection hierarchy
- [Middleware](../../docs/consumer-sdk/middleware.md) — Project-level circuit breakers for Hono
- [Feature IDs](../../docs/consumer-sdk/feature-ids.md) — Naming conventions and budget registration
- [Telemetry](../../docs/consumer-sdk/telemetry.md) — Metrics format and flush lifecycle
- [Error Patterns](../../docs/consumer-sdk/patterns.md) — Static and dynamic transient error classification
- [Advanced Features](../../docs/consumer-sdk/advanced.md) — Tracing, logging, service client, AI Gateway
- [Troubleshooting](../../docs/consumer-sdk/troubleshooting.md) — Expanded issue guide

## License

MIT
