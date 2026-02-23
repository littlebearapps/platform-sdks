-- =============================================================================
-- 003_feature_tracking.sql — Feature-level tracking and circuit breakers
-- =============================================================================
-- Consolidated from original migrations: 017, 018, 020, 021, 024, 025
--
-- Tables:
--   feature_usage_daily              — Daily usage rollups per feature
--   feature_circuit_breaker_events   — Trip/reset events for feature circuit breakers
--   feature_registry                 — Feature definitions synced from config
--   system_health_checks             — SDK heartbeat probes for feature connectivity
--   feature_error_events             — Real-time error event logging per feature
--   error_alerts                     — Alert history for deduplication
--   feature_ai_model_usage           — Per-feature, per-model AI usage
-- =============================================================================


-- =============================================================================
-- FEATURE USAGE DAILY (from 017, with error columns from 024)
-- =============================================================================
-- Stores aggregated daily usage per feature (from Analytics Engine nightly).
-- Enables feature-level budget tracking and historical trend analysis.

CREATE TABLE IF NOT EXISTS feature_usage_daily (
  id TEXT PRIMARY KEY,
  feature_key TEXT NOT NULL,               -- 'my-project:scanner:github'
  usage_date TEXT NOT NULL,                -- 'YYYY-MM-DD'

  -- Resource metrics (aggregated daily totals)
  d1_writes INTEGER DEFAULT 0,
  d1_reads INTEGER DEFAULT 0,
  kv_reads INTEGER DEFAULT 0,
  kv_writes INTEGER DEFAULT 0,
  do_requests INTEGER DEFAULT 0,
  do_gb_seconds REAL DEFAULT 0,
  r2_class_a INTEGER DEFAULT 0,
  r2_class_b INTEGER DEFAULT 0,
  ai_neurons INTEGER DEFAULT 0,
  queue_messages INTEGER DEFAULT 0,
  requests INTEGER DEFAULT 0,
  cpu_ms INTEGER DEFAULT 0,

  -- Circuit breaker events
  times_disabled INTEGER DEFAULT 0,

  -- Error tracking (from 024)
  error_count INTEGER DEFAULT 0,
  error_categories TEXT,                   -- JSON array of categories

  -- Metadata
  created_at INTEGER DEFAULT (unixepoch()),

  UNIQUE(feature_key, usage_date)
);

CREATE INDEX IF NOT EXISTS idx_feature_usage_daily_key
  ON feature_usage_daily(feature_key);
CREATE INDEX IF NOT EXISTS idx_feature_usage_daily_date
  ON feature_usage_daily(usage_date DESC);
CREATE INDEX IF NOT EXISTS idx_feature_usage_daily_key_date
  ON feature_usage_daily(feature_key, usage_date DESC);


-- =============================================================================
-- FEATURE CIRCUIT BREAKER EVENTS (from 018)
-- =============================================================================
-- Tracks trip/reset events for feature-level circuit breakers.

CREATE TABLE IF NOT EXISTS feature_circuit_breaker_events (
  id TEXT PRIMARY KEY,
  feature_key TEXT NOT NULL,
  event_type TEXT NOT NULL,                -- 'trip', 'reset', 'manual_disable', 'manual_enable'
  reason TEXT,

  -- Violation details (for 'trip' events)
  violated_resource TEXT,
  current_value REAL,
  budget_limit REAL,

  -- Metadata
  auto_reset INTEGER DEFAULT 0,
  alert_sent INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_fcb_feature_key
  ON feature_circuit_breaker_events(feature_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fcb_created_at
  ON feature_circuit_breaker_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fcb_event_type
  ON feature_circuit_breaker_events(event_type, created_at DESC);


-- =============================================================================
-- FEATURE REGISTRY (from 020)
-- =============================================================================
-- Stores feature definitions synced from services.yaml/budgets.yaml config.

CREATE TABLE IF NOT EXISTS feature_registry (
  feature_key TEXT PRIMARY KEY,            -- 'my-project:scanner:github'
  project_id TEXT NOT NULL,
  category TEXT NOT NULL,
  feature TEXT NOT NULL,

  -- Display
  display_name TEXT NOT NULL,
  description TEXT,

  -- Budget
  cost_tier TEXT DEFAULT 'medium',         -- 'low', 'medium', 'high', 'critical'
  daily_limits_json TEXT,                  -- JSON: { d1_writes: 5000, kv_reads: 10000, ... }

  -- Circuit breaker
  circuit_breaker_enabled INTEGER DEFAULT 0,
  auto_reset_seconds INTEGER DEFAULT 3600,
  cooldown_seconds INTEGER DEFAULT 300,
  max_consecutive_trips INTEGER DEFAULT 3,

  -- Thresholds
  warning_threshold INTEGER DEFAULT 70,
  critical_threshold INTEGER DEFAULT 90,

  -- Metadata
  sources_json TEXT,                       -- JSON array of source identifiers
  synced_at INTEGER,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),

  FOREIGN KEY (project_id) REFERENCES project_registry(project_id)
);

CREATE INDEX IF NOT EXISTS idx_feature_registry_project
  ON feature_registry(project_id);
CREATE INDEX IF NOT EXISTS idx_feature_registry_project_category
  ON feature_registry(project_id, category);
CREATE INDEX IF NOT EXISTS idx_feature_registry_cb_enabled
  ON feature_registry(circuit_breaker_enabled)
  WHERE circuit_breaker_enabled = 1;
CREATE INDEX IF NOT EXISTS idx_feature_registry_cost_tier
  ON feature_registry(cost_tier);


-- =============================================================================
-- SYSTEM HEALTH CHECKS (from 021)
-- =============================================================================
-- Tracks heartbeat probes from SDK health() function.

CREATE TABLE IF NOT EXISTS system_health_checks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  feature_id TEXT NOT NULL,
  last_heartbeat INTEGER NOT NULL,
  status TEXT DEFAULT 'healthy',
  consecutive_failures INTEGER DEFAULT 0,
  last_failure_reason TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(project_id, feature_id)
);

CREATE INDEX IF NOT EXISTS idx_health_checks_project ON system_health_checks(project_id);
CREATE INDEX IF NOT EXISTS idx_health_checks_status ON system_health_checks(status) WHERE status != 'healthy';
CREATE INDEX IF NOT EXISTS idx_health_checks_stale ON system_health_checks(last_heartbeat);


-- =============================================================================
-- FEATURE ERROR EVENTS (from 024)
-- =============================================================================
-- Real-time error event logging for alerting and debugging.
-- Supports P0/P1/P2 alerting tiers. 7-day retention.

CREATE TABLE IF NOT EXISTS feature_error_events (
  id TEXT PRIMARY KEY,
  feature_key TEXT NOT NULL,

  -- Error classification
  error_category TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,                      -- Truncated to max 500 chars

  -- Context
  correlation_id TEXT,
  worker TEXT,

  -- Alerting
  priority TEXT DEFAULT 'P2',
  alert_sent INTEGER DEFAULT 0,

  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_fee_feature_key
  ON feature_error_events(feature_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fee_alert_pending
  ON feature_error_events(alert_sent, priority, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fee_created_at
  ON feature_error_events(created_at);
CREATE INDEX IF NOT EXISTS idx_fee_category
  ON feature_error_events(error_category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fee_correlation_id
  ON feature_error_events(correlation_id);


-- =============================================================================
-- ERROR ALERTS HISTORY (from 024)
-- =============================================================================
-- Stores alert history for analysis and deduplication.

CREATE TABLE IF NOT EXISTS error_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feature_key TEXT NOT NULL,
  alert_type TEXT NOT NULL,                -- 'p0_immediate', 'p1_digest', 'p2_summary'
  error_category TEXT,
  error_code TEXT,
  error_count INTEGER DEFAULT 1,
  error_rate REAL,
  correlation_id TEXT,
  worker TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_ea_feature_key
  ON error_alerts(feature_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ea_alert_type
  ON error_alerts(alert_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ea_created_at
  ON error_alerts(created_at);


-- =============================================================================
-- FEATURE AI MODEL USAGE (from 025)
-- =============================================================================
-- Per-feature, per-model AI usage from SDK telemetry.

CREATE TABLE IF NOT EXISTS feature_ai_model_usage (
  id TEXT PRIMARY KEY,
  feature_key TEXT NOT NULL,
  model TEXT NOT NULL,
  usage_date TEXT NOT NULL,                -- YYYY-MM-DD
  invocations INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(feature_key, model, usage_date)
);

CREATE INDEX IF NOT EXISTS idx_feature_ai_model_feature
  ON feature_ai_model_usage(feature_key, usage_date DESC);
CREATE INDEX IF NOT EXISTS idx_feature_ai_model_model
  ON feature_ai_model_usage(model, usage_date DESC);
CREATE INDEX IF NOT EXISTS idx_feature_ai_model_date
  ON feature_ai_model_usage(usage_date DESC);
