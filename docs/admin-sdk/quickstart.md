# Quickstart: Scaffold to Deploy

This guide walks through scaffolding a Platform backend, creating the required Cloudflare resources, deploying, and verifying telemetry — end to end.

## Prerequisites

- Node.js 20+
- wrangler CLI installed and authenticated (`npx wrangler whoami`)
- Cloudflare Workers Paid plan
- A GitHub organisation (Standard/Full tiers)

## 1. Scaffold

```bash
npx @littlebearapps/platform-admin-sdk my-platform
```

The interactive wizard asks for:
- **Project name**: Human-readable (e.g. "My Platform")
- **Project slug**: kebab-case identifier (e.g. "my-platform")
- **Tier**: minimal, standard, or full
- **GitHub org**: Your GitHub organisation (Standard/Full)
- **Default assignee**: GitHub username for error issues (Standard/Full)
- **Gatus URL**: Uptime monitoring URL (optional)

For CI/automation:

```bash
npx @littlebearapps/platform-admin-sdk my-platform \
  --tier standard \
  --github-org myorg \
  --default-assignee myuser \
  --skip-prompts
```

## 2. Install Dependencies

```bash
cd my-platform
npm install
```

This installs `@littlebearapps/platform-consumer-sdk` (used by the generated workers) and other dependencies.

## 3. Create Cloudflare Resources

### D1 Database

```bash
npx wrangler d1 create my-platform-metrics
```

Copy the `database_id` from the output. Update **every** `wrangler.*.jsonc` file:

```jsonc
"d1_databases": [
  { "binding": "PLATFORM_DB", "database_name": "my-platform-metrics", "database_id": "YOUR_DATABASE_ID" }
]
```

### KV Namespaces

```bash
# All tiers
npx wrangler kv namespace create PLATFORM_CACHE
# Copy the id → update wrangler configs

# Standard tier
npx wrangler kv namespace create PLATFORM_ALERTS

# Full tier
npx wrangler kv namespace create SERVICE_REGISTRY
```

### Queues

```bash
npx wrangler queues create my-platform-telemetry
npx wrangler queues create my-platform-telemetry-dlq
```

Update the queue names in your wrangler configs.

### Analytics Engine (Optional)

If you want real-time metrics via Analytics Engine, create a dataset in the Cloudflare dashboard and add the binding:

```jsonc
"analytics_engine_datasets": [
  { "binding": "PLATFORM_ANALYTICS", "dataset": "my-platform-analytics" }
]
```

## 4. Apply D1 Migrations

```bash
npx wrangler d1 migrations apply my-platform-metrics --remote
```

This creates the core tables: `project_registry`, `resource_usage_snapshots`, `daily_usage_rollups`, and others depending on your tier.

## 5. Sync Configuration

```bash
npm run sync:config
```

This reads `platform/config/services.yaml` and `budgets.yaml`, then writes the configuration to D1 and KV. This step is required before the workers can enforce budgets.

## 6. Configure Secrets

### Standard tier

```bash
# GitHub App credentials (for auto-creating error issues)
npx wrangler secret put GITHUB_APP_ID -c wrangler.my-platform-error-collector.jsonc
npx wrangler secret put GITHUB_APP_PRIVATE_KEY -c wrangler.my-platform-error-collector.jsonc
npx wrangler secret put GITHUB_APP_INSTALLATION_ID -c wrangler.my-platform-error-collector.jsonc

# Cloudflare API token (for cost monitoring)
npx wrangler secret put CLOUDFLARE_API_TOKEN -c wrangler.my-platform-sentinel.jsonc
```

### Optional (any tier)

```bash
# Slack webhook for alerts
npx wrangler secret put SLACK_WEBHOOK_URL -c wrangler.my-platform-sentinel.jsonc
```

### Full tier

```bash
npx wrangler secret put GITHUB_TOKEN -c wrangler.my-platform-alert-router.jsonc
npx wrangler secret put SLACK_WEBHOOK_URL -c wrangler.my-platform-alert-router.jsonc
```

## 7. Deploy Workers

**Deploy order matters** — the usage worker must be deployed first because other workers depend on it.

```bash
# Minimal tier (1 worker)
npx wrangler deploy -c wrangler.my-platform-usage.jsonc

# Standard tier (+2 workers)
npx wrangler deploy -c wrangler.my-platform-error-collector.jsonc
npx wrangler deploy -c wrangler.my-platform-sentinel.jsonc

# Full tier (+5 workers)
npx wrangler deploy -c wrangler.my-platform-notifications.jsonc
npx wrangler deploy -c wrangler.my-platform-search.jsonc
npx wrangler deploy -c wrangler.my-platform-settings.jsonc
npx wrangler deploy -c wrangler.my-platform-pattern-discovery.jsonc
npx wrangler deploy -c wrangler.my-platform-alert-router.jsonc
```

## 8. Verify

### Check workers are deployed

```bash
npx wrangler whoami
# Lists your account and deployed workers
```

### Check D1 has data

```bash
npx wrangler d1 execute my-platform-metrics --remote --command "SELECT COUNT(*) FROM project_registry"
```

You should see at least one row (your project).

### Check KV has config

```bash
npx wrangler kv key list --namespace-id YOUR_KV_ID --prefix CONFIG:
```

You should see `CONFIG:FEATURE:*` keys for each registered feature.

## 9. Connect a Consumer Worker

Install the Consumer SDK in your application worker:

```bash
cd ../my-app-worker
npm install @littlebearapps/platform-consumer-sdk
```

Add bindings to `wrangler.jsonc`:

```jsonc
{
  "kv_namespaces": [
    { "binding": "PLATFORM_CACHE", "id": "YOUR_KV_NAMESPACE_ID" }
  ],
  "queues": {
    "producers": [
      { "binding": "TELEMETRY_QUEUE", "queue": "my-platform-telemetry" }
    ]
  },
  "tail_consumers": [
    { "service": "my-platform-error-collector" }
  ]
}
```

Wrap your handler:

```typescript
import { withFeatureBudget, completeTracking, CircuitBreakerError } from '@littlebearapps/platform-consumer-sdk';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const tracked = withFeatureBudget(env, 'myapp:api:main', { ctx });
    try {
      const data = await tracked.DB.prepare('SELECT * FROM items LIMIT 10').all();
      return Response.json(data);
    } catch (e) {
      if (e instanceof CircuitBreakerError) {
        return Response.json({ error: 'Temporarily unavailable' }, { status: 503 });
      }
      throw e;
    } finally {
      ctx.waitUntil(completeTracking(tracked));
    }
  }
};
```

Deploy and trigger a few requests. Then verify telemetry arrived:

```bash
npx wrangler d1 execute my-platform-metrics --remote \
  --command "SELECT feature_key, SUM(d1_reads) FROM daily_usage_rollups GROUP BY feature_key"
```

You should see your feature ID with usage counts.

## Next Steps

- Register your feature IDs in `budgets.yaml` and run `npm run sync:config`
- Set up the [consumer-check.yml CI workflow](ci-workflow.md) in your app repo
- Add [project-level circuit breaker middleware](../consumer-sdk/middleware.md) for request-gating
- Configure [Gatus monitoring](https://github.com/TwiN/gatus) for heartbeat-based uptime
