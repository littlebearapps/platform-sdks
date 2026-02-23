-- =============================================================================
-- 001_core_tables.sql — Core platform tables
-- =============================================================================
-- Consolidated from original migrations: 001, 002, 007, 009, 016
--
-- Tables:
--   alerts             — Platform alerts with severity and resolution tracking
--   project_registry   — Logical project definitions for resource grouping
--   resource_project_mapping — Maps CF resources to owning projects
--   resource_types      — Valid resource types and their CF API endpoints
-- =============================================================================


-- =============================================================================
-- ALERTS
-- =============================================================================
-- Platform-wide alert tracking with severity tiers and resolution status.

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  source TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  resolved INTEGER DEFAULT 0,
  resolved_at INTEGER,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_alerts_category ON alerts(category, severity, timestamp);
CREATE INDEX IF NOT EXISTS idx_alerts_resolved ON alerts(resolved, timestamp);


-- =============================================================================
-- PROJECT REGISTRY
-- =============================================================================
-- Defines logical projects within a Cloudflare account.
-- Cloudflare has no native resource grouping — this table provides it.
-- Columns from migrations 007, 009, 016 merged into one CREATE TABLE.

CREATE TABLE IF NOT EXISTS project_registry (
  project_id TEXT PRIMARY KEY,              -- 'my-project', 'my-other-project'
  display_name TEXT NOT NULL,               -- Human-readable name
  description TEXT,                         -- Brief description
  color TEXT,                               -- Hex colour for dashboard (#FF5733)
  icon TEXT,                                -- Icon identifier for UI
  owner TEXT,                               -- Team or person responsible
  repo_path TEXT,                           -- Git repo path (e.g., 'org/repo')
  repo_url TEXT,                            -- Full GitHub URL
  github_repo_id TEXT,                      -- For GitHub API integration
  status TEXT DEFAULT 'active',             -- 'active', 'archived', 'development'
  primary_resource TEXT,                    -- Main CF resource type for utilisation tracking
  custom_limit INTEGER,                     -- Optional custom limit override
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_project_status ON project_registry(status);
CREATE INDEX IF NOT EXISTS idx_project_github_repo ON project_registry(github_repo_id);


-- =============================================================================
-- RESOURCE PROJECT MAPPING
-- =============================================================================
-- Maps individual Cloudflare resources to their owning project.
-- Used by the usage worker to aggregate metrics by project.

CREATE TABLE IF NOT EXISTS resource_project_mapping (
  resource_type TEXT NOT NULL,              -- 'worker', 'd1', 'kv', 'r2', etc.
  resource_id TEXT NOT NULL,                -- CF resource ID (UUID or name)
  resource_name TEXT NOT NULL,              -- Human-readable name
  project_id TEXT NOT NULL,                 -- FK to project_registry
  environment TEXT DEFAULT 'production',    -- 'production', 'staging', 'preview', 'development'
  notes TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),

  PRIMARY KEY (resource_type, resource_id),
  FOREIGN KEY (project_id) REFERENCES project_registry(project_id)
);

CREATE INDEX IF NOT EXISTS idx_resource_project ON resource_project_mapping(project_id);
CREATE INDEX IF NOT EXISTS idx_resource_type ON resource_project_mapping(resource_type);
CREATE INDEX IF NOT EXISTS idx_resource_name ON resource_project_mapping(resource_name);
CREATE INDEX IF NOT EXISTS idx_resource_env ON resource_project_mapping(environment);


-- =============================================================================
-- RESOURCE TYPES (reference table)
-- =============================================================================
-- Defines valid resource types and their Cloudflare API endpoints.

CREATE TABLE IF NOT EXISTS resource_types (
  type_id TEXT PRIMARY KEY,                 -- 'worker', 'd1', 'kv', etc.
  display_name TEXT NOT NULL,               -- 'Workers', 'D1 Database', etc.
  api_endpoint TEXT,                        -- GraphQL node or REST endpoint
  billing_dimension TEXT,                   -- Primary billing metric
  icon TEXT,                                -- Icon for UI
  sort_order INTEGER DEFAULT 0              -- Display order in UI
);

-- Seed resource types
INSERT OR IGNORE INTO resource_types (type_id, display_name, api_endpoint, billing_dimension, icon, sort_order) VALUES
  ('worker', 'Workers', 'workersInvocationsAdaptive', 'requests + CPU ms', 'zap', 1),
  ('d1', 'D1 Database', 'd1AnalyticsAdaptiveGroups', 'rows read/written', 'database', 2),
  ('kv', 'KV Namespace', 'kvStorageAdaptiveGroups', 'reads/writes/storage', 'key', 3),
  ('r2', 'R2 Bucket', 'r2StorageAdaptiveGroups', 'Class A/B ops + storage', 'hard-drive', 4),
  ('vectorize', 'Vectorize Index', 'REST /vectorize', 'dimensions stored/queried', 'search', 5),
  ('queue', 'Queue', 'REST /queues', 'messages produced/consumed', 'list', 6),
  ('workflow', 'Workflow', 'workersWorkflowsAdaptiveGroups', 'executions', 'git-branch', 7),
  ('ai_gateway', 'AI Gateway', 'REST /ai-gateway', 'requests + tokens', 'cpu', 8),
  ('workers_ai', 'Workers AI', 'workersAiAdaptiveGroups', 'neurons', 'brain', 9),
  ('durable_object', 'Durable Object', 'durableObjectsPeriodicGroups', 'requests + GB-seconds', 'box', 10),
  ('pages', 'Pages', 'pagesProjectsAdaptiveGroups', 'requests + bandwidth', 'globe', 11),
  ('analytics_engine', 'Analytics Engine', 'aeDatasets', 'data points', 'bar-chart', 12);
