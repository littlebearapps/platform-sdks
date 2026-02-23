/**
 * Template manifest — maps tiers to files that should be scaffolded.
 *
 * Files ending in .hbs are rendered through Handlebars.
 * All other files are copied verbatim.
 */

import type { Tier } from './prompts.js';

export interface TemplateFile {
  /** Path relative to the templates/ directory */
  src: string;
  /** Path relative to the output directory */
  dest: string;
  /** Whether this file uses Handlebars templating */
  template: boolean;
}

const SHARED_FILES: TemplateFile[] = [
  // Config
  { src: 'shared/config/services.yaml.hbs', dest: 'platform/config/services.yaml', template: true },
  { src: 'shared/config/budgets.yaml.hbs', dest: 'platform/config/budgets.yaml', template: true },

  // Scripts
  { src: 'shared/scripts/sync-config.ts', dest: 'scripts/sync-config.ts', template: false },

  // Migrations (minimal tier)
  { src: 'shared/migrations/001_core_tables.sql', dest: 'storage/d1/migrations/001_core_tables.sql', template: false },
  { src: 'shared/migrations/002_usage_warehouse.sql', dest: 'storage/d1/migrations/002_usage_warehouse.sql', template: false },
  { src: 'shared/migrations/003_feature_tracking.sql', dest: 'storage/d1/migrations/003_feature_tracking.sql', template: false },
  { src: 'shared/migrations/004_settings_alerts.sql', dest: 'storage/d1/migrations/004_settings_alerts.sql', template: false },
  { src: 'shared/migrations/seed.sql.hbs', dest: 'storage/d1/migrations/seed.sql', template: true },

  // Wrangler config (minimal)
  { src: 'shared/wrangler.usage.jsonc.hbs', dest: 'wrangler.{{projectSlug}}-usage.jsonc', template: true },

  // Project files
  { src: 'shared/package.json.hbs', dest: 'package.json', template: true },
  { src: 'shared/tsconfig.json', dest: 'tsconfig.json', template: false },
  { src: 'shared/README.md.hbs', dest: 'README.md', template: true },

  // Workers — platform-usage (data warehouse, cron + queue consumer)
  { src: 'shared/workers/platform-usage.ts', dest: 'workers/platform-usage.ts', template: false },

  // Workers — root lib (shared utilities)
  { src: 'shared/workers/lib/billing.ts', dest: 'workers/lib/billing.ts', template: false },
  { src: 'shared/workers/lib/economics.ts', dest: 'workers/lib/economics.ts', template: false },
  { src: 'shared/workers/lib/analytics-engine.ts', dest: 'workers/lib/analytics-engine.ts', template: false },
  { src: 'shared/workers/lib/platform-settings.ts', dest: 'workers/lib/platform-settings.ts', template: false },
  { src: 'shared/workers/lib/circuit-breaker-middleware.ts', dest: 'workers/lib/circuit-breaker-middleware.ts', template: false },
  { src: 'shared/workers/lib/metrics.ts', dest: 'workers/lib/metrics.ts', template: false },
  { src: 'shared/workers/lib/telemetry-sampling.ts', dest: 'workers/lib/telemetry-sampling.ts', template: false },
  { src: 'shared/workers/lib/control.ts', dest: 'workers/lib/control.ts', template: false },

  // Workers — lib/shared (cross-boundary types and utilities)
  { src: 'shared/workers/lib/shared/types.ts', dest: 'workers/lib/shared/types.ts', template: false },
  { src: 'shared/workers/lib/shared/allowances.ts', dest: 'workers/lib/shared/allowances.ts', template: false },
  { src: 'shared/workers/lib/shared/cloudflare.ts', dest: 'workers/lib/shared/cloudflare.ts', template: false },

  // Workers — lib/usage/shared
  { src: 'shared/workers/lib/usage/shared/types.ts', dest: 'workers/lib/usage/shared/types.ts', template: false },
  { src: 'shared/workers/lib/usage/shared/constants.ts', dest: 'workers/lib/usage/shared/constants.ts', template: false },
  { src: 'shared/workers/lib/usage/shared/utils.ts', dest: 'workers/lib/usage/shared/utils.ts', template: false },
  { src: 'shared/workers/lib/usage/shared/index.ts', dest: 'workers/lib/usage/shared/index.ts', template: false },

  // Workers — lib/usage/handlers
  { src: 'shared/workers/lib/usage/handlers/index.ts', dest: 'workers/lib/usage/handlers/index.ts', template: false },
  { src: 'shared/workers/lib/usage/handlers/data-queries.ts', dest: 'workers/lib/usage/handlers/data-queries.ts', template: false },
  { src: 'shared/workers/lib/usage/handlers/usage-metrics.ts', dest: 'workers/lib/usage/handlers/usage-metrics.ts', template: false },
  { src: 'shared/workers/lib/usage/handlers/usage-features.ts', dest: 'workers/lib/usage/handlers/usage-features.ts', template: false },
  { src: 'shared/workers/lib/usage/handlers/usage-settings.ts', dest: 'workers/lib/usage/handlers/usage-settings.ts', template: false },
  { src: 'shared/workers/lib/usage/handlers/usage-admin.ts', dest: 'workers/lib/usage/handlers/usage-admin.ts', template: false },
  { src: 'shared/workers/lib/usage/handlers/dlq-admin.ts', dest: 'workers/lib/usage/handlers/dlq-admin.ts', template: false },
  { src: 'shared/workers/lib/usage/handlers/health-trends.ts', dest: 'workers/lib/usage/handlers/health-trends.ts', template: false },
  { src: 'shared/workers/lib/usage/handlers/backfill.ts', dest: 'workers/lib/usage/handlers/backfill.ts', template: false },
  { src: 'shared/workers/lib/usage/handlers/audit.ts', dest: 'workers/lib/usage/handlers/audit.ts', template: false },
  { src: 'shared/workers/lib/usage/handlers/behavioral.ts', dest: 'workers/lib/usage/handlers/behavioral.ts', template: false },

  // Workers — lib/usage/queue
  { src: 'shared/workers/lib/usage/queue/index.ts', dest: 'workers/lib/usage/queue/index.ts', template: false },
  { src: 'shared/workers/lib/usage/queue/telemetry-processor.ts', dest: 'workers/lib/usage/queue/telemetry-processor.ts', template: false },
  { src: 'shared/workers/lib/usage/queue/dlq-handler.ts', dest: 'workers/lib/usage/queue/dlq-handler.ts', template: false },
  { src: 'shared/workers/lib/usage/queue/budget-enforcement.ts', dest: 'workers/lib/usage/queue/budget-enforcement.ts', template: false },
  { src: 'shared/workers/lib/usage/queue/cost-calculator.ts', dest: 'workers/lib/usage/queue/cost-calculator.ts', template: false },
  { src: 'shared/workers/lib/usage/queue/cost-budget-enforcement.ts', dest: 'workers/lib/usage/queue/cost-budget-enforcement.ts', template: false },

  // Workers — lib/usage/scheduled
  { src: 'shared/workers/lib/usage/scheduled/index.ts', dest: 'workers/lib/usage/scheduled/index.ts', template: false },
  { src: 'shared/workers/lib/usage/scheduled/data-collection.ts', dest: 'workers/lib/usage/scheduled/data-collection.ts', template: false },
  { src: 'shared/workers/lib/usage/scheduled/anomaly-detection.ts', dest: 'workers/lib/usage/scheduled/anomaly-detection.ts', template: false },
  { src: 'shared/workers/lib/usage/scheduled/rollups.ts', dest: 'workers/lib/usage/scheduled/rollups.ts', template: false },
  { src: 'shared/workers/lib/usage/scheduled/error-digest.ts', dest: 'workers/lib/usage/scheduled/error-digest.ts', template: false },

  // Workers — lib/usage/collectors (pluggable interface + example)
  { src: 'shared/workers/lib/usage/collectors/index.ts', dest: 'workers/lib/usage/collectors/index.ts', template: false },
  { src: 'shared/workers/lib/usage/collectors/example.ts', dest: 'workers/lib/usage/collectors/example.ts', template: false },
];

const STANDARD_FILES: TemplateFile[] = [
  // Additional migrations
  { src: 'standard/migrations/005_error_collection.sql', dest: 'storage/d1/migrations/005_error_collection.sql', template: false },

  // Wrangler configs
  { src: 'standard/wrangler.error-collector.jsonc.hbs', dest: 'wrangler.{{projectSlug}}-error-collector.jsonc', template: true },
  { src: 'standard/wrangler.sentinel.jsonc.hbs', dest: 'wrangler.{{projectSlug}}-sentinel.jsonc', template: true },

  // Workers — error-collector (tail worker → GitHub issues)
  { src: 'standard/workers/error-collector.ts', dest: 'workers/error-collector.ts', template: false },
  { src: 'standard/workers/lib/error-collector/capture.ts', dest: 'workers/lib/error-collector/capture.ts', template: false },
  { src: 'standard/workers/lib/error-collector/fingerprint.ts', dest: 'workers/lib/error-collector/fingerprint.ts', template: false },
  { src: 'standard/workers/lib/error-collector/types.ts', dest: 'workers/lib/error-collector/types.ts', template: false },
  { src: 'standard/workers/lib/error-collector/github.ts', dest: 'workers/lib/error-collector/github.ts', template: false },
  { src: 'standard/workers/lib/error-collector/digest.ts', dest: 'workers/lib/error-collector/digest.ts', template: false },
  { src: 'standard/workers/lib/error-collector/gap-alerts.ts', dest: 'workers/lib/error-collector/gap-alerts.ts', template: false },
  { src: 'standard/workers/lib/error-collector/email-health-alerts.ts', dest: 'workers/lib/error-collector/email-health-alerts.ts', template: false },

  // Workers — platform-sentinel (gap detection, cost monitoring)
  { src: 'standard/workers/platform-sentinel.ts', dest: 'workers/platform-sentinel.ts', template: false },
  { src: 'standard/workers/lib/sentinel/gap-detection.ts', dest: 'workers/lib/sentinel/gap-detection.ts', template: false },

  // Workers — shared lib (used by standard-tier workers)
  { src: 'standard/workers/lib/shared/slack-alerts.ts', dest: 'workers/lib/shared/slack-alerts.ts', template: false },
];

const FULL_FILES: TemplateFile[] = [
  // Additional migrations
  { src: 'full/migrations/006_pattern_discovery.sql', dest: 'storage/d1/migrations/006_pattern_discovery.sql', template: false },
  { src: 'full/migrations/007_notifications_search.sql', dest: 'storage/d1/migrations/007_notifications_search.sql', template: false },

  // Wrangler configs
  { src: 'full/wrangler.pattern-discovery.jsonc.hbs', dest: 'wrangler.{{projectSlug}}-pattern-discovery.jsonc', template: true },
  { src: 'full/wrangler.alert-router.jsonc.hbs', dest: 'wrangler.{{projectSlug}}-alert-router.jsonc', template: true },
  { src: 'full/wrangler.notifications.jsonc.hbs', dest: 'wrangler.{{projectSlug}}-notifications.jsonc', template: true },
  { src: 'full/wrangler.search.jsonc.hbs', dest: 'wrangler.{{projectSlug}}-search.jsonc', template: true },
  { src: 'full/wrangler.settings.jsonc.hbs', dest: 'wrangler.{{projectSlug}}-settings.jsonc', template: true },

  // Workers — pattern-discovery (AI-assisted transient error patterns)
  { src: 'full/workers/pattern-discovery.ts', dest: 'workers/pattern-discovery.ts', template: false },
  { src: 'full/workers/lib/pattern-discovery/types.ts', dest: 'workers/lib/pattern-discovery/types.ts', template: false },
  { src: 'full/workers/lib/pattern-discovery/clustering.ts', dest: 'workers/lib/pattern-discovery/clustering.ts', template: false },
  { src: 'full/workers/lib/pattern-discovery/ai-prompt.ts', dest: 'workers/lib/pattern-discovery/ai-prompt.ts', template: false },
  { src: 'full/workers/lib/pattern-discovery/storage.ts', dest: 'workers/lib/pattern-discovery/storage.ts', template: false },
  { src: 'full/workers/lib/pattern-discovery/validation.ts', dest: 'workers/lib/pattern-discovery/validation.ts', template: false },
  { src: 'full/workers/lib/pattern-discovery/shadow-evaluation.ts', dest: 'workers/lib/pattern-discovery/shadow-evaluation.ts', template: false },

  // Workers — platform-alert-router (unified alert normalisation)
  { src: 'full/workers/platform-alert-router.ts', dest: 'workers/platform-alert-router.ts', template: false },

  // Workers — platform-notifications (in-app notification API)
  { src: 'full/workers/platform-notifications.ts', dest: 'workers/platform-notifications.ts', template: false },

  // Workers — platform-search (full-text search FTS5)
  { src: 'full/workers/platform-search.ts', dest: 'workers/platform-search.ts', template: false },

  // Workers — platform-settings (settings management API)
  { src: 'full/workers/platform-settings.ts', dest: 'workers/platform-settings.ts', template: false },
];

export function getFilesForTier(tier: Tier): TemplateFile[] {
  const files = [...SHARED_FILES];

  if (tier === 'standard' || tier === 'full') {
    files.push(...STANDARD_FILES);
  }

  if (tier === 'full') {
    files.push(...FULL_FILES);
  }

  return files;
}
