# Advanced Features

This guide covers the SDK's advanced capabilities: distributed tracing, structured logging, cross-worker communication, AI Gateway integration, Durable Object heartbeats, timeouts, and cost calculations.

## Distributed Tracing (W3C Traceparent)

Full W3C Trace Context implementation for end-to-end request tracing across workers.

### Setup

```typescript
import {
  createTraceContext,
  createTracedFetch,
  startSpan,
  endSpan,
  failSpan,
} from '@littlebearapps/platform-consumer-sdk';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Extract trace context from incoming request (or create new)
    const traceCtx = createTraceContext(request, env);

    const span = startSpan(traceCtx, 'handle-request');
    try {
      // Outgoing requests automatically propagate trace headers
      const tracedFetch = createTracedFetch(traceCtx);
      const response = await tracedFetch('https://api.example.com/data');

      endSpan(span);
      return response;
    } catch (error) {
      failSpan(span, error as Error);
      throw error;
    }
  }
};
```

### Trace Context Propagation

Incoming requests are parsed for `traceparent` and `tracestate` headers. If none exist, a new trace is created. Each worker creates a new span ID within the existing trace.

```typescript
import { propagateTraceContext, addTraceHeaders } from '@littlebearapps/platform-consumer-sdk';

// Generate child span headers for outgoing requests
const headers = propagateTraceContext(traceCtx);
// Headers: { traceparent: '00-{traceId}-{newSpanId}-01', tracestate: '...' }

// Merge into existing headers
const enrichedHeaders = addTraceHeaders(existingHeaders, traceCtx);
```

### Span Management

```typescript
const span = startSpan(traceCtx, 'database-query');
// span.spanId, span.parentSpanId, span.name, span.startTime

endSpan(span);
// span.endTime set, span.status = 'ok'

failSpan(span, error);
// span.status = 'error', error.type and error.message added as attributes

setSpanAttribute(span, 'db.table', 'users');
// Immutable — returns new span object
```

### Trace Utilities

```typescript
import { isSampled, shortTraceId, shortSpanId, formatTraceForLog } from '@littlebearapps/platform-consumer-sdk';

isSampled(traceCtx);       // true if traceFlags & 0x01
shortTraceId(traceCtx);    // First 8 chars of trace ID
shortSpanId(traceCtx);     // First 8 chars of span ID
formatTraceForLog(traceCtx); // { trace_id, span_id, trace_flags }
```

## Structured Logging

JSON-formatted logging with automatic correlation ID propagation, designed for Cloudflare Workers Observability.

### Basic Usage

```typescript
import { createLoggerFromRequest } from '@littlebearapps/platform-consumer-sdk';

export default {
  async fetch(request: Request, env: Env) {
    const log = createLoggerFromRequest(request, env, 'my-worker', 'myapp:api:main');

    log.info('Request received', { path: new URL(request.url).pathname });
    log.warn('Slow query detected', new Error('Query took 5s'), { table: 'users' });
    log.error('Failed to process', new Error('DB connection lost'));

    return new Response('OK');
  }
};
```

### Log Output Format

Each log entry is a JSON object written to the appropriate console method:

```json
{
  "level": "info",
  "message": "Request received",
  "timestamp": "2026-02-25T10:30:00.000Z",
  "correlationId": "a1b2c3d4-...",
  "traceId": "0af7651916cd43dd8448eb211c80319c",
  "spanId": "b7ad6b7169203331",
  "featureId": "myapp:api:main",
  "worker": "my-worker",
  "context": { "path": "/api/users" }
}
```

Error logs include stack traces:

```json
{
  "level": "error",
  "message": "Failed to process",
  "error": {
    "name": "Error",
    "message": "DB connection lost",
    "stack": "Error: DB connection lost\n    at ...",
    "code": "D1_ERROR"
  }
}
```

### Logger Options

```typescript
import { createLogger } from '@littlebearapps/platform-consumer-sdk';

const log = createLogger({
  worker: 'my-worker',
  featureId: 'myapp:api:main',
  correlationId: 'custom-id-123',
  traceId: '0af7...',
  spanId: '1b2c...',
  minLevel: 'warn',           // Filter: only warn and above
  defaultContext: { env: 'production' },
});
```

### Timed Operations

```typescript
const result = await log.timed('database-query', async () => {
  return await db.prepare('SELECT * FROM users LIMIT 100').all();
}, { table: 'users' });
// Logs: { message: "database-query completed", durationMs: 45, ... }
```

### Child Loggers

```typescript
const childLog = log.child({ requestId: 'req-123', userId: 'user-456' });
childLog.info('Processing user request');
// Inherits parent context + adds requestId and userId
```

### Correlation ID from Request

`createLoggerFromRequest` extracts correlation IDs from incoming headers in priority order:
1. `x-correlation-id`
2. `x-request-id`
3. `cf-ray`
4. Auto-generated UUID

## Service Client (Cross-Worker Communication)

Propagate correlation IDs and trace context across service bindings:

```typescript
import { createServiceClient } from '@littlebearapps/platform-consumer-sdk';

const client = createServiceClient(env, 'my-worker', { timeoutMs: 10000 });

// Automatically adds: x-correlation-id, x-source-service, traceparent
const response = await client.fetch('https://other-worker.example.com/api/data');
```

### Wrap a Service Binding

```typescript
import { wrapServiceBinding } from '@littlebearapps/platform-consumer-sdk';

// env.OTHER_SERVICE is a Fetcher (service binding)
const wrappedService = wrapServiceBinding(env.OTHER_SERVICE, env, 'my-worker');

// All calls propagate correlation + trace headers
const response = await wrappedService.fetch('http://other-service/api/data');
```

### Generate Headers Manually

```typescript
import { createServiceBindingHeaders } from '@littlebearapps/platform-consumer-sdk';

const headers = createServiceBindingHeaders(env, 'my-worker');
// Headers: x-correlation-id, x-source-service, traceparent, tracestate

const response = await env.OTHER_SERVICE.fetch('http://other-service/api', {
  headers,
});
```

### Extract Incoming Chain

```typescript
import { extractCorrelationChain } from '@littlebearapps/platform-consumer-sdk';

export default {
  async fetch(request: Request, env: Env) {
    const chain = extractCorrelationChain(request);
    // {
    //   correlationId: 'a1b2c3d4-...',
    //   sourceService: 'calling-worker',
    //   targetService: 'my-worker',
    //   featureId: 'myapp:api:main',
    //   traceId: '0af7...',
    //   spanId: '1b2c...',
    // }
  }
};
```

## AI Gateway Integration

Automatic tracking of AI API calls routed through Cloudflare AI Gateway:

```typescript
import { createAIGatewayFetch } from '@littlebearapps/platform-consumer-sdk';

const tracked = withFeatureBudget(env, 'myapp:ai:generate', { ctx });
const aiFetch = createAIGatewayFetch(tracked);

// Automatically detects AI Gateway URL and tracks provider + model
const response = await aiFetch(
  'https://gateway.ai.cloudflare.com/v1/ACCOUNT/my-gateway/google-ai-studio/v1/models/gemini-2.5-flash:generateContent',
  { method: 'POST', body: JSON.stringify({ contents: [{ parts: [{ text: 'Hello' }] }] }) }
);
// Tracked: aiRequests += 1, aiModelCounts['google-ai-studio/gemini-2.5-flash'] += 1
```

### Body Parsing (More Accurate)

For providers where the model is in the request body (OpenAI, Anthropic, DeepSeek):

```typescript
import { createAIGatewayFetchWithBodyParsing } from '@littlebearapps/platform-consumer-sdk';

const aiFetch = createAIGatewayFetchWithBodyParsing(tracked);

const response = await aiFetch(
  'https://gateway.ai.cloudflare.com/v1/ACCOUNT/my-gateway/openai/v1/chat/completions',
  { method: 'POST', body: JSON.stringify({ model: 'gpt-4o', messages: [...] }) }
);
// Tracked: aiModelCounts['openai/gpt-4o'] += 1 (from body parsing)
```

### Supported Providers

`google-ai-studio`, `openai`, `deepseek`, `anthropic`, `workers-ai`, `azure-openai`, `bedrock`, `groq`, `mistral`, `perplexity`.

Non-AI Gateway URLs pass through unchanged with no tracking.

## Durable Object Heartbeat Mixin

Add alarm-based heartbeats to any Durable Object class:

```typescript
import { withHeartbeat } from '@littlebearapps/platform-consumer-sdk';

export class MyDurableObject extends withHeartbeat(DurableObject, {
  featureKey: 'myapp:do:my-object',
  intervalMs: 5 * 60 * 1000, // 5 minutes (default)
  enabled: true,              // default
}) {
  async fetch(request: Request) {
    // Your DO logic — heartbeat runs automatically via alarm
    return new Response('Hello from DO');
  }
}
```

The mixin:
1. Schedules the first alarm in the constructor
2. On each alarm, sends a heartbeat telemetry message to `PLATFORM_TELEMETRY` queue
3. Reschedules the next alarm
4. Calls `super.alarm()` if the parent class has one (safe for chaining)
5. Fails open — errors are logged but never thrown

### Manual Heartbeat

```typescript
// Send immediately (outside alarm cycle)
await this.sendHeartbeatNow();

// Reschedule next alarm
await this.rescheduleHeartbeat();
```

**Required binding**: `PLATFORM_TELEMETRY: Queue<TelemetryMessage>` must be in your wrangler config.

## Timeout Utilities

### Basic Timeout

```typescript
import { withTimeout, DEFAULT_TIMEOUTS } from '@littlebearapps/platform-consumer-sdk';

const result = await withTimeout(
  () => fetchExternalAPI(url),
  DEFAULT_TIMEOUTS.medium, // 15 seconds
  'external-api-call'
);
```

Throws `TimeoutError` with `operation`, `timeoutMs`, and `actualMs` properties.

### Tracked Timeout

Reports timeout errors to the telemetry context automatically:

```typescript
import { withTrackedTimeout } from '@littlebearapps/platform-consumer-sdk';

const tracked = withFeatureBudget(env, 'myapp:api:main', { ctx });
const result = await withTrackedTimeout(tracked, () => fetchData(), 10000, 'fetch-data');
// On timeout: reports TIMEOUT error category + TIMEOUT_FETCH-DATA error code
```

### Request Handler Timeout

Wrap an entire Worker fetch handler with a 504 timeout:

```typescript
import { withRequestTimeout } from '@littlebearapps/platform-consumer-sdk';

const handler = async (request: Request, env: Env, ctx: ExecutionContext) => {
  // Your handler logic
  return new Response('OK');
};

export default {
  fetch: withRequestTimeout(handler, 30000, 'main-handler'),
  // Returns 504 Gateway Timeout if handler exceeds 30s
};
```

### Timeout Constants

```typescript
import { DEFAULT_TIMEOUTS } from '@littlebearapps/platform-consumer-sdk';

DEFAULT_TIMEOUTS.short  // 5,000ms (5 seconds)
DEFAULT_TIMEOUTS.medium // 15,000ms (15 seconds)
DEFAULT_TIMEOUTS.long   // 30,000ms (30 seconds)
DEFAULT_TIMEOUTS.max    // 60,000ms (60 seconds)
```

## Retry with Exponential Backoff

```typescript
import { withExponentialBackoff } from '@littlebearapps/platform-consumer-sdk/retry';

const result = await withExponentialBackoff(
  () => fetchUnreliableAPI(url),
  3 // attempts (default)
);
```

Timing: 1st attempt immediate, 2nd after 100ms, 3rd after 200ms. Maximum backoff capped at 1,000ms. Re-throws the last error on exhaustion.

## Cost Calculations

Calculate Cloudflare resource costs from usage metrics:

```typescript
import {
  calculateHourlyCosts,
  calculateDailyBillableCosts,
  PRICING_TIERS,
  PAID_ALLOWANCES,
} from '@littlebearapps/platform-consumer-sdk/costs';
```

### Hourly Costs

Prorates the Workers Paid plan base cost and monthly allowances to hourly:

```typescript
const costs = calculateHourlyCosts({
  requests: 50000,
  d1RowsRead: 1000000,
  d1RowsWritten: 5000,
  kvReads: 10000,
  // ... other metrics
});

// costs = {
//   workers: 0.0015,
//   d1: 0.0,          // Within prorated hourly allowance
//   kv: 0.0,          // Within prorated hourly allowance
//   r2: 0.0,
//   durableObjects: 0.0,
//   vectorize: 0.0,
//   aiGateway: 0.0,
//   workersAI: 0.0,
//   pages: 0.0,
//   queues: 0.0,
//   workflows: 0.0,
//   total: 0.0015,
// }
```

### Daily Billable Costs

Prorates allowances based on how far through the billing period you are:

```typescript
const costs = calculateDailyBillableCosts(
  dailyUsage,     // AccountDailyUsage object
  15,             // Days elapsed in billing period
  30,             // Total days in billing period
);
// Allowances are prorated: 15/30 = 50% of monthly allowances used as baseline
```

### Pricing Constants

```typescript
PRICING_TIERS.workers.requestsPerMillion     // $0.30
PRICING_TIERS.d1.rowsReadPerMillion          // $0.001
PRICING_TIERS.d1.rowsWrittenPerMillion       // $1.00
PRICING_TIERS.kv.readsPerMillion             // $0.50
PRICING_TIERS.kv.writesPerMillion            // $5.00
PRICING_TIERS.r2.classAPerMillion            // $4.50
PRICING_TIERS.r2.classBPerMillion            // $0.36

PAID_ALLOWANCES.d1.rowsRead                  // 25,000,000,000
PAID_ALLOWANCES.d1.rowsWritten               // 50,000,000
PAID_ALLOWANCES.kv.reads                     // 10,000,000
PAID_ALLOWANCES.kv.writes                    // 1,000,000
```

## Heartbeat Ping (Gatus)

Non-blocking uptime heartbeat ping:

```typescript
import { pingHeartbeat } from '@littlebearapps/platform-consumer-sdk/heartbeat';

// In a cron handler
export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // ... your cron logic ...

    // Ping Gatus heartbeat (non-blocking, uses ctx.waitUntil)
    pingHeartbeat(
      ctx,
      'https://status.example.com/api/v1/endpoints/heartbeats_myworker/external',
      env.GATUS_TOKEN,
      true // success=true
    );
  }
};
```

No-ops if URL or token is falsy. Never throws — errors are silently caught.
