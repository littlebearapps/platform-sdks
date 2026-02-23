-- =============================================================================
-- 007_notifications_search.sql — Notifications, search, settings (full tier)
-- =============================================================================
-- Consolidated from original migrations: 044, 045, 046
--
-- Tables:
--   notifications       — Cross-project notifications from various sources
--   platform_settings   — Unified settings with project/category/key namespacing
--   search_index        — Main search index table
--   search_fts          — FTS5 virtual table for full-text search
--
-- Triggers:
--   search_fts_ai       — Sync FTS index on INSERT
--   search_fts_ad       — Sync FTS index on DELETE
--   search_fts_au       — Sync FTS index on UPDATE
-- =============================================================================


-- =============================================================================
-- NOTIFICATIONS (from 044)
-- =============================================================================
-- Unified notifications from various sources:
-- - error-collector: P0-P2 errors needing attention
-- - pattern-discovery: AI-suggested patterns pending approval
-- - circuit-breaker: Feature budget warnings and pauses
-- - usage: Cost threshold warnings
--
-- Per-user read state is stored in KV for fast access.

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('error', 'warning', 'info', 'success')),
  source TEXT NOT NULL,                    -- 'error-collector', 'pattern-discovery', etc.
  source_id TEXT,                          -- Reference to source record
  title TEXT NOT NULL,
  description TEXT,
  priority TEXT DEFAULT 'info' CHECK (priority IN ('critical', 'high', 'medium', 'low', 'info')),
  action_url TEXT,                         -- Deep link to relevant page
  action_label TEXT,                       -- Button text
  project TEXT,                            -- Project slug or NULL for global
  created_at INTEGER DEFAULT (unixepoch()),
  expires_at INTEGER                       -- Optional expiry for transient notifications
);

CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_project ON notifications(project);
CREATE INDEX IF NOT EXISTS idx_notifications_source ON notifications(source);
CREATE INDEX IF NOT EXISTS idx_notifications_priority ON notifications(priority);
CREATE INDEX IF NOT EXISTS idx_notifications_project_created ON notifications(project, created_at DESC);


-- =============================================================================
-- PLATFORM SETTINGS (from 045)
-- =============================================================================
-- Unified settings with project/category/key namespacing.
-- Categories: notifications, thresholds, display, api.

CREATE TABLE IF NOT EXISTS platform_settings (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,                   -- 'global', 'platform', or project slug
  category TEXT NOT NULL,                  -- 'notifications', 'thresholds', 'display', 'api'
  key TEXT NOT NULL,
  value TEXT NOT NULL,                     -- JSON-encoded value
  description TEXT,
  updated_at INTEGER DEFAULT (unixepoch()),
  updated_by TEXT,
  UNIQUE(project, category, key)
);

CREATE INDEX IF NOT EXISTS idx_settings_project_category ON platform_settings(project, category);
CREATE INDEX IF NOT EXISTS idx_settings_project_key ON platform_settings(project, key);


-- =============================================================================
-- SEARCH INDEX (from 046)
-- =============================================================================
-- Platform-wide search across errors, patterns, settings, pages, services.
-- Uses SQLite FTS5 for efficient full-text search with:
-- - Prefix matching (e.g., "err*")
-- - Phrase matching (e.g., "circuit breaker")
-- - Boolean operators (AND, OR, NOT)

-- Main search index table
CREATE TABLE IF NOT EXISTS search_index (
  id TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,              -- 'error', 'pattern', 'setting', 'page', 'service'
  project TEXT,                            -- Project slug or NULL for global
  title TEXT NOT NULL,
  content TEXT NOT NULL,                   -- Searchable content (normalised)
  url TEXT NOT NULL,                       -- Deep link
  metadata TEXT,                           -- JSON with type-specific data
  indexed_at INTEGER DEFAULT (unixepoch()),
  source_updated_at INTEGER                -- When the source record was last updated
);

CREATE INDEX IF NOT EXISTS idx_search_content_type ON search_index(content_type, project);
CREATE INDEX IF NOT EXISTS idx_search_source_updated ON search_index(source_updated_at);

-- FTS5 virtual table for full-text search
-- content='search_index' makes it a content-less FTS table referencing the main table
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  title,
  content,
  content='search_index',
  content_rowid='rowid',
  tokenize='porter unicode61'              -- Porter stemming + Unicode support
);

-- Trigger to keep FTS index in sync on INSERT
CREATE TRIGGER IF NOT EXISTS search_fts_ai AFTER INSERT ON search_index BEGIN
  INSERT INTO search_fts(rowid, title, content)
  VALUES (new.rowid, new.title, new.content);
END;

-- Trigger to keep FTS index in sync on DELETE
CREATE TRIGGER IF NOT EXISTS search_fts_ad AFTER DELETE ON search_index BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, content)
  VALUES ('delete', old.rowid, old.title, old.content);
END;

-- Trigger to keep FTS index in sync on UPDATE
CREATE TRIGGER IF NOT EXISTS search_fts_au AFTER UPDATE ON search_index BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, content)
  VALUES ('delete', old.rowid, old.title, old.content);
  INSERT INTO search_fts(rowid, title, content)
  VALUES (new.rowid, new.title, new.content);
END;
