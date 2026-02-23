/**
 * Platform Search Worker
 *
 * Platform-wide full-text search using SQLite FTS5.
 * Searches across errors, patterns, settings, pages, and services.
 *
 * Storage:
 * - D1: search_index table with FTS5 virtual table
 *
 * @module workers/platform-search
 * @created 2026-02-03
 * @task task-303.1
 */

import type {
  KVNamespace,
  ExecutionContext,
  D1Database,
} from '@cloudflare/workers-types';
import {
  withFeatureBudget,
  CircuitBreakerError,
  createLoggerFromRequest,
} from '@littlebearapps/platform-consumer-sdk';

// =============================================================================
// TYPES
// =============================================================================

interface Env {
  PLATFORM_DB: D1Database;
  PLATFORM_CACHE: KVNamespace;
  CLOUDFLARE_ACCOUNT_ID: string;
}

interface SearchDocument {
  id: string;
  content_type: string;
  project: string | null;
  title: string;
  content: string;
  url: string;
  metadata: string | null;
  indexed_at: number;
  source_updated_at: number | null;
}

interface SearchResult extends SearchDocument {
  rank: number;
  snippet: string;
  parsed_metadata?: Record<string, unknown>;
}

interface IndexDocumentRequest {
  id: string;
  content_type: string;
  project?: string;
  title: string;
  content: string;
  url: string;
  metadata?: Record<string, unknown>;
  source_updated_at?: number;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const FEATURE_ID = 'platform:search:api';
const VALID_CONTENT_TYPES = ['error', 'pattern', 'setting', 'page', 'service', 'opportunity', 'draft', 'project'];
const MAX_RESULTS = 100;
const DEFAULT_LIMIT = 20;

// =============================================================================
// HELPERS
// =============================================================================

function sanitizeQuery(query: string): string {
  // Escape special FTS5 characters and prepare for MATCH
  // Remove potentially dangerous characters while preserving search intent
  return query
    .replace(/['"]/g, '') // Remove quotes
    .replace(/[-+*()]/g, ' ') // Replace operators with spaces
    .trim()
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .map((term) => `"${term}"*`) // Prefix match each term
    .join(' ');
}

function extractSnippet(content: string, query: string, maxLength: number = 200): string {
  const lowerContent = content.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);

  // Find the first matching term
  let startIndex = 0;
  for (const term of terms) {
    const index = lowerContent.indexOf(term);
    if (index !== -1) {
      startIndex = Math.max(0, index - 50);
      break;
    }
  }

  // Extract snippet around the match
  let snippet = content.substring(startIndex, startIndex + maxLength);

  // Add ellipsis if truncated
  if (startIndex > 0) {
    snippet = '...' + snippet;
  }
  if (startIndex + maxLength < content.length) {
    snippet = snippet + '...';
  }

  return snippet;
}

// =============================================================================
// API HANDLERS
// =============================================================================

async function handleSearch(env: Env, url: URL): Promise<Response> {
  const query = url.searchParams.get('q');
  if (!query || query.trim().length === 0) {
    return Response.json({ error: 'Query parameter q is required' }, { status: 400 });
  }

  const contentType = url.searchParams.get('type');
  const project = url.searchParams.get('project');
  const limit = Math.min(
    parseInt(url.searchParams.get('limit') || String(DEFAULT_LIMIT), 10),
    MAX_RESULTS
  );
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  // Sanitize query for FTS5
  const sanitizedQuery = sanitizeQuery(query);
  if (sanitizedQuery.length === 0) {
    return Response.json({ results: [], count: 0, query });
  }

  // Build the search query
  // FTS5 MATCH query with ranking by bm25
  let sql = `
    SELECT
      search_index.*,
      bm25(search_fts) as rank
    FROM search_fts
    JOIN search_index ON search_fts.rowid = search_index.rowid
    WHERE search_fts MATCH ?
  `;
  const params: (string | number)[] = [sanitizedQuery];

  if (contentType && VALID_CONTENT_TYPES.includes(contentType)) {
    sql += ' AND search_index.content_type = ?';
    params.push(contentType);
  }

  if (project) {
    sql += ' AND (search_index.project = ? OR search_index.project IS NULL)';
    params.push(project);
  }

  sql += ' ORDER BY rank LIMIT ? OFFSET ?';
  params.push(limit, offset);

  try {
    const result = await env.PLATFORM_DB.prepare(sql).bind(...params).all<SearchDocument & { rank: number }>();
    const documents = result.results || [];

    // Enrich results with snippets and parsed metadata
    const results: SearchResult[] = documents.map((doc) => ({
      ...doc,
      snippet: extractSnippet(doc.content, query),
      parsed_metadata: doc.metadata ? JSON.parse(doc.metadata) : undefined,
    }));

    // Group by content type for UI
    const grouped: Record<string, SearchResult[]> = {};
    for (const result of results) {
      if (!grouped[result.content_type]) {
        grouped[result.content_type] = [];
      }
      grouped[result.content_type].push(result);
    }

    return Response.json({
      results,
      grouped,
      count: results.length,
      query,
      filters: {
        type: contentType,
        project,
      },
    });
  } catch (error) {
    // FTS5 query errors are common with malformed input
    console.error('Search error:', error);
    return Response.json({
      results: [],
      count: 0,
      query,
      error: 'Search query could not be processed',
    });
  }
}

async function handleIndex(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as IndexDocumentRequest;

  if (!body.id || !body.content_type || !body.title || !body.content || !body.url) {
    return Response.json(
      { error: 'Missing required fields: id, content_type, title, content, url' },
      { status: 400 }
    );
  }

  if (!VALID_CONTENT_TYPES.includes(body.content_type)) {
    return Response.json(
      { error: `Invalid content_type. Must be one of: ${VALID_CONTENT_TYPES.join(', ')}` },
      { status: 400 }
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const metadataJson = body.metadata ? JSON.stringify(body.metadata) : null;

  // Upsert the document (triggers will handle FTS sync)
  await env.PLATFORM_DB.prepare(
    `INSERT INTO search_index (id, content_type, project, title, content, url, metadata, indexed_at, source_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       content_type = excluded.content_type,
       project = excluded.project,
       title = excluded.title,
       content = excluded.content,
       url = excluded.url,
       metadata = excluded.metadata,
       indexed_at = excluded.indexed_at,
       source_updated_at = excluded.source_updated_at`
  )
    .bind(
      body.id,
      body.content_type,
      body.project || null,
      body.title,
      body.content,
      body.url,
      metadataJson,
      now,
      body.source_updated_at || null
    )
    .run();

  return Response.json({ success: true, id: body.id }, { status: 201 });
}

async function handleBulkIndex(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { documents: IndexDocumentRequest[] };

  if (!body.documents || !Array.isArray(body.documents)) {
    return Response.json({ error: 'Missing documents array' }, { status: 400 });
  }

  const now = Math.floor(Date.now() / 1000);
  let indexed = 0;
  let failed = 0;

  for (const doc of body.documents) {
    if (!doc.id || !doc.content_type || !doc.title || !doc.content || !doc.url) {
      failed++;
      continue;
    }
    if (!VALID_CONTENT_TYPES.includes(doc.content_type)) {
      failed++;
      continue;
    }

    try {
      const metadataJson = doc.metadata ? JSON.stringify(doc.metadata) : null;
      await env.PLATFORM_DB.prepare(
        `INSERT INTO search_index (id, content_type, project, title, content, url, metadata, indexed_at, source_updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           content_type = excluded.content_type,
           project = excluded.project,
           title = excluded.title,
           content = excluded.content,
           url = excluded.url,
           metadata = excluded.metadata,
           indexed_at = excluded.indexed_at,
           source_updated_at = excluded.source_updated_at`
      )
        .bind(
          doc.id,
          doc.content_type,
          doc.project || null,
          doc.title,
          doc.content,
          doc.url,
          metadataJson,
          now,
          doc.source_updated_at || null
        )
        .run();
      indexed++;
    } catch {
      failed++;
    }
  }

  return Response.json({
    success: failed === 0,
    indexed,
    failed,
    total: body.documents.length,
  });
}

async function handleReindex(env: Env, contentType: string): Promise<Response> {
  if (!VALID_CONTENT_TYPES.includes(contentType)) {
    return Response.json(
      { error: `Invalid content_type. Must be one of: ${VALID_CONTENT_TYPES.join(', ')}` },
      { status: 400 }
    );
  }

  // Delete all documents of this type (triggers will clean up FTS)
  const result = await env.PLATFORM_DB.prepare(
    'DELETE FROM search_index WHERE content_type = ?'
  )
    .bind(contentType)
    .run();

  return Response.json({
    success: true,
    content_type: contentType,
    deleted: result.meta.changes,
    message: 'Index cleared. Documents must be re-indexed by their source workers.',
  });
}

async function handleDelete(env: Env, id: string): Promise<Response> {
  const result = await env.PLATFORM_DB.prepare('DELETE FROM search_index WHERE id = ?')
    .bind(id)
    .run();

  if (result.meta.changes === 0) {
    return Response.json({ error: 'Document not found' }, { status: 404 });
  }

  return Response.json({ success: true, deleted: id });
}

async function handleStats(env: Env): Promise<Response> {
  // Get counts by content type
  const typeStats = await env.PLATFORM_DB.prepare(
    `SELECT content_type, COUNT(*) as count
     FROM search_index
     GROUP BY content_type
     ORDER BY count DESC`
  ).all<{ content_type: string; count: number }>();

  // Get counts by project
  const projectStats = await env.PLATFORM_DB.prepare(
    `SELECT COALESCE(project, 'global') as project, COUNT(*) as count
     FROM search_index
     GROUP BY project
     ORDER BY count DESC`
  ).all<{ project: string; count: number }>();

  // Get total count
  const totalResult = await env.PLATFORM_DB.prepare(
    'SELECT COUNT(*) as count FROM search_index'
  ).first<{ count: number }>();

  // Get oldest and newest indexed
  const rangeResult = await env.PLATFORM_DB.prepare(
    'SELECT MIN(indexed_at) as oldest, MAX(indexed_at) as newest FROM search_index'
  ).first<{ oldest: number; newest: number }>();

  return Response.json({
    total: totalResult?.count || 0,
    by_type: typeStats.results || [],
    by_project: projectStats.results || [],
    index_range: {
      oldest: rangeResult?.oldest ? new Date(rangeResult.oldest * 1000).toISOString() : null,
      newest: rangeResult?.newest ? new Date(rangeResult.newest * 1000).toISOString() : null,
    },
  });
}

// =============================================================================
// MAIN WORKER
// =============================================================================

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // Health check (lightweight)
    if (url.pathname === '/health') {
      return Response.json({
        status: 'ok',
        service: 'platform-search',
        timestamp: new Date().toISOString(),
      });
    }

    const log = createLoggerFromRequest(request, env, 'platform-search', FEATURE_ID);

    try {
      const trackedEnv = withFeatureBudget(env, FEATURE_ID, { ctx });

      // GET /search - Perform search
      if (url.pathname === '/search' && request.method === 'GET') {
        return await handleSearch(trackedEnv, url);
      }

      // POST /search/index - Index a document
      if (url.pathname === '/search/index' && request.method === 'POST') {
        return await handleIndex(request, trackedEnv);
      }

      // POST /search/index/bulk - Bulk index documents
      if (url.pathname === '/search/index/bulk' && request.method === 'POST') {
        return await handleBulkIndex(request, trackedEnv);
      }

      // POST /search/reindex/:type - Clear and reindex a content type
      const reindexMatch = url.pathname.match(/^\/search\/reindex\/([^/]+)$/);
      if (reindexMatch && request.method === 'POST') {
        return await handleReindex(trackedEnv, reindexMatch[1]);
      }

      // DELETE /search/index/:id - Delete a document
      const deleteMatch = url.pathname.match(/^\/search\/index\/([^/]+)$/);
      if (deleteMatch && request.method === 'DELETE') {
        return await handleDelete(trackedEnv, deleteMatch[1]);
      }

      // GET /search/stats - Get index statistics
      if (url.pathname === '/search/stats' && request.method === 'GET') {
        return await handleStats(trackedEnv);
      }

      // API index
      return Response.json({
        service: 'platform-search',
        version: '1.0.0',
        endpoints: [
          'GET  /health - Health check',
          'GET  /search?q=<query> - Search (with optional type, project, limit, offset)',
          'POST /search/index - Index a document',
          'POST /search/index/bulk - Bulk index documents',
          'POST /search/reindex/:type - Clear index for content type',
          'DELETE /search/index/:id - Delete a document',
          'GET  /search/stats - Index statistics',
        ],
        valid_content_types: VALID_CONTENT_TYPES,
      });
    } catch (error) {
      if (error instanceof CircuitBreakerError) {
        log.warn('Circuit breaker tripped', error);
        return Response.json(
          { error: 'Service temporarily unavailable' },
          { status: 503, headers: { 'Retry-After': '60' } }
        );
      }
      log.error('Request failed', error);
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }
  },
};
