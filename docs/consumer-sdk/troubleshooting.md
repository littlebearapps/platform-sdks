# Troubleshooting

Common issues and solutions when using the Platform Consumer SDK.

## Installation Issues

### `Cannot find module '@littlebearapps/platform-consumer-sdk'`

Ensure the package is installed:

```bash
npm install @littlebearapps/platform-consumer-sdk
```

### TypeScript errors after installing

The SDK ships raw `.ts` source files (not compiled `.js` + `.d.ts`). Your `tsconfig.json` must use:

```json
{
  "compilerOptions": {
    "moduleResolution": "bundler"
  }
}
```

Also ensure `@cloudflare/workers-types` is installed:

```bash
npm install -D @cloudflare/workers-types
```

### `Cannot find module '@littlebearapps/platform-consumer-sdk/middleware'`

Sub-path exports require `"moduleResolution": "bundler"` or `"nodenext"` in `tsconfig.json`. The `"node"` resolution strategy does not support the `exports` map in `package.json`.

### `ERR_PACKAGE_PATH_NOT_EXPORTED`

Same root cause as above — update `moduleResolution` to `"bundler"`.

## Runtime Errors

### `ReferenceError: PLATFORM_CACHE is not defined`

The KV binding is missing from your wrangler config. Add to your `wrangler.jsonc`:

```jsonc
{
  "kv_namespaces": [
    { "binding": "PLATFORM_CACHE", "id": "YOUR_KV_NAMESPACE_ID" }
  ]
}
```

### `Illegal invocation` when accessing service bindings

**Cause**: In SDK versions before v1.0.0, the circuit breaker proxy wrapped native Fetcher methods (`fetch`, `connect`) in async proxies, which broke the `this` binding required by Cloudflare's native objects.

**Fix**: Upgrade to v1.0.0 or later:

```bash
npm install @littlebearapps/platform-consumer-sdk@latest
```

In v1.0.0+, synchronous builder methods and Fetcher methods are bound to the original target using `.bind()` instead of being async-wrapped.

### `CircuitBreakerError` on every request

A circuit breaker is stuck in STOP state. Check the current status:

```bash
wrangler kv key get CONFIG:FEATURE:myapp:api:main:STATUS --namespace-id YOUR_KV_ID
```

If it returns `STOP`, reset it:

```bash
wrangler kv key put CONFIG:FEATURE:myapp:api:main:STATUS GO --namespace-id YOUR_KV_ID
```

Also check for a global stop:

```bash
wrangler kv key get GLOBAL_STOP_ALL --namespace-id YOUR_KV_ID
```

If active, remove it:

```bash
wrangler kv key delete GLOBAL_STOP_ALL --namespace-id YOUR_KV_ID
```

### `CircuitBreakerError` is not thrown where expected

The circuit breaker check is **lazy** — it fires on the **first access** to a non-Platform binding, not when `withFeatureBudget` is called. This means:

```typescript
// CircuitBreakerError is NOT thrown here
const tracked = withFeatureBudget(env, 'myapp:api:main', { ctx });

// CircuitBreakerError IS thrown here (first binding access)
const result = await tracked.DB.prepare('SELECT 1').all();
```

If you need to check before any binding access, use `isFeatureEnabled`:

```typescript
import { isFeatureEnabled } from '@littlebearapps/platform-consumer-sdk';

const enabled = await isFeatureEnabled('myapp:api:main', env.PLATFORM_CACHE);
if (!enabled) {
  return new Response('Feature disabled', { status: 503 });
}
```

## Telemetry Issues

### Metrics not appearing in Platform dashboard

1. **Check the queue binding** — `TELEMETRY_QUEUE` (or `PLATFORM_TELEMETRY`) must be bound in your wrangler config. The SDK never throws if the queue is missing — telemetry is silently dropped.

2. **Check the queue exists** — Run `wrangler queues list` and verify your telemetry queue is listed.

3. **Check the queue consumer** — The Platform backend's `platform-usage` worker must be deployed and configured as a consumer of the telemetry queue.

4. **Check for zero-value optimisation** — If a request touches no bindings and has no errors, `completeTracking` skips the queue send entirely. This is by design.

### `completeTracking` has no effect

`completeTracking` must be called on the object returned by `withFeatureBudget`, not the original `env`:

```typescript
const tracked = withFeatureBudget(env, 'myapp:api:main', { ctx });

// Correct
await completeTracking(tracked);

// Wrong — env has no tracking context
await completeTracking(env);
```

The tracking context is stored in a `WeakMap` keyed on the proxy object. Calling it on the original `env` silently does nothing.

### Feature usage not tracked (budget not enforcing)

1. Verify the feature ID is registered in `budgets.yaml`
2. Run `npm run sync:config` to push the config to KV
3. Check that the KV key exists:
   ```bash
   wrangler kv key get CONFIG:FEATURE:myapp:api:main:BUDGET --namespace-id YOUR_KV_ID
   ```

### Duplicate telemetry messages

Ensure `completeTracking` is only called once per request. If you're using both `ctx.waitUntil(completeTracking(tracked))` in a `finally` block AND calling it elsewhere, you may get duplicates. The SDK clears the context after the first flush, so the second call is a no-op, but if there's a race condition, duplicates are possible.

## Configuration Issues

### Feature ID validation error

Feature IDs must have exactly three colon-separated parts: `project:category:feature`. Common mistakes:

```typescript
// Wrong — only 2 parts
withFeatureBudget(env, 'myapp:main', { ctx });

// Wrong — 4 parts
withFeatureBudget(env, 'myapp:api:main:v2', { ctx });

// Wrong — empty parts
withFeatureBudget(env, ':api:main', { ctx });
withFeatureBudget(env, 'myapp::main', { ctx });

// Correct
withFeatureBudget(env, 'myapp:api:main', { ctx });
```

### Budget values not applying (YAML underscore gotcha)

In YAML 1.2, underscored numbers like `1_000_000` are parsed as **strings** by the `yaml` npm package. The Admin SDK's `sync-config.ts` normalises these, but if you see budget enforcement not working:

1. Check the raw KV value to ensure it's a number
2. Prefer plain numbers in `budgets.yaml`: `100000` instead of `100_000`

## Performance

### Is the proxy overhead significant?

The proxy stack adds approximately 600 nanoseconds per binding access. For a typical request that accesses 5-10 bindings, this is ~3-6 microseconds — roughly 0.04% of a request that takes 15ms. This is not a performance concern.

### The circuit breaker KV check adds latency

The KV check is lazy (deferred to first binding access) and runs in parallel with your first operation. For most requests, the KV read completes before the first D1/KV/AI response returns. The check result is cached for the duration of the request — subsequent binding accesses incur no additional latency.

If you want to eliminate even this small latency for non-critical paths:

```typescript
const tracked = withFeatureBudget(env, 'myapp:api:main', {
  ctx,
  checkCircuitBreaker: false, // Skip KV check
});
```

## Migration Issues

### Migrating from `@littlebearapps/platform-sdk`

The old package name was deprecated. Update your import:

```bash
npm uninstall @littlebearapps/platform-sdk
npm install @littlebearapps/platform-consumer-sdk
```

Find and replace in your source files:

```
@littlebearapps/platform-sdk → @littlebearapps/platform-consumer-sdk
```

All exports are the same — no code changes needed beyond the import path.

See [Migration Guide](../guides/migrating-from-v0.md) for detailed instructions.
