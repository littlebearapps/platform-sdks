# Tier Comparison

The Admin SDK offers three infrastructure tiers. Each higher tier includes everything from the tier below.

## Overview

| | Minimal | Standard | Full |
|--|---------|----------|------|
| **Workers** | 1 | 3 | 8 |
| **D1 Migrations** | 4 + seed | +1 | +2 |
| **KV Namespaces** | 1 | 2 | 3 |
| **Queues** | 2 | 2 | 2 |
| **Est. Monthly Cost** | ~$0 | ~$0 | ~$5 |
| **GitHub App Required** | No | Yes | Yes |
| **AI Gateway** | No | No | Yes |

## Minimal Tier

The foundation. Provides budget enforcement, circuit breakers, and usage telemetry.

### Workers (1)

| Worker | Type | Schedule | Purpose |
|--------|------|----------|---------|
| `platform-usage` | Queue consumer + cron | Hourly | Receives telemetry from queue, stores in D1, evaluates budgets |

### Generated Files

```
my-platform/
├── platform/config/
│   ├── services.yaml              # Project registry, feature definitions
│   └── budgets.yaml               # Daily limits, circuit breaker thresholds
├── storage/d1/migrations/
│   ├── 001_core_schema.sql        # project_registry, resource_usage_snapshots
│   ├── 002_daily_rollups.sql      # daily_usage_rollups, feature_tracking
│   ├── 003_analytics_config.sql   # Analytics Engine field mapping
│   ├── 004_seed_data.sql          # Initial project and feature seed
├── workers/
│   ├── platform-usage.ts          # Queue consumer + cron
│   └── lib/
│       ├── usage/                 # Telemetry processing, data collection
│       ├── billing/               # Cost calculation, allowance proration
│       └── budget-enforcement.ts  # Daily + monthly budget checks
├── scripts/
│   └── sync-config.ts             # YAML → D1/KV sync
├── wrangler.my-platform-usage.jsonc
├── package.json
├── tsconfig.json
└── README.md
```

### Cloudflare Resources Required

| Resource | Binding | Purpose |
|----------|---------|---------|
| D1 Database | `PLATFORM_DB` | Central data warehouse |
| KV Namespace | `PLATFORM_CACHE` | Circuit breaker state, budget config |
| Queue | `platform-telemetry` | Telemetry ingestion |
| Queue | `platform-telemetry-dlq` | Dead letter queue |

## Standard Tier

Adds automatic error collection (GitHub issues from worker errors) and gap detection (monitors telemetry coverage).

### Additional Workers (+2)

| Worker | Type | Schedule | Purpose |
|--------|------|----------|---------|
| `error-collector` | Tail worker + cron | 15min + daily | Processes worker errors, creates GitHub issues, daily digest |
| `platform-sentinel` | Cron | 15min + midnight | Gap detection, cost monitoring, anomaly detection |

### Additional Files

```
workers/
├── error-collector.ts                    # Tail worker + cron
├── platform-sentinel.ts                  # Monitoring cron
├── lib/
│   ├── error-collector/
│   │   ├── fingerprint.ts               # Error fingerprinting + deduplication
│   │   ├── github-issues.ts             # GitHub issue creation
│   │   ├── gap-alerts.ts                # Gap alert processing
│   │   └── digest.ts                    # Daily error digest
│   └── sentinel/
│       └── gap-detection.ts             # Per-project coverage monitoring
storage/d1/migrations/
└── 005_error_collection.sql             # error_occurrences, fingerprint_decisions, warning_digests
wrangler.my-platform-error-collector.jsonc
wrangler.my-platform-sentinel.jsonc
```

### Additional Resources

| Resource | Binding | Purpose |
|----------|---------|---------|
| KV Namespace | `PLATFORM_ALERTS` | Alert deduplication, rate limiting |
| GitHub App | Secrets | Auto-create issues from errors |
| Cloudflare API Token | Secret | Cost monitoring via GraphQL |

### Features

- **Error fingerprinting**: Groups similar errors by message pattern, creates one GitHub issue per unique fingerprint
- **Deduplication**: KV-based with 60-second TTL + GitHub Search API fallback
- **Transient error handling**: Recognised transient errors (rate limits, timeouts) get one issue per category per day
- **Daily digest**: P4 (low-priority) errors batched into a single daily issue
- **Gap detection**: Monitors telemetry coverage per project, alerts if below 90%
- **Cost monitoring**: Hourly cost calculations with anomaly detection
- **Labels**: `cf:error:*`, `cf:priority:p0-p4`, `cf:digest`, `cf:transient`, `cf:gap-alert`

## Full Tier

Adds AI-powered error pattern discovery, unified alert routing, in-app notifications, full-text search, and settings management.

### Additional Workers (+5)

| Worker | Type | Schedule | Purpose |
|--------|------|----------|---------|
| `pattern-discovery` | Cron | 2am + 3am UTC | AI error clustering, pattern suggestion, shadow evaluation |
| `platform-alert-router` | HTTP | On-demand | Webhook normalisation (BetterStack, GitHub Actions, CodeQL) |
| `platform-notifications` | HTTP | On-demand | In-app notification API (CRUD) |
| `platform-search` | HTTP | On-demand | Full-text search via FTS5 |
| `platform-settings` | HTTP | On-demand | Configuration management API |

### Additional Files

```
workers/
├── pattern-discovery.ts                  # AI pattern discovery
├── platform-alert-router.ts              # Unified alert routing
├── platform-notifications.ts             # Notification API
├── platform-search.ts                    # FTS5 search
├── platform-settings.ts                  # Settings API
├── lib/
│   └── pattern-discovery/
│       ├── ai-prompt.ts                 # DeepSeek/Gemini prompts
│       ├── clustering.ts               # Error clustering
│       ├── shadow-evaluation.ts         # Pattern shadow testing
│       ├── storage.ts                   # Match evidence storage
│       └── validation.ts               # Pattern DSL validation
storage/d1/migrations/
├── 006_pattern_discovery.sql            # transient_pattern_suggestions, pattern_audit_log, error_clusters
└── 007_notifications_search.sql         # notifications, search_index (FTS5)
wrangler.my-platform-pattern-discovery.jsonc
wrangler.my-platform-alert-router.jsonc
wrangler.my-platform-notifications.jsonc
wrangler.my-platform-search.jsonc
wrangler.my-platform-settings.jsonc
```

### Additional Resources

| Resource | Binding | Purpose |
|----------|---------|---------|
| KV Namespace | `SERVICE_REGISTRY` | Topology cache |
| AI Gateway | — | AI model routing (Gemini Flash Lite, DeepSeek) |

### Features

- **AI pattern discovery**: Clusters unclassified errors, generates pattern suggestions via AI
- **Human-in-the-loop**: Patterns go through pending → shadow → review → approved lifecycle (no auto-promotion)
- **Shadow evaluation**: Tests patterns against live errors for 3-14 days, collects match evidence
- **Constrained DSL**: `contains`, `startsWith`, `statusCode`, `regex` (with ReDoS protection)
- **Alert normalisation**: Unifies webhooks from BetterStack, GitHub Actions, CodeQL into standard format
- **In-app notifications**: CRUD API for dashboard alerts
- **Full-text search**: FTS5-powered search across errors, patterns, and notifications
- **Settings hub**: Centralised configuration management

## Tier Upgrade Path

You can upgrade tiers at any time without losing data:

```bash
# From minimal to standard
npx @littlebearapps/platform-admin-sdk upgrade --tier standard

# From standard to full
npx @littlebearapps/platform-admin-sdk upgrade --tier full
```

The upgrade command:
1. Adds new files for the higher tier
2. Preserves your existing files (three-way merge)
3. Renumbers new D1 migrations above your existing ones
4. Updates the manifest (`.platform-scaffold.json`)

After upgrading, create the additional Cloudflare resources required by the new tier and deploy the new workers.

## Choosing a Tier

| Choose... | When... |
|-----------|---------|
| **Minimal** | You want cost protection and telemetry with zero overhead |
| **Standard** | You want automatic error alerting via GitHub issues |
| **Full** | You want AI-powered error classification and a notification system |

Most projects should start with **Standard** — the error collector alone saves significant debugging time. Upgrade to Full when you have enough error volume to benefit from AI pattern discovery (typically 100+ unique errors per week).
