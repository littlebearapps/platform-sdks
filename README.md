# @littlebearapps/platform-sdk

Automatic metric collection, circuit breaking, and cost protection for Cloudflare Workers.

## Install

```bash
npm install @littlebearapps/platform-sdk
```

**Note:** Ships TypeScript source. Requires `moduleResolution: "bundler"` in your `tsconfig.json`. If using `noUnusedLocals: true`, ensure v0.1.2+.

## Updating

```bash
npm install @littlebearapps/platform-sdk@latest
```

Consumer projects use `^0.x.y` semver range. Patch bumps install automatically on fresh `npm install`. New versions are auto-published via CI when merged to main.

## Quick Start

```typescript
import { withFeatureBudget, CircuitBreakerError } from '@littlebearapps/platform-sdk';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    try {
      const trackedEnv = withFeatureBudget(env, 'scout:ocr:process', { ctx });
      const result = await trackedEnv.DB.prepare('SELECT 1').all();
      return Response.json(result);
    } catch (e) {
      if (e instanceof CircuitBreakerError) {
        return Response.json({ error: 'Feature disabled' }, { status: 503 });
      }
      throw e;
    }
  }
};
```

## Required Cloudflare Bindings

```jsonc
// wrangler.jsonc
{
  "kv_namespaces": [
    { "binding": "PLATFORM_CACHE", "id": "ee1087b34e5646139b32feb4c45bb29e" }
  ],
  "queues": {
    "producers": [
      { "binding": "PLATFORM_TELEMETRY", "queue": "platform-telemetry" }
    ]
  }
}
```

## Exports

| Export | Description |
|--------|------------|
| `withFeatureBudget()` | Wrap `fetch` handlers — proxies bindings with automatic tracking |
| `withCronBudget()` | Wrap `scheduled` handlers |
| `withQueueBudget()` | Wrap `queue` handlers |
| `CircuitBreakerError` | Thrown when a feature's budget is exhausted |
| `completeTracking()` | Flush pending metrics (call in `finally` or `ctx.waitUntil`) |
| `pingHeartbeat()` | Gatus heartbeat integration |
| `withRetry()` | Retry with exponential backoff |

Additional exports: `./heartbeat`, `./retry`, `./costs`

## Documentation

- [Integration Checklist](https://docs.littlebearapps.com/platform-guides/sdk-integration-checklist/) — Full setup guide
- [Claude Code Plugin](https://github.com/littlebearapps/platform-sdk-plugin) — Automated SDK enforcement for Claude Code

## License

MIT
