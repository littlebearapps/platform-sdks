# Platform SDKs

**Automatic cost protection, circuit breaking, and error collection for Cloudflare Workers.**

[![npm version](https://img.shields.io/npm/v/@littlebearapps/platform-consumer-sdk)](https://www.npmjs.com/package/@littlebearapps/platform-consumer-sdk)
[![CI](https://github.com/littlebearapps/platform-sdks/actions/workflows/ci.yml/badge.svg)](https://github.com/littlebearapps/platform-sdks/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## Why This Exists

In January 2026, a buggy deployment caused **$4,868 in unexpected Cloudflare charges** in 4 days. An infinite D1 write loop wrote 4.8 billion rows before anyone noticed.

We built this toolkit so it never happens again — and we're giving it away for free so it doesn't happen to you either.

## Two Packages

### 1. Platform Consumer SDK (`@littlebearapps/platform-consumer-sdk`)

Lightweight library you install in each Cloudflare Worker project. Zero infrastructure dependencies. Wraps your bindings with automatic tracking and circuit breakers.

```bash
npm install @littlebearapps/platform-consumer-sdk
```

```typescript
import { withFeatureBudget, CircuitBreakerError } from '@littlebearapps/platform-consumer-sdk';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    try {
      const tracked = withFeatureBudget(env, 'myapp:api:main', { ctx });
      const result = await tracked.DB.prepare('SELECT * FROM users LIMIT 100').all();
      return Response.json(result);
    } catch (e) {
      if (e instanceof CircuitBreakerError) {
        return Response.json({ error: 'Feature temporarily disabled' }, { status: 503 });
      }
      throw e;
    }
  }
};
```

[Full Consumer SDK docs](packages/consumer-sdk/README.md)

### 2. Platform Admin SDK (`@littlebearapps/platform-admin-sdk`)

CLI scaffolder that generates the backend infrastructure — workers, D1 migrations, config files. Run once, then you own the code.

```bash
npx @littlebearapps/platform-admin-sdk my-platform
```

| Tier | Workers | What You Get | Cost |
|------|---------|-------------|------|
| **Minimal** | 1 | Budget enforcement, circuit breakers, telemetry | ~$0/mo |
| **Standard** | 3 | + Error collection (GitHub issues), gap detection | ~$0/mo |
| **Full** | 8 | + AI pattern discovery, notifications, search, alerts | ~$5/mo |

[Full Admin SDK docs](packages/admin-sdk/README.md)

## Consumer CI Workflow

Validate your SDK integration automatically in GitHub Actions:

```yaml
# .github/workflows/sdk-check.yml
jobs:
  sdk-check:
    uses: littlebearapps/platform-sdks/.github/workflows/consumer-check.yml@main
    with:
      project-name: my-project
```

Checks: SDK installation, wrangler config, budget wrapper usage, cost safety patterns, middleware migration.

## Architecture

```
Consumer Projects (your workers)
    |
    | SDK telemetry (via Queue)
    v
Platform Usage Worker (cron + queue consumer)
    |
    v
D1 Warehouse --- KV Cache --- Analytics Engine
    |
    +-- Error Collector (tail worker -> GitHub issues)
    +-- Sentinel (gap detection -> alerts)
    +-- Pattern Discovery (AI -> error classification)
```

## Documentation

- [Integration Checklist](https://docs.littlebearapps.com/platform-guides/sdk-integration-checklist/) — Full SDK setup guide
- [Claude Code Plugin](https://github.com/littlebearapps/platform-sdk-plugin) — Automated SDK enforcement

## License

MIT — Built by [Little Bear Apps](https://littlebearapps.com). Free to use, modify, and distribute.
