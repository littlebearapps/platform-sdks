-- =============================================================================
-- 004_settings_alerts.sql — Settings, billing, DLQ, error budgets, audit
-- =============================================================================
-- Consolidated from original migrations: 023, 026, 029, 030, 031, 032, 033,
--   034, 035, 052
--
-- Tables:
--   billing_settings           — Billing cycle and plan limit configuration
--   dead_letter_queue          — Failed telemetry messages for replay
--   error_budget_windows       — 5-minute request/error windows for SLA tracking
--   sla_thresholds             — SLA targets per feature or project
--   audit_results              — SDK integration audit results
--   health_trends              — Composite health score tracking over time
--   audit_file_hotspots        — Files that change frequently (audit targets)
--   audit_sdk_regressions      — Commits that removed SDK patterns
--   audit_file_hashes          — File content hashes for delta detection
--   audit_delta_log            — Files changed between audits
--
-- Views:
--   v_project_health_latest    — Latest health status per project
--   v_unacknowledged_regressions — Summary of unacknowledged regressions
-- =============================================================================


-- =============================================================================
-- BILLING SETTINGS (from 023, with plan limits from 026)
-- =============================================================================
-- Billing cycle configuration and plan allowances.
-- All plan limit columns merged from migration 026 ALTER TABLEs.

CREATE TABLE IF NOT EXISTS billing_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL DEFAULT 'default',
  plan_type TEXT NOT NULL DEFAULT 'paid',           -- 'free' | 'paid' | 'enterprise'
  billing_cycle_day INTEGER NOT NULL DEFAULT 1,     -- 1-28 or 0 for calendar month
  billing_currency TEXT NOT NULL DEFAULT 'USD',
  base_cost_monthly REAL NOT NULL DEFAULT 5.00,     -- Workers Paid Plan base
  notes TEXT,

  -- Workers Paid Plan: $5/month includes 10M requests (from 026)
  workers_included_requests INTEGER DEFAULT 10000000,
  workers_overage_rate REAL DEFAULT 0.30,

  -- D1: 25B reads + 50M writes included (from 026)
  d1_included_reads INTEGER DEFAULT 25000000000,
  d1_included_writes INTEGER DEFAULT 50000000,
  d1_read_overage_rate REAL DEFAULT 0.001,
  d1_write_overage_rate REAL DEFAULT 1.00,

  -- KV: 10M reads + 1M writes included (from 026)
  kv_included_reads INTEGER DEFAULT 10000000,
  kv_included_writes INTEGER DEFAULT 1000000,
  kv_read_overage_rate REAL DEFAULT 0.50,
  kv_write_overage_rate REAL DEFAULT 5.00,

  -- R2: 10GB storage + 1M Class A + 10M Class B ops included (from 026)
  r2_included_storage_bytes INTEGER DEFAULT 10000000000,
  r2_included_class_a INTEGER DEFAULT 1000000,
  r2_included_class_b INTEGER DEFAULT 10000000,

  -- Durable Objects: 3M requests + 400K GB-seconds included (from 026)
  do_included_requests INTEGER DEFAULT 3000000,
  do_included_gb_seconds INTEGER DEFAULT 400000,
  do_request_overage_rate REAL DEFAULT 0.15,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(account_id)
);

CREATE INDEX IF NOT EXISTS idx_billing_settings_account
  ON billing_settings(account_id);


-- =============================================================================
-- DEAD LETTER QUEUE (from 029)
-- =============================================================================
-- Stores telemetry messages that failed processing after max retries.
-- Supports inspection, replay, and poison pill detection.
-- Retention: 30 days.

CREATE TABLE IF NOT EXISTS dead_letter_queue (
  id TEXT PRIMARY KEY,

  -- Original message content
  message_payload TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  project TEXT NOT NULL,
  category TEXT,
  feature TEXT,

  -- Error context
  error_message TEXT,
  error_category TEXT,
  error_code TEXT,
  error_fingerprint TEXT,
  retry_count INTEGER NOT NULL,

  -- Tracing
  correlation_id TEXT,
  original_timestamp INTEGER,

  -- DLQ management
  status TEXT DEFAULT 'pending',           -- 'pending', 'replayed', 'discarded'
  replayed_at INTEGER,
  replayed_by TEXT,
  discard_reason TEXT,

  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_dlq_status
  ON dead_letter_queue(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dlq_feature_key
  ON dead_letter_queue(feature_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dlq_project
  ON dead_letter_queue(project, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dlq_fingerprint
  ON dead_letter_queue(error_fingerprint, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dlq_created_at
  ON dead_letter_queue(created_at);
CREATE INDEX IF NOT EXISTS idx_dlq_correlation_id
  ON dead_letter_queue(correlation_id);


-- =============================================================================
-- ERROR BUDGET WINDOWS (from 030)
-- =============================================================================
-- Tracks success/error counts in 5-minute windows per feature.
-- Enables rolling error rate calculation for SLO monitoring.
-- Retention: 30 days.

CREATE TABLE IF NOT EXISTS error_budget_windows (
  id TEXT PRIMARY KEY,

  -- Feature identification
  feature_key TEXT NOT NULL,
  project TEXT NOT NULL,

  -- Window timing
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,

  -- Request counts
  success_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  total_count INTEGER DEFAULT 0,

  -- Error breakdown by category
  timeout_count INTEGER DEFAULT 0,
  validation_count INTEGER DEFAULT 0,
  internal_count INTEGER DEFAULT 0,
  external_count INTEGER DEFAULT 0,
  other_count INTEGER DEFAULT 0,

  -- Latency stats (percentiles in ms)
  p50_latency_ms INTEGER,
  p95_latency_ms INTEGER,
  p99_latency_ms INTEGER,
  max_latency_ms INTEGER,

  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_error_budget_feature_window
  ON error_budget_windows(feature_key, window_start);
CREATE INDEX IF NOT EXISTS idx_error_budget_project
  ON error_budget_windows(project, window_start DESC);
CREATE INDEX IF NOT EXISTS idx_error_budget_window_start
  ON error_budget_windows(window_start);
CREATE INDEX IF NOT EXISTS idx_error_budget_recent
  ON error_budget_windows(feature_key, window_end DESC);


-- =============================================================================
-- SLA THRESHOLDS (from 030)
-- =============================================================================
-- SLA targets per feature or project.

CREATE TABLE IF NOT EXISTS sla_thresholds (
  id TEXT PRIMARY KEY,

  target_type TEXT NOT NULL CHECK (target_type IN ('feature', 'project')),
  target_key TEXT NOT NULL,

  -- SLA targets (error rate thresholds)
  sla_target_pct REAL NOT NULL,
  warning_threshold_pct REAL NOT NULL,
  critical_threshold_pct REAL NOT NULL,

  -- Window configuration
  evaluation_window_hours INTEGER DEFAULT 24,

  -- Status tracking
  current_sla_pct REAL,
  budget_remaining_pct REAL,
  status TEXT DEFAULT 'healthy',           -- 'healthy', 'warning', 'critical', 'exhausted'
  last_evaluated_at INTEGER,

  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sla_target
  ON sla_thresholds(target_type, target_key);
CREATE INDEX IF NOT EXISTS idx_sla_status
  ON sla_thresholds(status);


-- =============================================================================
-- AUDIT RESULTS (from 031, with columns from 032, 033, 052)
-- =============================================================================
-- SDK integration audit results from weekly triangulation audits.
-- All ALTER TABLE columns merged into CREATE TABLE.

CREATE TABLE IF NOT EXISTS audit_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_id TEXT NOT NULL,
  project TEXT NOT NULL,
  status TEXT NOT NULL,                    -- HEALTHY, ZOMBIE, UNTRACKED, BROKEN, NOT_INTEGRATED

  status_message TEXT,

  -- Config checks (from wrangler.jsonc)
  has_platform_cache BOOLEAN,
  has_platform_telemetry BOOLEAN,
  observability_enabled BOOLEAN,
  logs_enabled BOOLEAN,
  config_issues TEXT,                      -- JSON array

  -- Code smell tests
  has_sdk_folder BOOLEAN,
  has_with_feature_budget BOOLEAN,
  has_tracked_env BOOLEAN,
  has_circuit_breaker_error BOOLEAN,
  has_error_logging BOOLEAN,

  -- Runtime checks (D1 system_health_checks)
  has_recent_heartbeat BOOLEAN,
  hours_since_heartbeat INTEGER,

  -- AI Judge results
  ai_judge_score INTEGER,                  -- 0-100
  ai_judge_summary TEXT,
  ai_judge_issues TEXT,                    -- JSON array (legacy)
  ai_cached_at TEXT,

  -- Worker identification (from 032, for multi-worker projects)
  worker_name TEXT DEFAULT NULL,

  -- Traces configuration (from 032)
  traces_enabled BOOLEAN DEFAULT NULL,
  trace_sampling_rate REAL DEFAULT NULL,

  -- Logs configuration extended (from 032)
  log_sampling_rate REAL DEFAULT NULL,
  invocation_logs_enabled BOOLEAN DEFAULT NULL,

  -- Source maps (from 032)
  source_maps_enabled BOOLEAN DEFAULT NULL,

  -- AI observability scoring (from 032)
  ai_observability_score INTEGER DEFAULT NULL,
  ai_observability_issues TEXT DEFAULT NULL,

  -- Rubric scores 1-5 per dimension (from 033)
  rubric_sdk INTEGER DEFAULT NULL,
  rubric_observability INTEGER DEFAULT NULL,
  rubric_cost_protection INTEGER DEFAULT NULL,
  rubric_security INTEGER DEFAULT NULL,

  -- Evidence and reasoning (from 033)
  rubric_evidence TEXT DEFAULT NULL,       -- JSON object
  ai_reasoning TEXT DEFAULT NULL,
  ai_categorised_issues TEXT DEFAULT NULL, -- JSON array with severity

  -- Validation metadata (from 033)
  ai_validation_retries INTEGER DEFAULT 0,
  ai_schema_version TEXT DEFAULT 'v1',

  -- Scan type (from 052)
  scan_type TEXT DEFAULT 'full' CHECK (scan_type IN ('full', 'focused')),
  focused_dimensions TEXT,                 -- JSON array for focused scans

  -- Metadata
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(audit_id, project)
);

CREATE INDEX IF NOT EXISTS idx_audit_results_project ON audit_results(project);
CREATE INDEX IF NOT EXISTS idx_audit_results_status ON audit_results(status);
CREATE INDEX IF NOT EXISTS idx_audit_results_created ON audit_results(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_results_ai_score ON audit_results(ai_judge_score) WHERE ai_judge_score IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_results_audit_worker ON audit_results(audit_id, project, worker_name);
CREATE INDEX IF NOT EXISTS idx_audit_results_traces ON audit_results(traces_enabled) WHERE traces_enabled IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_results_trace_sampling ON audit_results(trace_sampling_rate) WHERE trace_sampling_rate IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_results_source_maps ON audit_results(source_maps_enabled) WHERE source_maps_enabled IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_rubric_sdk ON audit_results(rubric_sdk) WHERE rubric_sdk IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_rubric_observability ON audit_results(rubric_observability) WHERE rubric_observability IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_rubric_cost ON audit_results(rubric_cost_protection) WHERE rubric_cost_protection IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_rubric_security ON audit_results(rubric_security) WHERE rubric_security IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_rubric_composite ON audit_results(project, rubric_sdk, rubric_observability, rubric_cost_protection, rubric_security) WHERE rubric_sdk IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_results_scan_type ON audit_results(scan_type);


-- =============================================================================
-- HEALTH TRENDS (from 034, with scan_type from 052)
-- =============================================================================
-- Track composite health scores over time for trend analysis.

CREATE TABLE IF NOT EXISTS health_trends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  audit_id TEXT NOT NULL,
  audit_date TEXT NOT NULL,                -- YYYY-MM-DD

  -- Composite score (0-100 scale)
  composite_score INTEGER NOT NULL,

  -- Individual rubric scores (1-5 scale)
  sdk_score INTEGER,
  observability_score INTEGER,
  cost_score INTEGER,
  security_score INTEGER,

  -- Trend direction
  trend TEXT DEFAULT 'stable' CHECK (trend IN ('improving', 'stable', 'declining')),
  score_delta INTEGER DEFAULT 0,

  -- Scan type (from 052)
  scan_type TEXT DEFAULT 'full' CHECK (scan_type IN ('full', 'focused')),

  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(project, audit_id)
);

CREATE INDEX IF NOT EXISTS idx_health_trends_project_date ON health_trends(project, audit_date DESC);
CREATE INDEX IF NOT EXISTS idx_health_trends_date ON health_trends(audit_date DESC);
CREATE INDEX IF NOT EXISTS idx_health_trends_trend ON health_trends(trend) WHERE trend = 'declining';
CREATE INDEX IF NOT EXISTS idx_health_trends_scan_type ON health_trends(scan_type);

-- View: Latest health status per project
CREATE VIEW IF NOT EXISTS v_project_health_latest AS
SELECT
  ht.*,
  (SELECT composite_score FROM health_trends
   WHERE project = ht.project
   AND audit_date < ht.audit_date
   ORDER BY audit_date DESC LIMIT 1) as previous_score
FROM health_trends ht
WHERE ht.id IN (
  SELECT MAX(id) FROM health_trends GROUP BY project
);


-- =============================================================================
-- BEHAVIOURAL ANALYSIS (from 035)
-- =============================================================================

-- File change hotspots — priority audit targets
CREATE TABLE IF NOT EXISTS audit_file_hotspots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  file_path TEXT NOT NULL,
  change_count INTEGER DEFAULT 0,
  last_changed TEXT,
  authors TEXT,                            -- JSON array
  has_sdk_patterns BOOLEAN DEFAULT FALSE,
  sdk_patterns_found TEXT,                 -- JSON array
  hotspot_score INTEGER DEFAULT 0,
  audit_date TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(project, file_path, audit_date)
);

CREATE INDEX IF NOT EXISTS idx_hotspots_project_score
  ON audit_file_hotspots(project, hotspot_score DESC);
CREATE INDEX IF NOT EXISTS idx_hotspots_audit_date
  ON audit_file_hotspots(audit_date DESC);

-- SDK regressions — commits that removed SDK patterns
CREATE TABLE IF NOT EXISTS audit_sdk_regressions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  commit_message TEXT,
  commit_author TEXT,
  commit_date TEXT,
  file_path TEXT NOT NULL,
  regression_type TEXT NOT NULL,
  description TEXT,
  severity TEXT DEFAULT 'medium' CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  acknowledged BOOLEAN DEFAULT FALSE,
  acknowledged_at TEXT,
  acknowledged_by TEXT,
  audit_date TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(project, commit_sha, file_path, regression_type)
);

CREATE INDEX IF NOT EXISTS idx_regressions_project_date
  ON audit_sdk_regressions(project, audit_date DESC);
CREATE INDEX IF NOT EXISTS idx_regressions_unacknowledged
  ON audit_sdk_regressions(acknowledged, audit_date DESC)
  WHERE acknowledged = FALSE;

-- File hashes — delta detection between audits
CREATE TABLE IF NOT EXISTS audit_file_hashes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_length INTEGER,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(project, file_path)
);

CREATE INDEX IF NOT EXISTS idx_file_hashes_project
  ON audit_file_hashes(project);

-- Delta audit log — files changed between audits
CREATE TABLE IF NOT EXISTS audit_delta_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_id TEXT NOT NULL,
  project TEXT NOT NULL,
  files_changed INTEGER DEFAULT 0,
  files_added INTEGER DEFAULT 0,
  files_removed INTEGER DEFAULT 0,
  changed_files TEXT,                      -- JSON array
  delta_issues_found INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_delta_log_project_date
  ON audit_delta_log(project, created_at DESC);

-- View: Unacknowledged regressions summary
CREATE VIEW IF NOT EXISTS v_unacknowledged_regressions AS
SELECT
  project,
  COUNT(*) as regression_count,
  SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) as critical_count,
  SUM(CASE WHEN severity = 'high' THEN 1 ELSE 0 END) as high_count,
  MAX(commit_date) as latest_regression_date
FROM audit_sdk_regressions
WHERE acknowledged = FALSE
GROUP BY project;
