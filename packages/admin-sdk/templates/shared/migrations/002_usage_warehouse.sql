-- =============================================================================
-- 002_usage_warehouse.sql — Time-series usage warehouse
-- =============================================================================
-- Consolidated from original migrations: 003, 004, 005, 006, 010, 012, 013,
--   014, 015, 019, 036, 037, 040
--
-- Tables:
--   hourly_usage_snapshots    — Tier 1: Hourly snapshots (7-day retention)
--   daily_usage_rollups       — Tier 2: Daily rollups (90-day retention)
--   monthly_usage_rollups     — Tier 3: Monthly rollups (forever retention)
--   third_party_usage         — External service usage tracking
--   usage_anomalies           — Detected anomaly records
--   circuit_breaker_logs      — Circuit breaker event audit trail
--   usage_settings            — Per-project alert thresholds
--   workersai_model_usage     — Workers AI per-model hourly breakdown
--   aigateway_model_usage     — AI Gateway per-model hourly breakdown
--   workersai_model_daily     — Workers AI per-model daily rollup
--   aigateway_model_daily     — AI Gateway per-model daily rollup
--   pricing_versions          — CF pricing change audit trail
--   dataset_registry          — GraphQL dataset drift detection
--   resource_usage_snapshots  — Per-resource hourly metrics (finest granularity)
--   resource_registry         — Resource discovery and project mapping
--   gap_detection_log         — Gap detection run results
--   backfill_log              — Backfill operation audit trail
--   attribution_reports       — Resource-to-project attribution status
--   feature_coverage_audit    — Feature activity tracking
--   comprehensive_audit_reports — Weekly aggregate audit reports
--
-- Views:
--   v_account_daily_usage     — Account-level daily summary
--   v_tool_daily_usage        — Per-CF-tool daily summary
--   v_project_daily_usage     — Per-project daily summary
--   v_project_tool_daily_usage — Per-project per-tool daily summary
-- =============================================================================


-- =============================================================================
-- Tier 1: HOURLY SNAPSHOTS (7-day retention)
-- =============================================================================
-- Granular hourly data collected by scheduled handler.
-- Columns merged from migrations 003, 004, 005, 010, 014, 019, 036.

CREATE TABLE IF NOT EXISTS hourly_usage_snapshots (
  id TEXT PRIMARY KEY,
  snapshot_hour TEXT NOT NULL,              -- YYYY-MM-DDTHH:00:00Z (ISO8601)
  project TEXT NOT NULL DEFAULT 'all',      -- 'all' or project slug

  -- Workers metrics
  workers_requests INTEGER DEFAULT 0,
  workers_errors INTEGER DEFAULT 0,
  workers_cpu_time_ms REAL DEFAULT 0,
  workers_duration_p50_ms REAL DEFAULT 0,
  workers_duration_p99_ms REAL DEFAULT 0,
  workers_cost_usd REAL DEFAULT 0,

  -- D1 metrics
  d1_rows_read INTEGER DEFAULT 0,
  d1_rows_written INTEGER DEFAULT 0,
  d1_storage_bytes INTEGER DEFAULT 0,
  d1_cost_usd REAL DEFAULT 0,

  -- KV metrics
  kv_reads INTEGER DEFAULT 0,
  kv_writes INTEGER DEFAULT 0,
  kv_deletes INTEGER DEFAULT 0,
  kv_list_ops INTEGER DEFAULT 0,
  kv_storage_bytes INTEGER DEFAULT 0,
  kv_cost_usd REAL DEFAULT 0,

  -- R2 metrics
  r2_class_a_ops INTEGER DEFAULT 0,
  r2_class_b_ops INTEGER DEFAULT 0,
  r2_storage_bytes INTEGER DEFAULT 0,
  r2_egress_bytes INTEGER DEFAULT 0,
  r2_cost_usd REAL DEFAULT 0,

  -- Durable Objects metrics (includes do_gb_seconds from 004, do_storage_bytes from 010)
  do_requests INTEGER DEFAULT 0,
  do_websocket_connections INTEGER DEFAULT 0,
  do_storage_reads INTEGER DEFAULT 0,
  do_storage_writes INTEGER DEFAULT 0,
  do_storage_deletes INTEGER DEFAULT 0,
  do_gb_seconds REAL DEFAULT 0,
  do_storage_bytes INTEGER DEFAULT 0,
  do_cost_usd REAL DEFAULT 0,

  -- Vectorize metrics
  vectorize_queries INTEGER DEFAULT 0,
  vectorize_vectors_stored INTEGER DEFAULT 0,
  vectorize_dimensions INTEGER DEFAULT 0,
  vectorize_cost_usd REAL DEFAULT 0,

  -- AI Gateway metrics
  aigateway_requests INTEGER DEFAULT 0,
  aigateway_tokens_in INTEGER DEFAULT 0,
  aigateway_tokens_out INTEGER DEFAULT 0,
  aigateway_cached_requests INTEGER DEFAULT 0,
  aigateway_cost_usd REAL DEFAULT 0,

  -- Pages metrics (renamed from pages_requests to pages_deployments per 019)
  pages_deployments INTEGER DEFAULT 0,
  pages_bandwidth_bytes INTEGER DEFAULT 0,
  pages_cost_usd REAL DEFAULT 0,

  -- Queues metrics
  queues_messages_produced INTEGER DEFAULT 0,
  queues_messages_consumed INTEGER DEFAULT 0,
  queues_cost_usd REAL DEFAULT 0,

  -- Workers AI metrics
  workersai_requests INTEGER DEFAULT 0,
  workersai_neurons INTEGER DEFAULT 0,
  workersai_cost_usd REAL DEFAULT 0,

  -- Workflows metrics (from 005)
  workflows_executions INTEGER DEFAULT 0,
  workflows_successes INTEGER DEFAULT 0,
  workflows_failures INTEGER DEFAULT 0,
  workflows_wall_time_ms REAL DEFAULT 0,
  workflows_cpu_time_ms REAL DEFAULT 0,
  workflows_cost_usd REAL DEFAULT 0,

  -- Totals
  total_cost_usd REAL DEFAULT 0,

  -- Metadata
  collection_timestamp INTEGER NOT NULL,    -- Unix timestamp when collected
  sampling_mode TEXT DEFAULT 'FULL',        -- 'FULL', 'HALF', 'QUARTER', 'MINIMAL'

  -- Provenance fields (from 014, 036)
  source TEXT DEFAULT 'live',               -- 'live' or 'backfill'
  ingested_at TEXT,                         -- When data was written to D1
  completeness INTEGER DEFAULT 100,         -- 0-100% data quality
  confidence INTEGER DEFAULT 100,           -- 0-100 confidence score
  backfill_reason TEXT,                     -- Audit trail for backfilled data

  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_hourly_hour ON hourly_usage_snapshots(snapshot_hour DESC);
CREATE INDEX IF NOT EXISTS idx_hourly_project_hour ON hourly_usage_snapshots(project, snapshot_hour DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hourly_unique ON hourly_usage_snapshots(snapshot_hour, project);


-- =============================================================================
-- Tier 2: DAILY ROLLUPS (90-day retention)
-- =============================================================================
-- Aggregated daily totals from hourly snapshots.
-- Columns merged from migrations 003, 004, 005, 010, 012, 014, 019, 036.

CREATE TABLE IF NOT EXISTS daily_usage_rollups (
  snapshot_date TEXT NOT NULL,              -- YYYY-MM-DD
  project TEXT NOT NULL,

  -- Workers metrics
  workers_requests INTEGER DEFAULT 0,
  workers_errors INTEGER DEFAULT 0,
  workers_cpu_time_ms REAL DEFAULT 0,
  workers_duration_p50_ms_avg REAL DEFAULT 0,
  workers_duration_p99_ms_max REAL DEFAULT 0,
  workers_cost_usd REAL DEFAULT 0,

  -- D1 metrics
  d1_rows_read INTEGER DEFAULT 0,
  d1_rows_written INTEGER DEFAULT 0,
  d1_storage_bytes_max INTEGER DEFAULT 0,
  d1_cost_usd REAL DEFAULT 0,

  -- KV metrics
  kv_reads INTEGER DEFAULT 0,
  kv_writes INTEGER DEFAULT 0,
  kv_deletes INTEGER DEFAULT 0,
  kv_list_ops INTEGER DEFAULT 0,
  kv_storage_bytes_max INTEGER DEFAULT 0,
  kv_cost_usd REAL DEFAULT 0,

  -- R2 metrics
  r2_class_a_ops INTEGER DEFAULT 0,
  r2_class_b_ops INTEGER DEFAULT 0,
  r2_storage_bytes_max INTEGER DEFAULT 0,
  r2_egress_bytes INTEGER DEFAULT 0,
  r2_cost_usd REAL DEFAULT 0,

  -- Durable Objects metrics
  do_requests INTEGER DEFAULT 0,
  do_websocket_connections INTEGER DEFAULT 0,
  do_storage_reads INTEGER DEFAULT 0,
  do_storage_writes INTEGER DEFAULT 0,
  do_storage_deletes INTEGER DEFAULT 0,
  do_gb_seconds REAL DEFAULT 0,
  do_storage_bytes_max INTEGER DEFAULT 0,
  do_cost_usd REAL DEFAULT 0,

  -- Vectorize metrics
  vectorize_queries INTEGER DEFAULT 0,
  vectorize_vectors_stored_max INTEGER DEFAULT 0,
  vectorize_cost_usd REAL DEFAULT 0,

  -- AI Gateway metrics
  aigateway_requests INTEGER DEFAULT 0,
  aigateway_tokens_in INTEGER DEFAULT 0,
  aigateway_tokens_out INTEGER DEFAULT 0,
  aigateway_cached_requests INTEGER DEFAULT 0,
  aigateway_cost_usd REAL DEFAULT 0,

  -- Pages metrics
  pages_deployments INTEGER DEFAULT 0,
  pages_bandwidth_bytes INTEGER DEFAULT 0,
  pages_cost_usd REAL DEFAULT 0,

  -- Queues metrics
  queues_messages_produced INTEGER DEFAULT 0,
  queues_messages_consumed INTEGER DEFAULT 0,
  queues_cost_usd REAL DEFAULT 0,

  -- Workers AI metrics
  workersai_requests INTEGER DEFAULT 0,
  workersai_neurons INTEGER DEFAULT 0,
  workersai_cost_usd REAL DEFAULT 0,

  -- Workflows metrics
  workflows_executions INTEGER DEFAULT 0,
  workflows_successes INTEGER DEFAULT 0,
  workflows_failures INTEGER DEFAULT 0,
  workflows_wall_time_ms REAL DEFAULT 0,
  workflows_cpu_time_ms REAL DEFAULT 0,
  workflows_cost_usd REAL DEFAULT 0,

  -- Totals
  total_cost_usd REAL DEFAULT 0,

  -- Rollup metadata
  samples_count INTEGER DEFAULT 0,
  pricing_version_id INTEGER,               -- FK to pricing_versions (from 012)

  -- Provenance fields (from 014, 036)
  source TEXT DEFAULT 'rollup',
  ingested_at TEXT,
  completeness INTEGER DEFAULT 100,
  confidence INTEGER DEFAULT 100,

  created_at INTEGER DEFAULT (unixepoch()),

  PRIMARY KEY (snapshot_date, project)
);

CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_usage_rollups(snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_daily_project_date ON daily_usage_rollups(project, snapshot_date DESC);


-- =============================================================================
-- Tier 3: MONTHLY ROLLUPS (forever retention)
-- =============================================================================
-- Aggregated monthly totals for long-term trends. Never deleted.
-- Columns merged from migrations 003, 004, 005, 012, 014.

CREATE TABLE IF NOT EXISTS monthly_usage_rollups (
  snapshot_month TEXT NOT NULL,             -- YYYY-MM
  project TEXT NOT NULL,

  -- Workers metrics
  workers_requests INTEGER DEFAULT 0,
  workers_errors INTEGER DEFAULT 0,
  workers_cost_usd REAL DEFAULT 0,

  -- D1 metrics
  d1_rows_read INTEGER DEFAULT 0,
  d1_rows_written INTEGER DEFAULT 0,
  d1_cost_usd REAL DEFAULT 0,

  -- KV metrics
  kv_reads INTEGER DEFAULT 0,
  kv_writes INTEGER DEFAULT 0,
  kv_cost_usd REAL DEFAULT 0,

  -- R2 metrics
  r2_class_a_ops INTEGER DEFAULT 0,
  r2_class_b_ops INTEGER DEFAULT 0,
  r2_egress_bytes INTEGER DEFAULT 0,
  r2_cost_usd REAL DEFAULT 0,

  -- Durable Objects metrics (from 004)
  do_requests INTEGER DEFAULT 0,
  do_gb_seconds REAL DEFAULT 0,
  do_cost_usd REAL DEFAULT 0,

  -- AI Gateway metrics
  aigateway_requests INTEGER DEFAULT 0,
  aigateway_tokens_total INTEGER DEFAULT 0,
  aigateway_cost_usd REAL DEFAULT 0,

  -- Workers AI metrics
  workersai_requests INTEGER DEFAULT 0,
  workersai_neurons INTEGER DEFAULT 0,
  workersai_cost_usd REAL DEFAULT 0,

  -- Workflows metrics (from 005)
  workflows_executions INTEGER DEFAULT 0,
  workflows_failures INTEGER DEFAULT 0,
  workflows_cpu_time_ms REAL DEFAULT 0,
  workflows_cost_usd REAL DEFAULT 0,

  -- Totals
  total_cost_usd REAL DEFAULT 0,

  -- Rollup metadata
  days_count INTEGER DEFAULT 0,
  pricing_version_id INTEGER,               -- FK to pricing_versions (from 012)

  -- Provenance fields (from 014)
  source TEXT DEFAULT 'rollup',
  ingested_at TEXT,

  created_at INTEGER DEFAULT (unixepoch()),

  PRIMARY KEY (snapshot_month, project)
);

CREATE INDEX IF NOT EXISTS idx_monthly_month ON monthly_usage_rollups(snapshot_month DESC);


-- =============================================================================
-- THIRD-PARTY USAGE (GitHub, etc.)
-- =============================================================================
-- Tracks usage from external services that contribute to costs.
-- Columns merged from 003, 014.

CREATE TABLE IF NOT EXISTS third_party_usage (
  id TEXT PRIMARY KEY,
  snapshot_date TEXT NOT NULL,              -- YYYY-MM-DD
  provider TEXT NOT NULL,                   -- 'github', 'vercel', etc.
  resource_type TEXT NOT NULL,              -- 'advanced_security_seats', 'actions_minutes', etc.
  resource_name TEXT,
  usage_value REAL NOT NULL DEFAULT 0,
  usage_unit TEXT NOT NULL,                 -- 'seats', 'minutes', 'bytes', 'dollars', etc.
  cost_usd REAL DEFAULT 0,
  raw_response TEXT,
  collection_timestamp INTEGER NOT NULL,

  -- Provenance (from 014)
  source TEXT DEFAULT 'live',
  ingested_at TEXT,

  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_third_party_date ON third_party_usage(snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_third_party_provider ON third_party_usage(provider, snapshot_date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_third_party_unique ON third_party_usage(snapshot_date, provider, resource_type, COALESCE(resource_name, ''));


-- =============================================================================
-- ANOMALY TRACKING
-- =============================================================================
-- Records detected anomalies for audit trail and trend analysis.

CREATE TABLE IF NOT EXISTS usage_anomalies (
  id TEXT PRIMARY KEY,
  detected_at INTEGER NOT NULL,
  metric_name TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT 'all',

  -- Anomaly details
  current_value REAL NOT NULL,
  rolling_avg REAL NOT NULL,
  rolling_stddev REAL NOT NULL,
  deviation_factor REAL NOT NULL,

  -- Alert status
  alert_sent INTEGER DEFAULT 0,
  alert_channel TEXT,
  alert_message_id TEXT,

  -- Resolution
  resolved INTEGER DEFAULT 0,
  resolved_at INTEGER,
  resolved_by TEXT,

  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_anomalies_detected ON usage_anomalies(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_anomalies_unresolved ON usage_anomalies(resolved) WHERE resolved = 0;
CREATE INDEX IF NOT EXISTS idx_anomalies_metric ON usage_anomalies(metric_name, detected_at DESC);


-- =============================================================================
-- CIRCUIT BREAKER AUDIT LOG
-- =============================================================================
-- Records circuit breaker events for operational visibility.
-- Columns merged from 003, 011.

CREATE TABLE IF NOT EXISTS circuit_breaker_logs (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,                 -- 'trip', 'reset', 'sample_reduce', 'sample_restore'
  service TEXT NOT NULL,
  reason TEXT NOT NULL,

  -- State at time of event
  d1_writes_24h INTEGER,
  d1_limit INTEGER DEFAULT 1000000,
  sampling_mode TEXT,
  previous_sampling_mode TEXT,

  -- DO GB-seconds tracking (from 011)
  do_gb_seconds_24h REAL DEFAULT NULL,
  do_gb_seconds_limit REAL DEFAULT 200000,

  -- Alert tracking
  alert_sent INTEGER DEFAULT 0,
  alert_channel TEXT,

  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_cb_created ON circuit_breaker_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cb_service ON circuit_breaker_logs(service, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cb_type ON circuit_breaker_logs(event_type, created_at DESC);


-- =============================================================================
-- USAGE SETTINGS (per-project alert thresholds)
-- =============================================================================
-- Stores user-configurable alert thresholds for each resource type.

CREATE TABLE IF NOT EXISTS usage_settings (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL DEFAULT 'all',
  setting_key TEXT NOT NULL,
  setting_value TEXT NOT NULL,
  updated_at INTEGER DEFAULT (unixepoch()),
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(project, setting_key)
);

CREATE INDEX IF NOT EXISTS idx_settings_project ON usage_settings(project);


-- =============================================================================
-- AI MODEL BREAKDOWN TABLES (from 006)
-- =============================================================================

-- Workers AI per-model hourly usage
CREATE TABLE IF NOT EXISTS workersai_model_usage (
  id TEXT PRIMARY KEY,
  snapshot_hour TEXT NOT NULL,
  project TEXT NOT NULL,
  model TEXT NOT NULL,
  requests INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  is_estimated INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_workersai_model_hour ON workersai_model_usage(snapshot_hour DESC);
CREATE INDEX IF NOT EXISTS idx_workersai_model_project ON workersai_model_usage(project, snapshot_hour DESC);
CREATE INDEX IF NOT EXISTS idx_workersai_model_model ON workersai_model_usage(model, snapshot_hour DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workersai_model_unique ON workersai_model_usage(snapshot_hour, project, model);

-- AI Gateway per-model hourly usage
CREATE TABLE IF NOT EXISTS aigateway_model_usage (
  id TEXT PRIMARY KEY,
  snapshot_hour TEXT NOT NULL,
  gateway_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  requests INTEGER DEFAULT 0,
  cached_requests INTEGER DEFAULT 0,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_aigateway_model_hour ON aigateway_model_usage(snapshot_hour DESC);
CREATE INDEX IF NOT EXISTS idx_aigateway_model_gateway ON aigateway_model_usage(gateway_id, snapshot_hour DESC);
CREATE INDEX IF NOT EXISTS idx_aigateway_model_provider ON aigateway_model_usage(provider, snapshot_hour DESC);
CREATE INDEX IF NOT EXISTS idx_aigateway_model_model ON aigateway_model_usage(model, snapshot_hour DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_aigateway_model_unique ON aigateway_model_usage(snapshot_hour, gateway_id, provider, model);

-- Workers AI daily rollup
CREATE TABLE IF NOT EXISTS workersai_model_daily (
  snapshot_date TEXT NOT NULL,
  project TEXT NOT NULL,
  model TEXT NOT NULL,
  requests INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  samples_count INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (snapshot_date, project, model)
);

CREATE INDEX IF NOT EXISTS idx_workersai_daily_date ON workersai_model_daily(snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_workersai_daily_model ON workersai_model_daily(model, snapshot_date DESC);

-- AI Gateway daily rollup
CREATE TABLE IF NOT EXISTS aigateway_model_daily (
  snapshot_date TEXT NOT NULL,
  gateway_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  requests INTEGER DEFAULT 0,
  cached_requests INTEGER DEFAULT 0,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  samples_count INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (snapshot_date, gateway_id, provider, model)
);

CREATE INDEX IF NOT EXISTS idx_aigateway_daily_date ON aigateway_model_daily(snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_aigateway_daily_provider ON aigateway_model_daily(provider, snapshot_date DESC);


-- =============================================================================
-- PRICING VERSIONS (from 012)
-- =============================================================================
-- Audit trail for Cloudflare pricing changes with historical recomputation support.

CREATE TABLE IF NOT EXISTS pricing_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_name TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  source_url TEXT,
  pricing_json TEXT NOT NULL,
  allowances_json TEXT NOT NULL,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  created_by TEXT DEFAULT 'system'
);

CREATE INDEX IF NOT EXISTS idx_pricing_versions_effective
  ON pricing_versions (effective_from, effective_to);


-- =============================================================================
-- DATASET REGISTRY (from 013)
-- =============================================================================
-- Tracks Cloudflare GraphQL datasets and detects when new ones appear.

CREATE TABLE IF NOT EXISTS dataset_registry (
  dataset_name TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  is_queried INTEGER DEFAULT 0,
  is_billable INTEGER DEFAULT 0,
  category TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dataset_registry_billable_unqueried
  ON dataset_registry (is_billable, is_queried)
  WHERE is_billable = 1 AND is_queried = 0;

CREATE INDEX IF NOT EXISTS idx_dataset_registry_last_seen
  ON dataset_registry (last_seen);


-- =============================================================================
-- RESOURCE USAGE SNAPSHOTS (from 015)
-- =============================================================================
-- Per-resource hourly metrics — finest granularity for flexible aggregation.

CREATE TABLE IF NOT EXISTS resource_usage_snapshots (
  id TEXT PRIMARY KEY,
  snapshot_hour TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_name TEXT,
  project TEXT NOT NULL,

  -- Usage metrics (nullable — not all types have all metrics)
  requests INTEGER,
  cpu_time_ms REAL,
  wall_time_ms REAL,
  duration_ms REAL,
  gb_seconds REAL,
  storage_bytes INTEGER,
  reads INTEGER,
  writes INTEGER,
  deletes INTEGER,
  rows_read INTEGER,
  rows_written INTEGER,
  class_a_ops INTEGER,
  class_b_ops INTEGER,
  egress_bytes INTEGER,
  neurons INTEGER,

  -- Cost
  cost_usd REAL,

  -- Provenance
  source TEXT DEFAULT 'live',
  confidence INTEGER DEFAULT 100,
  allocation_basis TEXT,

  -- Timestamps
  ingested_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),

  UNIQUE(snapshot_hour, resource_type, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_resource_usage_hour
  ON resource_usage_snapshots (snapshot_hour);
CREATE INDEX IF NOT EXISTS idx_resource_usage_type_hour
  ON resource_usage_snapshots (resource_type, snapshot_hour);
CREATE INDEX IF NOT EXISTS idx_resource_usage_project_hour
  ON resource_usage_snapshots (project, snapshot_hour);
CREATE INDEX IF NOT EXISTS idx_resource_usage_project_type_hour
  ON resource_usage_snapshots (project, resource_type, snapshot_hour);
CREATE INDEX IF NOT EXISTS idx_resource_usage_provenance
  ON resource_usage_snapshots (source, confidence)
  WHERE source = 'estimated' OR confidence < 100;


-- =============================================================================
-- RESOURCE REGISTRY (from 015)
-- =============================================================================
-- Maps discovered resources to projects with lifecycle tracking.

CREATE TABLE IF NOT EXISTS resource_registry (
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_name TEXT,
  project TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  is_active INTEGER DEFAULT 1,
  environment TEXT DEFAULT 'production',
  tags TEXT,                               -- JSON array
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (resource_type, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_resource_registry_project
  ON resource_registry (project);
CREATE INDEX IF NOT EXISTS idx_resource_registry_active
  ON resource_registry (is_active, last_seen)
  WHERE is_active = 1;


-- =============================================================================
-- GAP DETECTION LOG (from 036)
-- =============================================================================
-- Stores results of gap detection runs from the sentinel worker.

CREATE TABLE IF NOT EXISTS gap_detection_log (
  id TEXT PRIMARY KEY,
  detection_time TEXT NOT NULL,
  missing_hours_count INTEGER NOT NULL DEFAULT 0,
  stale_projects_count INTEGER NOT NULL DEFAULT 0,
  severity TEXT NOT NULL CHECK (severity IN ('ok', 'warning', 'critical')),
  report_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_gap_detection_time ON gap_detection_log(detection_time);
CREATE INDEX IF NOT EXISTS idx_gap_detection_severity ON gap_detection_log(severity);


-- =============================================================================
-- BACKFILL LOG (from 036)
-- =============================================================================
-- Tracks backfill operations for audit and debugging.

CREATE TABLE IF NOT EXISTS backfill_log (
  id TEXT PRIMARY KEY,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  projects TEXT,                           -- JSON array of project IDs or null for all
  hours_processed INTEGER NOT NULL DEFAULT 0,
  hours_created INTEGER NOT NULL DEFAULT 0,
  hours_updated INTEGER NOT NULL DEFAULT 0,
  errors_count INTEGER NOT NULL DEFAULT 0,
  errors_json TEXT,
  average_confidence INTEGER NOT NULL DEFAULT 75,
  triggered_by TEXT,                       -- 'manual' | 'auto' | 'sentinel'
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  started_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_backfill_log_status ON backfill_log(status);
CREATE INDEX IF NOT EXISTS idx_backfill_log_started ON backfill_log(started_at);


-- =============================================================================
-- ATTRIBUTION REPORTS (from 037)
-- =============================================================================
-- Stores resource-to-project attribution status from discovery runs.

CREATE TABLE IF NOT EXISTS attribution_reports (
  id TEXT PRIMARY KEY,
  discovery_time TEXT NOT NULL,
  total_resources INTEGER NOT NULL DEFAULT 0,
  attributed_count INTEGER NOT NULL DEFAULT 0,
  unattributed_count INTEGER NOT NULL DEFAULT 0,
  report_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_attribution_discovery_time ON attribution_reports(discovery_time);


-- =============================================================================
-- FEATURE COVERAGE AUDIT (from 037)
-- =============================================================================
-- Tracks which features from budgets config are active vs dormant.

CREATE TABLE IF NOT EXISTS feature_coverage_audit (
  id TEXT PRIMARY KEY,
  audit_time TEXT NOT NULL,
  project TEXT NOT NULL,
  feature TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'dormant', 'undefined')),
  last_heartbeat TEXT,
  events_last_7d INTEGER DEFAULT 0,
  defined_budget INTEGER,
  budget_unit TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_feature_coverage_project ON feature_coverage_audit(project);
CREATE INDEX IF NOT EXISTS idx_feature_coverage_status ON feature_coverage_audit(status);
CREATE INDEX IF NOT EXISTS idx_feature_coverage_audit_time ON feature_coverage_audit(audit_time);


-- =============================================================================
-- COMPREHENSIVE AUDIT REPORTS (from 037)
-- =============================================================================
-- Weekly comprehensive reports aggregating all audit findings.

CREATE TABLE IF NOT EXISTS comprehensive_audit_reports (
  id TEXT PRIMARY KEY,
  generated_at TEXT NOT NULL,
  gap_events_count INTEGER NOT NULL DEFAULT 0,
  total_missing_hours INTEGER NOT NULL DEFAULT 0,
  worst_gap_day TEXT,
  average_gap_severity TEXT,
  total_resources INTEGER NOT NULL DEFAULT 0,
  attributed_count INTEGER NOT NULL DEFAULT 0,
  unattributed_count INTEGER NOT NULL DEFAULT 0,
  unattributed_resources TEXT,             -- JSON array of {type, name}
  defined_features_count INTEGER NOT NULL DEFAULT 0,
  active_features_count INTEGER NOT NULL DEFAULT 0,
  dormant_features_count INTEGER NOT NULL DEFAULT 0,
  undefined_features_count INTEGER NOT NULL DEFAULT 0,
  ai_judge_avg_score REAL,
  ai_judge_recommendations TEXT,           -- JSON array
  action_items_count INTEGER NOT NULL DEFAULT 0,
  critical_items_count INTEGER NOT NULL DEFAULT 0,
  action_items TEXT,                       -- JSON array
  report_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_comprehensive_audit_generated ON comprehensive_audit_reports(generated_at);


-- =============================================================================
-- VIEWS for common aggregation patterns (from 015)
-- =============================================================================

-- Account-level daily summary
CREATE VIEW IF NOT EXISTS v_account_daily_usage AS
SELECT
  date(snapshot_hour) as usage_date,
  SUM(requests) as total_requests,
  SUM(cpu_time_ms) as total_cpu_time_ms,
  SUM(storage_bytes) as total_storage_bytes,
  SUM(cost_usd) as total_cost_usd,
  COUNT(DISTINCT resource_id) as resource_count,
  AVG(confidence) as avg_confidence
FROM resource_usage_snapshots
GROUP BY date(snapshot_hour);

-- Per-CF-tool daily summary
CREATE VIEW IF NOT EXISTS v_tool_daily_usage AS
SELECT
  date(snapshot_hour) as usage_date,
  resource_type,
  SUM(requests) as total_requests,
  SUM(cpu_time_ms) as total_cpu_time_ms,
  SUM(storage_bytes) as total_storage_bytes,
  SUM(cost_usd) as total_cost_usd,
  COUNT(DISTINCT resource_id) as resource_count,
  AVG(confidence) as avg_confidence
FROM resource_usage_snapshots
GROUP BY date(snapshot_hour), resource_type;

-- Per-project daily summary
CREATE VIEW IF NOT EXISTS v_project_daily_usage AS
SELECT
  date(snapshot_hour) as usage_date,
  project,
  SUM(requests) as total_requests,
  SUM(cpu_time_ms) as total_cpu_time_ms,
  SUM(storage_bytes) as total_storage_bytes,
  SUM(cost_usd) as total_cost_usd,
  COUNT(DISTINCT resource_id) as resource_count,
  COUNT(DISTINCT resource_type) as tool_count,
  AVG(confidence) as avg_confidence
FROM resource_usage_snapshots
GROUP BY date(snapshot_hour), project;

-- Per-project per-tool daily summary (most granular rollup)
CREATE VIEW IF NOT EXISTS v_project_tool_daily_usage AS
SELECT
  date(snapshot_hour) as usage_date,
  project,
  resource_type,
  SUM(requests) as total_requests,
  SUM(cpu_time_ms) as total_cpu_time_ms,
  SUM(storage_bytes) as total_storage_bytes,
  SUM(cost_usd) as total_cost_usd,
  COUNT(DISTINCT resource_id) as resource_count,
  AVG(confidence) as avg_confidence
FROM resource_usage_snapshots
GROUP BY date(snapshot_hour), project, resource_type;
