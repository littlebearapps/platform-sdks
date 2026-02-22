/**
 * Platform Feature IDs
 *
 * Defines all feature identifiers for Platform's own workers.
 * Format: 'platform:<category>:<feature>'
 *
 * Categories:
 * - ingest: Data ingestion workers (GitHub, Stripe, Logger)
 * - connector: External service connectors (Stripe, Ads, GA4, Plausible)
 * - monitor: Monitoring workers (Alert Router, Cost Spike, Observer, GitHub)
 * - discovery: Discovery workers (Topology)
 * - test: Test workers (Ingest, Query, Healthcheck)
 */

import type { FeatureId } from './types';

// =============================================================================
// INGEST FEATURES (3)
// Workers that ingest data from external sources
// =============================================================================

/** GitHub webhook ingestion (issues, PRs, deployments) */
export const INGEST_GITHUB: FeatureId = 'platform:ingest:github';

/** Stripe webhook ingestion (payments, subscriptions) */
export const INGEST_STRIPE: FeatureId = 'platform:ingest:stripe';

/** Log ingestion from external sources */
export const INGEST_LOGGER: FeatureId = 'platform:ingest:logger';

// =============================================================================
// CONNECTOR FEATURES (4)
// Workers that connect to external analytics services
// =============================================================================

/** Stripe connector for billing data */
export const CONNECTOR_STRIPE: FeatureId = 'platform:connector:stripe';

/** Google Ads connector for ad performance data */
export const CONNECTOR_ADS: FeatureId = 'platform:connector:ads';

/** Google Analytics 4 connector */
export const CONNECTOR_GA4: FeatureId = 'platform:connector:ga4';

/** Plausible Analytics connector */
export const CONNECTOR_PLAUSIBLE: FeatureId = 'platform:connector:plausible';

// =============================================================================
// MONITOR FEATURES (4)
// Workers that monitor system health and costs
// =============================================================================

/** Alert router - routes alerts to Slack, creates GitHub issues */
export const MONITOR_ALERT_ROUTER: FeatureId = 'platform:monitor:alert-router';

/** Cost spike alerter - detects cost anomalies */
export const MONITOR_COST_SPIKE: FeatureId = 'platform:monitor:cost-spike';

/** Platform observer - watches GitHub webhooks for circuit breaker state */
export const MONITOR_OBSERVER: FeatureId = 'platform:monitor:observer';

/** GitHub monitor - monitors GitHub API events */
export const MONITOR_GITHUB: FeatureId = 'platform:monitor:github';

/** SDK integration auditor - weekly triangulation audits */
export const MONITOR_AUDITOR: FeatureId = 'platform:monitor:auditor';

/** Pattern discovery - AI-assisted transient error pattern detection */
export const MONITOR_PATTERN_DISCOVERY: FeatureId = 'platform:monitor:pattern-discovery';

// =============================================================================
// DISCOVERY FEATURES (1)
// Workers that discover infrastructure topology
// =============================================================================

/** Topology discovery - discovers services, health, deployments */
export const DISCOVERY_TOPOLOGY: FeatureId = 'platform:discovery:topology';

// =============================================================================
// TEST FEATURES (3)
// Workers used for testing Platform SDK and infrastructure
// Note: test-client is already integrated with 'test-client:validation:sdk-test'
// =============================================================================

/** Test ingest worker */
export const TEST_INGEST: FeatureId = 'platform:test:ingest';

/** Test query worker */
export const TEST_QUERY: FeatureId = 'platform:test:query';

/** Test healthcheck worker */
export const TEST_HEALTHCHECK: FeatureId = 'platform:test:healthcheck';

// =============================================================================
// HEARTBEAT FEATURE
// Used for health checks across all Platform workers
// =============================================================================

/** Generic heartbeat/health check feature */
export const HEARTBEAT_HEALTH: FeatureId = 'platform:heartbeat:health';

// =============================================================================
// EMAIL FEATURES
// Email system health monitoring
// =============================================================================

/** Email system health check - per-brand validation */
export const EMAIL_HEALTHCHECK: FeatureId = 'platform:email:healthcheck';

// =============================================================================
// ALL FEATURES (for budgets.yaml generation)
// =============================================================================

export const PLATFORM_FEATURES = {
  // Ingest
  INGEST_GITHUB,
  INGEST_STRIPE,
  INGEST_LOGGER,
  // Connectors
  CONNECTOR_STRIPE,
  CONNECTOR_ADS,
  CONNECTOR_GA4,
  CONNECTOR_PLAUSIBLE,
  // Monitors
  MONITOR_ALERT_ROUTER,
  MONITOR_COST_SPIKE,
  MONITOR_OBSERVER,
  MONITOR_GITHUB,
  MONITOR_AUDITOR,
  MONITOR_PATTERN_DISCOVERY,
  // Discovery
  DISCOVERY_TOPOLOGY,
  // Test
  TEST_INGEST,
  TEST_QUERY,
  TEST_HEALTHCHECK,
  // Heartbeat
  HEARTBEAT_HEALTH,
  // Email
  EMAIL_HEALTHCHECK,
} as const;

/**
 * Get all Platform feature IDs as an array.
 * Useful for iterating over all features.
 */
export function getAllPlatformFeatures(): FeatureId[] {
  return Object.values(PLATFORM_FEATURES);
}
