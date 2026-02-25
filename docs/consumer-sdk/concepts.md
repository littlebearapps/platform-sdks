# Architecture Concepts

This document explains how the Platform Consumer SDK works internally — the proxy architecture, circuit breaker hierarchy, and telemetry flow.

## Why Proxies?

Cloudflare Workers bindings (`env.DB`, `env.KV`, `env.AI`, etc.) are native platform objects. There's no hook or middleware system to intercept calls to them at the API level. JavaScript's `Proxy` lets the SDK wrap these bindings transparently — your code uses `tracked.DB.prepare(sql).all()` exactly as you would use `env.DB.prepare(sql).all()`, but every operation is counted.

## The Three-Layer Proxy Stack

When you call `withFeatureBudget(env, featureId, options)`, the SDK creates three nested proxy layers:

```
Your Code
    ↓
Layer 3: Health/Fetch Proxy
    Adds .health() and tracked .fetch() methods
    ↓
Layer 2: Circuit Breaker Proxy
    Checks KV for STOP status on first binding access
    ↓
Layer 1: Metrics Proxy
    Intercepts every binding operation, increments counters
    ↓
Original Cloudflare Bindings (env.DB, env.KV, etc.)
```

### Layer 1 — Metrics Proxy (`proxy.ts`)

Each binding type has a dedicated proxy creator:

- `createD1Proxy` — Wraps `prepare`, `batch`, `dump`. Statement proxies wrap `run`, `all`, `first`, `raw` and extract `meta.changes` (writes) and `meta.rows_read` (reads).
- `createKVProxy` — Counts `get`/`getWithMetadata` as reads, `put` as writes, `delete`, `list`.
- `createR2Proxy` — Distinguishes Class A ops (put/delete/list/multipart) from Class B (get/head).
- `createAIProxy` — Counts `run()` calls and tracks model names.
- `createVectorizeProxy` — Counts queries and inserts separately.
- `createQueueProxy` — Counts `send` as 1, `sendBatch` as `messages.length`.
- `createDOProxy` — Wraps `get(id)` to return a stub proxy that tracks `fetch()` latency.
- `createWorkflowProxy` — Counts `create` as 1, `createBatch` as `batch.length`.

The top-level `createEnvProxy` detects binding types using duck-typing (checking for characteristic methods) and delegates to the appropriate proxy creator. Results are cached per binding name — accessing `tracked.DB` twice returns the same proxy.

`PLATFORM_CACHE` and `PLATFORM_TELEMETRY` are explicitly excluded from wrapping (they're the SDK's own infrastructure).

All counters accumulate in a single `MetricsAccumulator` object per request — a mutable struct with 20+ numeric fields and a `Map<string, number>` for AI model breakdown.

### Layer 2 — Circuit Breaker Proxy

Wraps the metrics proxy. The circuit breaker check is **lazy** — it doesn't fire when you call `withFeatureBudget`. It fires on the **first access** to a non-Platform binding.

When triggered, it reads three KV keys in parallel:

| Key | Level | Set By |
|-----|-------|--------|
| `CONFIG:GLOBAL:STATUS` | Global kill switch | Manual (emergency) |
| `CONFIG:PROJECT:{project}:STATUS` | Project-level | Budget enforcement |
| `CONFIG:FEATURE:{featureId}:STATUS` | Feature-level | Budget enforcement |

If any returns `STOP`, a `CircuitBreakerError` is thrown with the level and optional reason. The result is cached in a per-request `Map` — subsequent binding accesses skip the KV check.

**Synchronous method handling**: Builder methods like `prepare()`, `bind()`, `idFromName()`, `fetch()`, and `connect()` are bound to the original target (using `.bind()`) rather than wrapped in async proxies. This is critical for two reasons:
1. It prevents "Illegal invocation" errors on native Cloudflare Fetcher bindings
2. It ensures `CircuitBreakerError` is thrown by the subsequent async method (`.all()`, `.run()`) where it can be caught, not by the synchronous builder

### Layer 3 — Health/Fetch Proxy

Adds two methods to the tracked environment:

- **`health()`** — Dual-plane health check. Control plane: reads a test key from KV. Data plane: sends a heartbeat message to the telemetry queue. Returns `{ controlPlane: { kv: ... }, dataPlane: { queue: ... } }`.
- **`fetch(url, init)`** — Standard `fetch` that auto-detects AI Gateway URLs (`gateway.ai.cloudflare.com/v1/...`) and reports usage metrics for the detected provider and model.

## Telemetry Flow

```
withFeatureBudget(env, featureId, opts)
    │
    │  Creates MetricsAccumulator (all counters = 0)
    │  Stores TelemetryContext in WeakMap keyed on proxy object
    ↓
tracked.DB.prepare(sql).all()
    │  Layer 1 increments d1Reads, d1RowsRead from meta
    ↓
tracked.KV.put(key, value)
    │  Layer 1 increments kvWrites
    ↓
completeTracking(tracked)
    │
    ├── Reads TelemetryContext from WeakMap
    ├── Builds TelemetryMessage from MetricsAccumulator
    │   (skips if all metrics are zero AND no errors)
    ├── Sends to TELEMETRY_QUEUE via queue.send()
    │   (fails open — logs but never throws)
    └── Clears WeakMap entry
         ↓
Platform Backend (queue consumer)
    │
    ├── Stores in D1 warehouse (daily rollups)
    └── Writes to Analytics Engine (real-time, 20 double fields)
```

### TelemetryMessage Wire Format

```typescript
{
  feature_key: 'myapp:api:main',      // Full feature ID
  project: 'myapp',                    // Extracted from feature ID
  category: 'api',                     // Extracted from feature ID
  feature: 'main',                     // Extracted from feature ID
  metrics: {                           // Only non-zero fields included
    d1Reads: 5,
    d1RowsRead: 142,
    kvReads: 2,
  },
  timestamp: '2026-02-25T10:30:00.000Z',
  correlation_id: 'a1b2c3d4-...',
  request_duration_ms: 45,
  // Optional fields:
  error_count: 0,
  error_category: undefined,
  error_codes: [],
  is_heartbeat: false,
  external_cost_usd: 0,
  trace_id: '0af7...',
  span_id: '1b2c...',
}
```

### Zero-Value Optimisation

If a request touches no bindings and has no errors, `completeTracking` skips the queue send entirely. This means health checks, CORS preflight responses, and other lightweight handlers produce no telemetry overhead.

## What Gets Tracked

| Binding | Metric Fields | How |
|---------|--------------|-----|
| D1 | `d1Reads`, `d1Writes`, `d1RowsRead`, `d1RowsWritten` | From `result.meta.changes` and `meta.rows_read` |
| KV | `kvReads`, `kvWrites`, `kvDeletes`, `kvLists` | Per-method counting |
| R2 | `r2ClassA`, `r2ClassB` | Class A = write ops, Class B = read ops |
| Workers AI | `aiRequests`, `aiModelCounts` | Per-`run()` call, model name extracted |
| Vectorize | `vectorizeQueries`, `vectorizeInserts` | query/getByIds vs insert/upsert |
| Queue | `queueMessages` | `send` = 1, `sendBatch` = batch length |
| Durable Objects | `doRequests`, `doTotalLatencyMs` | Per-`fetch()` on stub, timing tracked |
| Workflow | `workflowInvocations` | `create` = 1, `createBatch` = batch length |
| AI Gateway | `aiRequests`, `aiModelCounts` | Via `tracked.fetch()` URL detection |

### Analytics Engine Field Mapping

The SDK maps metrics to Analytics Engine's 20 `double` fields. **Positions 1-12 are locked** (legacy compatibility), positions 13-20 are append-only:

| Position | Field |
|----------|-------|
| double1 | `d1Reads` |
| double2 | `d1Writes` |
| double3 | `d1RowsRead` |
| double4 | `d1RowsWritten` |
| double5 | `kvReads` |
| double6 | `kvWrites` |
| double7 | `kvDeletes` |
| double8 | `kvLists` |
| double9 | `aiRequests` |
| double10 | `r2ClassA` |
| double11 | `r2ClassB` |
| double12 | `queueMessages` |
| double13 | `vectorizeQueries` |
| double14 | `vectorizeInserts` |
| double15 | `doRequests` |
| double16 | `workflowInvocations` |
| double17 | `requests` |
| double18 | `cpuMs` |
| double19 | `aiNeurons` |
| double20 | *(reserved)* |

The 20-field limit is a hard constraint of Analytics Engine. Adding new metrics requires careful consideration — `vectorizeDeletes` was removed to stay within the limit.
