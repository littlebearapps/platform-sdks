# Telemetry

This document covers how metrics are collected, flushed, and stored by the SDK.

## Collection Flow

```
withFeatureBudget(env, featureId, opts)
    │  Creates MetricsAccumulator (all counters = 0)
    ↓
Your code uses tracked.DB, tracked.KV, etc.
    │  Each operation increments counters in the accumulator
    ↓
completeTracking(tracked)
    │  Builds TelemetryMessage, sends to queue
    ↓
TELEMETRY_QUEUE
    │  Platform backend consumes messages
    ↓
D1 Warehouse + Analytics Engine
```

## MetricsAccumulator

A mutable struct created per request with all counters initialised to zero:

```typescript
{
  d1Reads: 0, d1Writes: 0, d1RowsRead: 0, d1RowsWritten: 0,
  kvReads: 0, kvWrites: 0, kvDeletes: 0, kvLists: 0,
  aiRequests: 0, aiNeurons: 0,
  aiModelCounts: Map {},    // Map<string, number> — e.g. 'google-ai-studio/gemini-2.5-flash-lite' => 3
  vectorizeQueries: 0, vectorizeInserts: 0,
  doRequests: 0, doLatencyMs: [],  doTotalLatencyMs: 0,
  r2ClassA: 0, r2ClassB: 0,
  queueMessages: 0,
  workflowInvocations: 0,
  requests: 0, cpuMs: 0,
  errorCount: 0, lastErrorCategory: undefined,
  errorCodes: [],           // Max 10 unique codes
}
```

## TelemetryMessage Wire Format

The message sent to the telemetry queue:

```typescript
{
  feature_key: 'myapp:api:main',
  project: 'myapp',
  category: 'api',
  feature: 'main',
  metrics: {
    // Only non-zero fields included (zero-value optimisation)
    d1Reads: 5,
    d1RowsRead: 142,
    kvReads: 2,
  },
  timestamp: '2026-02-25T10:30:00.000Z',
  correlation_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  request_duration_ms: 45,

  // Optional fields (only present when relevant):
  is_heartbeat: false,
  error_count: 0,
  error_category: undefined,
  error_codes: [],
  external_cost_usd: 0,
  trace_id: '0af7651916cd43dd8448eb211c80319c',
  span_id: 'b7ad6b7169203331',
}
```

### Zero-Value Optimisation

If all metrics are zero and there are no errors, `completeTracking` skips the queue send entirely. This means lightweight handlers (health checks, CORS preflight, static responses) produce zero telemetry overhead.

The check uses `hasDataToReport(message)` which verifies at least one non-zero metric field exists or `error_count > 0`.

## Flush Lifecycle

### `completeTracking(trackedEnv)`

1. Reads `TelemetryContext` from `WeakMap` (keyed on the proxy object)
2. Calls `buildTelemetryMessage(context)` — converts accumulator to wire format
3. Checks `hasDataToReport(message)` — skips if nothing to send
4. Sends to queue via `queue.send(message)` — **fails open** (catches errors, logs, never throws)
5. If `ctx.waitUntil` is available: uses both `waitUntil` AND direct `await` (belt-and-suspenders)
6. Clears the `WeakMap` entry

### Important: Call on the Right Object

The tracking context is stored in a `WeakMap<object, TelemetryContext>` keyed on the proxy object returned by `withFeatureBudget`. Calling `completeTracking(env)` on the original `env` does nothing.

```typescript
const tracked = withFeatureBudget(env, 'myapp:api:main', { ctx });

// Correct
await completeTracking(tracked);

// Wrong — no tracking context on original env
await completeTracking(env);
```

### `scheduleFlush(ctx, trackedEnv)`

Convenience function that calls `ctx.waitUntil(flushMetrics(trackedEnv))`. Use when you want non-blocking flush without awaiting:

```typescript
import { scheduleFlush } from '@littlebearapps/platform-consumer-sdk';

// Non-blocking — returns immediately
scheduleFlush(ctx, tracked);
```

## Direct Reporting

For cases where you want to report metrics without using the proxy system:

```typescript
import { reportUsage } from '@littlebearapps/platform-consumer-sdk';

await reportUsage('myapp:api:main', {
  d1Reads: 10,
  aiRequests: 1,
}, env.TELEMETRY_QUEUE, ctx);
```

This bypasses the proxy entirely — useful for reporting external API costs or aggregating metrics from a batch job.

## Analytics Engine Field Mapping

The Platform backend writes telemetry to Analytics Engine using a fixed 20-field mapping. The SDK exports this mapping as `METRIC_FIELDS`:

```typescript
import { METRIC_FIELDS } from '@littlebearapps/platform-consumer-sdk';

// METRIC_FIELDS[0] = 'd1Reads'      → double1
// METRIC_FIELDS[1] = 'd1Writes'     → double2
// METRIC_FIELDS[2] = 'd1RowsRead'   → double3
// ...
// METRIC_FIELDS[19] = (reserved)    → double20
```

**Positions 1-12 are locked** (legacy compatibility). Positions 13-20 are append-only. The 20-field limit is a hard constraint of Analytics Engine — new metrics require careful consideration.

## Correlation IDs

Each tracked request gets a correlation ID for end-to-end tracing:

- **fetch handlers**: Auto-generated UUID, or extracted from `x-correlation-id` / `x-request-id` headers
- **cron handlers**: Deterministic format: `cron:{expression}:{epochMs}`
- **queue handlers**: Extracted from `message.body.correlation_id`, or generated as `queue:{queueName}:{epochMs}:{random}`

Access the correlation ID:

```typescript
import { getCorrelationId } from '@littlebearapps/platform-consumer-sdk';

const id = getCorrelationId(tracked);
// 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
```

## External Costs

Track costs from external APIs (OpenAI, Apify, etc.) alongside Cloudflare resource usage:

```typescript
const tracked = withFeatureBudget(env, 'myapp:ai:generate', {
  ctx,
  externalCostUsd: 0.003, // $0.003 for this OpenAI call
});
```

The `external_cost_usd` field is included in the telemetry message and stored in the D1 warehouse for cost aggregation.

## Heartbeat Messages

Heartbeat messages are special telemetry messages with `is_heartbeat: true`. They're used for Durable Object liveness monitoring via the `withHeartbeat` mixin and don't carry metric data.

```typescript
{
  feature_key: 'myapp:do:my-object',
  is_heartbeat: true,
  timestamp: '2026-02-25T10:30:00.000Z',
  metrics: {},
}
```
