# Your First Protected Worker

This tutorial walks through the complete setup: scaffolding a Platform backend, connecting an application worker, and verifying end-to-end telemetry.

**Time**: ~20 minutes
**Prerequisites**: Node.js 20+, wrangler CLI authenticated, Cloudflare Workers Paid plan

## Step 1: Scaffold the Backend

```bash
npx @littlebearapps/platform-admin-sdk my-platform --tier minimal --skip-prompts
cd my-platform
npm install
```

This generates a `platform-usage` worker, D1 migrations, and config files.

## Step 2: Create Cloudflare Resources

```bash
# D1 database
npx wrangler d1 create my-platform-metrics
# Copy the database_id from output

# KV namespace
npx wrangler kv namespace create PLATFORM_CACHE
# Copy the id from output

# Queues
npx wrangler queues create my-platform-telemetry
npx wrangler queues create my-platform-telemetry-dlq
```

Update `wrangler.my-platform-usage.jsonc` with the resource IDs.

## Step 3: Deploy the Backend

```bash
# Apply D1 migrations
npx wrangler d1 migrations apply my-platform-metrics --remote

# Sync config
npm run sync:config

# Deploy
npx wrangler deploy -c wrangler.my-platform-usage.jsonc
```

## Step 4: Create Your Application Worker

In a separate directory:

```bash
mkdir my-app && cd my-app
npm init -y
npm install @littlebearapps/platform-consumer-sdk
npm install -D @cloudflare/workers-types wrangler typescript
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

Create `wrangler.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "my-app",
  "main": "src/index.ts",
  "compatibility_date": "2026-01-01",
  "compatibility_flags": ["nodejs_compat_v2"],
  "observability": { "enabled": true },
  "d1_databases": [
    { "binding": "DB", "database_name": "my-app-db", "database_id": "YOUR_APP_DB_ID" }
  ],
  "kv_namespaces": [
    { "binding": "PLATFORM_CACHE", "id": "YOUR_KV_NAMESPACE_ID" }
  ],
  "queues": {
    "producers": [
      { "binding": "TELEMETRY_QUEUE", "queue": "my-platform-telemetry" }
    ]
  }
}
```

## Step 5: Write the Worker

Create `src/index.ts`:

```typescript
import {
  withFeatureBudget,
  completeTracking,
  CircuitBreakerError,
  createLoggerFromRequest,
} from '@littlebearapps/platform-consumer-sdk';

interface Env {
  DB: D1Database;
  PLATFORM_CACHE: KVNamespace;
  TELEMETRY_QUEUE: Queue;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const log = createLoggerFromRequest(request, env, 'my-app');
    const tracked = withFeatureBudget(env, 'myapp:api:main', { ctx });

    try {
      log.info('Request received', { path: new URL(request.url).pathname });

      // All D1 access is automatically tracked
      const result = await tracked.DB.prepare(
        'SELECT name, email FROM users LIMIT 10'
      ).all();

      log.info('Query complete', { rowCount: result.results.length });
      return Response.json(result.results);
    } catch (e) {
      if (e instanceof CircuitBreakerError) {
        log.warn('Circuit breaker active', e);
        return Response.json(
          { error: 'Service temporarily unavailable', level: e.level },
          { status: 503 }
        );
      }
      log.error('Request failed', e as Error);
      return Response.json({ error: 'Internal error' }, { status: 500 });
    } finally {
      ctx.waitUntil(completeTracking(tracked));
    }
  }
};
```

## Step 6: Register the Feature

Back in your Platform backend, add the feature to `platform/config/budgets.yaml`:

```yaml
features:
  myapp:api:main:
    daily_limit:
      d1_reads: 100000
      d1_writes: 10000
    circuit_breaker:
      threshold_percent: 100
      warning_percent: 70
      auto_reset_hours: 24
```

Sync the config:

```bash
cd ../my-platform
npm run sync:config
```

## Step 7: Test Locally

```bash
cd ../my-app
npx wrangler dev
```

Make a few requests:

```bash
curl http://localhost:8787/
```

In local dev, the telemetry queue may not be connected. That's fine — the SDK fails open and your worker operates normally.

## Step 8: Deploy and Verify

```bash
npx wrangler deploy
```

Make several requests to the deployed worker, then check the D1 warehouse:

```bash
cd ../my-platform
npx wrangler d1 execute my-platform-metrics --remote \
  --command "SELECT feature_key, SUM(d1_reads) as total_reads FROM daily_usage_rollups WHERE feature_key = 'myapp:api:main' GROUP BY feature_key"
```

You should see your feature with accumulated D1 read counts.

## Step 9: Test the Circuit Breaker

Manually trigger a circuit breaker to verify protection:

```bash
# Stop the feature
npx wrangler kv key put CONFIG:FEATURE:myapp:api:main:STATUS STOP --namespace-id YOUR_KV_ID

# Make a request — should get 503
curl https://my-app.YOUR_SUBDOMAIN.workers.dev/

# Re-enable
npx wrangler kv key put CONFIG:FEATURE:myapp:api:main:STATUS GO --namespace-id YOUR_KV_ID
```

## What's Next

- **Add more features**: Wrap cron and queue handlers with `withCronBudget` and `withQueueBudget`
- **Upgrade tier**: Add error collection with `npx @littlebearapps/platform-admin-sdk upgrade --tier standard`
- **Add CI**: Set up the [consumer-check.yml workflow](../admin-sdk/ci-workflow.md)
- **Add middleware**: Protect entire projects with [project-level circuit breakers](../consumer-sdk/middleware.md)
- **Monitor**: Set up [Gatus heartbeats](../consumer-sdk/advanced.md#heartbeat-ping-gatus) for uptime monitoring
