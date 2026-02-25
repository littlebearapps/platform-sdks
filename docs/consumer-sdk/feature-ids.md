# Feature IDs

Feature IDs are the core identifier for tracking, budgeting, and circuit breaking. Every call to `withFeatureBudget`, `withCronBudget`, or `withQueueBudget` requires one.

## Format

```
project:category:feature
```

Three colon-separated parts, all **kebab-case**. The SDK validates this format — exactly two colons, no empty parts.

## Naming Conventions

### Project

The project slug — should match your entry in `services.yaml`:

| Project | Slug |
|---------|------|
| Scout | `scout` |
| Brand Copilot | `brand-copilot` |
| Platform | `platform` |
| Your App | `myapp` |

### Category

Groups features by billing or operational concern. Common categories:

| Category | Used For |
|----------|---------|
| `api` | HTTP fetch handlers |
| `cron` | Scheduled (cron) handlers |
| `queue` | Queue consumer handlers |
| `scanner` | Data scanning/scraping features |
| `connector` | External API integrations |
| `ai` | Workers AI / AI Gateway calls |
| `do` | Durable Object operations |
| `ocr` | Image/document processing |
| `email` | Email sending features |
| `ingest` | Data ingestion pipelines |
| `monitor` | Monitoring and alerting |

### Feature

The specific operation within the category:

| Feature | Description |
|---------|-------------|
| `main` | Primary handler |
| `daily-sync` | Daily cron sync job |
| `process` | Processing operation |
| `github` | GitHub-specific integration |
| `healthcheck` | Health check endpoint |

## Examples

| Feature ID | Description |
|-----------|-------------|
| `scout:ocr:process` | Scout's OCR processing |
| `scout:scanner:github` | Scout scanning GitHub repos |
| `brand-copilot:ai:generate` | Brand Copilot AI content generation |
| `brand-copilot:scanner:web` | Brand Copilot web scanner |
| `myapp:api:main` | Main API handler |
| `myapp:cron:daily-sync` | Daily sync cron job |
| `myapp:queue:processor` | Queue consumer processing |
| `myapp:connector:stripe` | Stripe API integration |

## Budget Registration

Each feature ID should be registered in `budgets.yaml` to set daily limits and circuit breaker thresholds. Without registration, the feature still tracks usage but has no automatic protection.

### budgets.yaml Format

```yaml
features:
  myapp:api:main:
    daily_limit:
      d1_reads: 100000
      d1_writes: 10000
      kv_reads: 50000
      kv_writes: 5000
    circuit_breaker:
      threshold_percent: 100
      warning_percent: 70
      critical_percent: 90
      auto_reset_hours: 24

  myapp:cron:daily-sync:
    daily_limit:
      d1_reads: 50000
      d1_writes: 25000
    circuit_breaker:
      threshold_percent: 100
      auto_reset_hours: 24

  myapp:ai:generate:
    daily_limit:
      ai_requests: 1000
    circuit_breaker:
      threshold_percent: 100
      warning_percent: 80
```

### YAML 1.2 Underscore Gotcha

The `yaml` npm package parses YAML 1.2, where underscored numbers like `1_000_000` are treated as **strings**, not numbers. The Admin SDK's `sync-config.ts` normalises these via `normaliseBudgetLimits()`, and the budget enforcement worker applies defence-in-depth coercion via `Number(raw.replace(/_/g, ''))`. However, for clarity, prefer plain numbers in budget values:

```yaml
# Preferred
d1_reads: 100000

# Also works (normalised at sync time)
d1_reads: 100_000
```

## After Registration

After adding or updating features in `budgets.yaml`, sync to D1/KV:

```bash
npm run sync:config
```

This writes budget configuration to KV under `CONFIG:FEATURE:{featureId}:BUDGET` keys, which the budget enforcement worker reads when evaluating usage against limits.

## Platform's Own Feature IDs

The SDK exports pre-defined feature IDs for Platform's own workers. These are used internally — external projects should define their own:

```typescript
import { PLATFORM_FEATURES, getAllPlatformFeatures } from '@littlebearapps/platform-consumer-sdk';

PLATFORM_FEATURES.INGEST_GITHUB    // 'platform:ingest:github'
PLATFORM_FEATURES.INGEST_STRIPE    // 'platform:ingest:stripe'
PLATFORM_FEATURES.MONITOR_OBSERVER // 'platform:monitor:observer'
PLATFORM_FEATURES.TEST_INGEST      // 'platform:test:ingest'

const allIds = getAllPlatformFeatures();
// ['platform:ingest:github', 'platform:ingest:stripe', ...]
```

## Validation

The SDK validates feature IDs at call time. Invalid formats throw immediately (not deferred like circuit breaker checks):

```typescript
// Valid
withFeatureBudget(env, 'myapp:api:main', { ctx });

// Invalid — throws Error immediately
withFeatureBudget(env, 'myapp:api', { ctx });       // Only 2 parts
withFeatureBudget(env, 'myapp:api:main:extra', { ctx }); // 4 parts
withFeatureBudget(env, ':api:main', { ctx });        // Empty project
```
