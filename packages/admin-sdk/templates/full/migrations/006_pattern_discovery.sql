-- =============================================================================
-- 006_pattern_discovery.sql — AI pattern discovery (full tier)
-- =============================================================================
-- Consolidated from original migrations: 042, 049, 050
--
-- Tables:
--   transient_pattern_suggestions — AI-suggested patterns with approval workflow
--   pattern_audit_log             — Pattern lifecycle event audit trail
--   error_clusters                — Groups of similar unclassified errors
--   pattern_match_evidence        — Detailed match evidence for evaluation
--
-- Uses the FINAL schema from migration 049 which expanded the status constraint
-- to include 'shadow' and 'stale' states, and added protection/source tracking.
-- Also includes review_context from migration 050.
-- =============================================================================


-- =============================================================================
-- TRANSIENT PATTERN SUGGESTIONS (final schema from 049, with 050 additions)
-- =============================================================================
-- Pattern suggestions from AI analysis with human-in-the-loop approval.
-- Patterns go through: pending -> shadow -> ready for review -> approved/rejected
-- Static-imported patterns are protected (is_protected=1, cannot auto-demote).

CREATE TABLE IF NOT EXISTS transient_pattern_suggestions (
  id TEXT PRIMARY KEY,

  -- Pattern definition (supports DSL types for safety)
  pattern_type TEXT NOT NULL CHECK (pattern_type IN ('regex', 'contains', 'startsWith', 'statusCode')),
  pattern_value TEXT NOT NULL,
  category TEXT NOT NULL,
  scope TEXT DEFAULT 'global',             -- 'global', 'service:name', 'upstream:name'

  -- AI metadata
  confidence_score REAL,
  sample_messages TEXT,                    -- JSON array of sample error messages
  ai_reasoning TEXT,
  cluster_id TEXT,                         -- Reference to error cluster

  -- Approval workflow (expanded states from 049)
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'shadow', 'approved', 'stale', 'rejected', 'disabled')),
  reviewed_by TEXT,
  reviewed_at INTEGER,
  rejection_reason TEXT,

  -- Validation results (backtest against historical errors)
  backtest_match_count INTEGER,
  backtest_total_errors INTEGER,
  backtest_match_rate REAL,
  backtest_run_at INTEGER,

  -- Shadow mode (run pattern but don't apply)
  shadow_mode_start INTEGER,
  shadow_mode_end INTEGER,
  shadow_mode_matches INTEGER DEFAULT 0,

  -- Shadow evaluation tracking (from 049)
  shadow_match_days TEXT,                  -- JSON array of unique days with matches

  -- Lifecycle tracking
  enabled_at INTEGER,
  disabled_at INTEGER,
  last_matched_at INTEGER,
  match_count INTEGER DEFAULT 0,

  -- Protection and source tracking (from 049)
  is_protected INTEGER DEFAULT 0,          -- 1 = cannot be auto-demoted (for static patterns)
  source TEXT DEFAULT 'ai-discovered' CHECK (source IN ('ai-discovered', 'static-import', 'manual')),
  original_regex TEXT,                     -- Original regex if converted from static

  -- Review context (from 050) — JSON with match evidence summary
  review_context TEXT,
  -- review_context stores:
  -- {
  --   "totalMatches": number,
  --   "matchesByProject": { "project-a": 5, "project-b": 3 },
  --   "matchesByScript": { "worker-a": 5, "worker-b": 3 },
  --   "sampleMessages": ["msg1", "msg2", "msg3"],
  --   "distinctDays": 5,
  --   "aiExplainer": "This pattern catches X errors across Y projects...",
  --   "readyForReviewAt": timestamp
  -- }

  -- Timestamps
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_suggestions_status ON transient_pattern_suggestions(status);
CREATE INDEX IF NOT EXISTS idx_suggestions_category ON transient_pattern_suggestions(category);
CREATE INDEX IF NOT EXISTS idx_suggestions_scope ON transient_pattern_suggestions(scope);
CREATE INDEX IF NOT EXISTS idx_suggestions_created ON transient_pattern_suggestions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_suggestions_source ON transient_pattern_suggestions(source);
CREATE INDEX IF NOT EXISTS idx_suggestions_protected ON transient_pattern_suggestions(is_protected);


-- =============================================================================
-- PATTERN AUDIT LOG (final schema from 049)
-- =============================================================================
-- Audit log for pattern lifecycle events including self-tuning actions.

CREATE TABLE IF NOT EXISTS pattern_audit_log (
  id TEXT PRIMARY KEY,
  pattern_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'created',                             -- AI suggested pattern
    'approved',                            -- Human approved
    'rejected',                            -- Human rejected
    'enabled',                             -- Activated in production
    'disabled',                            -- Manually disabled
    'auto-disabled',                       -- System disabled due to anomaly
    'backtest-passed',                     -- Backtest validation passed
    'backtest-failed',                     -- Backtest validation failed
    'shadow-started',                      -- Shadow mode started
    'shadow-completed',                    -- Shadow mode completed
    'expired',                             -- Auto-expired due to inactivity
    'auto-promoted',                       -- Auto-promoted from shadow to approved
    'auto-demoted',                        -- Auto-demoted from approved to stale
    'reactivated',                         -- Reactivated from stale to shadow
    'imported',                            -- Imported from static patterns
    'ready-for-review'                     -- Pattern ready for human review
  )),
  actor TEXT,                              -- 'ai:model', 'human:name', 'system:evaluator'
  reason TEXT,
  metadata TEXT,                           -- JSON with additional context
  created_at INTEGER DEFAULT (unixepoch()),

  FOREIGN KEY (pattern_id) REFERENCES transient_pattern_suggestions(id)
);

CREATE INDEX IF NOT EXISTS idx_audit_pattern ON pattern_audit_log(pattern_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON pattern_audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_created ON pattern_audit_log(created_at DESC);


-- =============================================================================
-- ERROR CLUSTERS (from 042)
-- =============================================================================
-- Groups similar unclassified errors for AI pattern discovery.

CREATE TABLE IF NOT EXISTS error_clusters (
  id TEXT PRIMARY KEY,

  -- Cluster identification
  cluster_hash TEXT NOT NULL UNIQUE,       -- Hash of normalised message for dedup
  representative_message TEXT NOT NULL,    -- Sample message for display

  -- Statistics
  occurrence_count INTEGER DEFAULT 1,
  unique_fingerprints INTEGER DEFAULT 1,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,

  -- Scripts affected
  scripts TEXT,                            -- JSON array of script names

  -- Processing status
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'suggested', 'ignored')),
  suggestion_id TEXT,                      -- Reference to created suggestion

  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),

  FOREIGN KEY (suggestion_id) REFERENCES transient_pattern_suggestions(id)
);

CREATE INDEX IF NOT EXISTS idx_clusters_status ON error_clusters(status);
CREATE INDEX IF NOT EXISTS idx_clusters_count ON error_clusters(occurrence_count DESC);
CREATE INDEX IF NOT EXISTS idx_clusters_hash ON error_clusters(cluster_hash);


-- =============================================================================
-- PATTERN MATCH EVIDENCE (from 050)
-- =============================================================================
-- Tracks when patterns match errors during shadow evaluation.
-- Provides rich context for human review decisions.

CREATE TABLE IF NOT EXISTS pattern_match_evidence (
  id TEXT PRIMARY KEY,
  pattern_id TEXT NOT NULL,

  -- Match context
  script_name TEXT NOT NULL,
  project TEXT,
  error_fingerprint TEXT,
  normalized_message TEXT,

  -- Match metadata
  matched_at INTEGER NOT NULL DEFAULT (unixepoch()),
  error_type TEXT,                         -- 'exception', 'soft_error', 'warning'
  priority TEXT,                           -- 'P0' - 'P4'

  FOREIGN KEY (pattern_id) REFERENCES transient_pattern_suggestions(id)
);

CREATE INDEX IF NOT EXISTS idx_pattern_match_evidence_pattern_id ON pattern_match_evidence(pattern_id);
CREATE INDEX IF NOT EXISTS idx_pattern_match_evidence_matched_at ON pattern_match_evidence(matched_at);
CREATE INDEX IF NOT EXISTS idx_pattern_match_evidence_project ON pattern_match_evidence(project);
CREATE INDEX IF NOT EXISTS idx_pattern_match_evidence_script ON pattern_match_evidence(script_name);
