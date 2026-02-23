-- =============================================================================
-- 005_error_collection.sql — Error tracking (standard tier)
-- =============================================================================
-- Consolidated from original migrations: 038, 039, 041, 043
--
-- Tables:
--   error_occurrences      — Error tracking with deduplication and GitHub linkage
--   warning_digests        — Daily digest tracking for P4 warnings
--   fingerprint_decisions  — Fingerprint decision audit log for post-hoc analysis
--
-- The error_occurrences table uses the FINAL schema from migration 043 which
-- recreated the table with the correct CHECK constraint (adding 'pending_digest'
-- and 'digested' status values) and merged columns from 039 and 041.
-- =============================================================================


-- =============================================================================
-- ERROR OCCURRENCES (final schema from 043, merging 038 + 039 + 041)
-- =============================================================================
-- Error tracking table for deduplication, GitHub issue linkage, and history.
-- Includes digest columns (from 039) and error_category (from 041).

CREATE TABLE IF NOT EXISTS error_occurrences (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  script_name TEXT NOT NULL,
  project TEXT NOT NULL,
  error_type TEXT NOT NULL CHECK (error_type IN ('exception', 'cpu_limit', 'memory_limit', 'soft_error', 'warning')),
  priority TEXT NOT NULL CHECK (priority IN ('P0', 'P1', 'P2', 'P3', 'P4')),

  -- GitHub linkage
  github_issue_number INTEGER,
  github_issue_url TEXT,
  github_repo TEXT NOT NULL,

  -- Status tracking (includes 'pending_digest' and 'digested' from 043)
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'wont_fix', 'pending_digest', 'digested')),
  resolved_at INTEGER,
  resolved_by TEXT,                        -- Commit SHA or 'auto-close'

  -- Occurrence tracking
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  occurrence_count INTEGER DEFAULT 1,

  -- Request context (last occurrence)
  last_request_url TEXT,
  last_request_method TEXT,
  last_colo TEXT,
  last_country TEXT,
  last_cf_ray TEXT,

  -- Error details (last occurrence)
  last_exception_name TEXT,
  last_exception_message TEXT,
  last_logs_json TEXT,                     -- JSON array of last 20 log entries

  -- Digest columns (from 039)
  digest_date TEXT,
  digest_issue_number INTEGER,
  normalized_message TEXT,

  -- Error category for transient error grouping (from 041)
  error_category TEXT,

  -- Timestamps
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),

  UNIQUE(fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_error_occurrences_status ON error_occurrences(status);
CREATE INDEX IF NOT EXISTS idx_error_occurrences_project ON error_occurrences(project);
CREATE INDEX IF NOT EXISTS idx_error_occurrences_script ON error_occurrences(script_name);
CREATE INDEX IF NOT EXISTS idx_error_occurrences_fingerprint ON error_occurrences(fingerprint);
CREATE INDEX IF NOT EXISTS idx_error_occurrences_last_seen ON error_occurrences(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_occurrences_priority ON error_occurrences(priority, status);
CREATE INDEX IF NOT EXISTS idx_error_occurrences_github ON error_occurrences(github_issue_number) WHERE github_issue_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_error_occurrences_pending_digest ON error_occurrences(status, error_type, script_name, fingerprint) WHERE status = 'pending_digest';
CREATE INDEX IF NOT EXISTS idx_error_occurrences_digest_date ON error_occurrences(digest_date, script_name) WHERE digest_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_error_occurrences_category ON error_occurrences(error_category) WHERE error_category IS NOT NULL;


-- =============================================================================
-- WARNING DIGESTS (from 039)
-- =============================================================================
-- Tracks daily digest issues. Allows finding/updating existing digest issues
-- for a given day to batch P4 warnings into single GitHub issues.

CREATE TABLE IF NOT EXISTS warning_digests (
  id TEXT PRIMARY KEY,
  digest_date TEXT NOT NULL,               -- YYYY-MM-DD
  script_name TEXT NOT NULL,
  fingerprint TEXT NOT NULL,               -- Normalised fingerprint (groups similar warnings)
  normalized_message TEXT NOT NULL,        -- Human-readable warning type
  github_repo TEXT NOT NULL,
  github_issue_number INTEGER,
  github_issue_url TEXT,
  occurrence_count INTEGER DEFAULT 0,
  first_occurrence_at INTEGER NOT NULL,
  last_occurrence_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(digest_date, script_name, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_warning_digests_lookup
  ON warning_digests(digest_date, script_name);


-- =============================================================================
-- FINGERPRINT DECISIONS (from 041)
-- =============================================================================
-- Stores fingerprint decisions for post-hoc analysis of error classification.
-- Tracks why each error was handled the way it was.

CREATE TABLE IF NOT EXISTS fingerprint_decisions (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL DEFAULT (unixepoch()),

  -- Context
  script_name TEXT NOT NULL,
  error_type TEXT NOT NULL,

  -- Fingerprint details
  raw_message TEXT,                        -- Original error message (first 500 chars)
  normalized_message TEXT,                 -- Normalised message used for fingerprinting
  computed_fingerprint TEXT NOT NULL,
  category TEXT,                           -- Transient error category if classified

  -- Decision outcome
  decision TEXT NOT NULL CHECK (decision IN (
    'new_issue',                           -- Created new GitHub issue
    'existing_issue',                      -- Updated existing issue
    'transient_window',                    -- Transient error, issue exists for today
    'suppressed',                          -- Suppressed (e.g., muted issue)
    'rate_limited',                        -- Rate limited, no action taken
    'digest'                               -- Stored for daily digest
  )),

  -- GitHub linkage
  github_issue_number INTEGER,
  github_repo TEXT,

  -- Metadata
  is_transient INTEGER DEFAULT 0,
  occurrence_count INTEGER,

  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_fingerprint_decisions_script
  ON fingerprint_decisions(script_name, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_fingerprint_decisions_fingerprint
  ON fingerprint_decisions(computed_fingerprint);
CREATE INDEX IF NOT EXISTS idx_fingerprint_decisions_category
  ON fingerprint_decisions(category) WHERE category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fingerprint_decisions_decision
  ON fingerprint_decisions(decision, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_fingerprint_decisions_timestamp
  ON fingerprint_decisions(timestamp DESC);
