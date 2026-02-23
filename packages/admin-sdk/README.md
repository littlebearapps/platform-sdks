# Platform Admin SDK

**`@littlebearapps/platform-admin-sdk`** — Scaffold backend infrastructure for Cloudflare Workers cost protection.

Generates workers, D1 migrations, and config files. Run once, then you own the code.

## Usage

```bash
npx @littlebearapps/platform-admin-sdk my-platform
```

The CLI prompts for:
- **Project name** and slug
- **GitHub organisation** (for error collection GitHub issues)
- **Tier** — how much infrastructure to generate
- **Gatus URL** (optional) — for heartbeat monitoring
- **Default assignee** — GitHub username for error issues

### CLI Flags (non-interactive)

```bash
npx @littlebearapps/platform-admin-sdk my-platform --tier full --github-org myorg --skip-prompts
```

| Flag | Description |
|------|------------|
| `--tier <tier>` | Infrastructure tier (`minimal`, `standard`, `full`) |
| `--github-org <org>` | GitHub organisation for error issues |
| `--gatus-url <url>` | Gatus status page URL |
| `--default-assignee <user>` | Default GitHub issue assignee |
| `--skip-prompts` | Fail if required flags missing (for CI/automation) |

## Tiers

| Tier | Workers | What You Get | Est. Cost |
|------|---------|-------------|-----------|
| **Minimal** | 1 | Budget enforcement, circuit breakers, usage telemetry | ~$0/mo |
| **Standard** | 3 | + Error collector (auto GitHub issues), gap detection sentinel | ~$0/mo |
| **Full** | 8 | + AI pattern discovery, alert router, notifications, search, settings | ~$5/mo |

## What Gets Generated

### All tiers

```
my-platform/
+-- platform/config/
|   +-- services.yaml          # Project registry, feature definitions
|   +-- budgets.yaml           # Daily limits, circuit breaker thresholds
+-- storage/d1/migrations/     # D1 schema (4 core migrations + seed)
+-- workers/
|   +-- platform-usage.ts      # Data warehouse worker (cron + queue consumer)
|   +-- lib/                   # Shared libraries (billing, analytics, budgets)
+-- scripts/
|   +-- sync-config.ts         # Sync YAML config to D1/KV
+-- wrangler.*.jsonc           # Worker configs with binding placeholders
+-- package.json
+-- tsconfig.json
+-- README.md
```

### Standard tier adds

- `workers/error-collector.ts` — Tail worker that creates GitHub issues from errors
- `workers/platform-sentinel.ts` — Gap detection, cost monitoring, alerts
- `workers/lib/error-collector/` — Fingerprinting, deduplication, digest
- `workers/lib/sentinel/` — Project gap detection
- `storage/d1/migrations/005_error_collection.sql`

### Full tier adds

- `workers/pattern-discovery.ts` — AI-assisted transient error pattern discovery
- `workers/platform-alert-router.ts` — Unified alert normalisation and routing
- `workers/platform-notifications.ts` — In-app notification API
- `workers/platform-search.ts` — Full-text search (FTS5)
- `workers/platform-settings.ts` — Settings management API
- `workers/lib/pattern-discovery/` — Clustering, AI prompts, validation, shadow eval
- `storage/d1/migrations/006_pattern_discovery.sql`
- `storage/d1/migrations/007_notifications_search.sql`

## Post-Scaffold Steps

```bash
cd my-platform
npm install

# Create Cloudflare resources
npx wrangler d1 create my-platform-metrics
npx wrangler kv namespace create PLATFORM_CACHE
npx wrangler queues create my-platform-telemetry
npx wrangler queues create my-platform-telemetry-dlq

# Update resource IDs in wrangler.*.jsonc, then:
npm run sync:config
npx wrangler d1 migrations apply my-platform-metrics --remote
npx wrangler deploy -c wrangler.my-platform-usage.jsonc
```

## Consumer SDK

The generated workers use `@littlebearapps/platform-consumer-sdk` — the Consumer SDK. Install it in your application workers:

```bash
npm install @littlebearapps/platform-consumer-sdk
```

See the [Consumer SDK README](../consumer-sdk/README.md) for integration details.

## License

MIT
