/**
 * Platform Settings Worker
 *
 * Unified settings management with project/category/key namespacing.
 * Provides API endpoints for reading and updating platform settings.
 *
 * Storage:
 * - D1: platform_settings table
 *
 * @module workers/platform-settings
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
} from '@littlebearapps/platform-sdk';

// =============================================================================
// TYPES
// =============================================================================

interface Env {
  PLATFORM_DB: D1Database;
  PLATFORM_CACHE: KVNamespace;
  CLOUDFLARE_ACCOUNT_ID: string;
}

interface Setting {
  id: string;
  project: string;
  category: string;
  key: string;
  value: string; // JSON-encoded
  description: string | null;
  updated_at: number;
  updated_by: string | null;
}

interface SettingGroup {
  project: string;
  category: string;
  settings: Setting[];
}

interface UpdateSettingRequest {
  value: unknown;
  description?: string;
}

interface BulkUpdateRequest {
  settings: Array<{
    project: string;
    category: string;
    key: string;
    value: unknown;
    description?: string;
  }>;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const FEATURE_ID = 'platform:settings:api';
// Add your project names here, or load from D1 project_registry table
const VALID_PROJECTS = ['global'];
const VALID_CATEGORIES = ['notifications', 'thresholds', 'display', 'api', 'features'];

// =============================================================================
// HELPERS
// =============================================================================

function generateId(project: string, category: string, key: string): string {
  return `${project}:${category}:${key}`;
}

function getUserEmail(request: Request): string {
  const cfAccessEmail = request.headers.get('cf-access-authenticated-user-email');
  return cfAccessEmail || 'anonymous';
}

function validateProject(project: string): boolean {
  return VALID_PROJECTS.includes(project);
}

function validateCategory(category: string): boolean {
  return VALID_CATEGORIES.includes(category);
}

// =============================================================================
// API HANDLERS
// =============================================================================

async function handleListSettings(env: Env, url: URL): Promise<Response> {
  const project = url.searchParams.get('project');
  const category = url.searchParams.get('category');

  let query = 'SELECT * FROM platform_settings WHERE 1=1';
  const params: string[] = [];

  if (project) {
    query += ' AND project = ?';
    params.push(project);
  }
  if (category) {
    query += ' AND category = ?';
    params.push(category);
  }

  query += ' ORDER BY project, category, key';

  const result = await env.PLATFORM_DB.prepare(query).bind(...params).all<Setting>();
  const settings = result.results || [];

  // Group by project and category
  const grouped: Record<string, Record<string, Setting[]>> = {};
  for (const setting of settings) {
    if (!grouped[setting.project]) {
      grouped[setting.project] = {};
    }
    if (!grouped[setting.project][setting.category]) {
      grouped[setting.project][setting.category] = [];
    }
    grouped[setting.project][setting.category].push(setting);
  }

  return Response.json({
    settings,
    grouped,
    count: settings.length,
  });
}

async function handleGetSettings(
  env: Env,
  project: string,
  category: string
): Promise<Response> {
  if (!validateProject(project)) {
    return Response.json({ error: `Invalid project: ${project}` }, { status: 400 });
  }
  if (!validateCategory(category)) {
    return Response.json({ error: `Invalid category: ${category}` }, { status: 400 });
  }

  const result = await env.PLATFORM_DB.prepare(
    'SELECT * FROM platform_settings WHERE project = ? AND category = ? ORDER BY key'
  )
    .bind(project, category)
    .all<Setting>();

  const settings = result.results || [];

  // Parse JSON values for response
  const parsed = settings.map((s) => ({
    ...s,
    parsed_value: JSON.parse(s.value),
  }));

  return Response.json({
    project,
    category,
    settings: parsed,
    count: settings.length,
  });
}

async function handleGetSetting(
  env: Env,
  project: string,
  category: string,
  key: string
): Promise<Response> {
  if (!validateProject(project)) {
    return Response.json({ error: `Invalid project: ${project}` }, { status: 400 });
  }
  if (!validateCategory(category)) {
    return Response.json({ error: `Invalid category: ${category}` }, { status: 400 });
  }

  const result = await env.PLATFORM_DB.prepare(
    'SELECT * FROM platform_settings WHERE project = ? AND category = ? AND key = ?'
  )
    .bind(project, category, key)
    .first<Setting>();

  if (!result) {
    return Response.json({ error: 'Setting not found' }, { status: 404 });
  }

  return Response.json({
    ...result,
    parsed_value: JSON.parse(result.value),
  });
}

async function handleUpdateSetting(
  request: Request,
  env: Env,
  project: string,
  category: string,
  key: string
): Promise<Response> {
  if (!validateProject(project)) {
    return Response.json({ error: `Invalid project: ${project}` }, { status: 400 });
  }
  if (!validateCategory(category)) {
    return Response.json({ error: `Invalid category: ${category}` }, { status: 400 });
  }

  const body = (await request.json()) as UpdateSettingRequest;
  const email = getUserEmail(request);
  const id = generateId(project, category, key);
  const now = Math.floor(Date.now() / 1000);
  const valueJson = JSON.stringify(body.value);

  // Upsert the setting
  await env.PLATFORM_DB.prepare(
    `INSERT INTO platform_settings (id, project, category, key, value, description, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project, category, key) DO UPDATE SET
       value = excluded.value,
       description = COALESCE(excluded.description, platform_settings.description),
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`
  )
    .bind(id, project, category, key, valueJson, body.description || null, now, email)
    .run();

  return Response.json({
    success: true,
    id,
    project,
    category,
    key,
    value: body.value,
    updated_at: now,
    updated_by: email,
  });
}

async function handleBulkUpdate(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as BulkUpdateRequest;
  const email = getUserEmail(request);
  const now = Math.floor(Date.now() / 1000);

  if (!body.settings || !Array.isArray(body.settings)) {
    return Response.json({ error: 'Missing settings array' }, { status: 400 });
  }

  const results: Array<{ id: string; success: boolean; error?: string }> = [];

  for (const setting of body.settings) {
    if (!validateProject(setting.project)) {
      results.push({
        id: generateId(setting.project, setting.category, setting.key),
        success: false,
        error: `Invalid project: ${setting.project}`,
      });
      continue;
    }
    if (!validateCategory(setting.category)) {
      results.push({
        id: generateId(setting.project, setting.category, setting.key),
        success: false,
        error: `Invalid category: ${setting.category}`,
      });
      continue;
    }

    const id = generateId(setting.project, setting.category, setting.key);
    const valueJson = JSON.stringify(setting.value);

    try {
      await env.PLATFORM_DB.prepare(
        `INSERT INTO platform_settings (id, project, category, key, value, description, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project, category, key) DO UPDATE SET
           value = excluded.value,
           description = COALESCE(excluded.description, platform_settings.description),
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`
      )
        .bind(
          id,
          setting.project,
          setting.category,
          setting.key,
          valueJson,
          setting.description || null,
          now,
          email
        )
        .run();

      results.push({ id, success: true });
    } catch (error) {
      results.push({
        id,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  const successCount = results.filter((r) => r.success).length;
  return Response.json({
    success: successCount === body.settings.length,
    total: body.settings.length,
    succeeded: successCount,
    failed: body.settings.length - successCount,
    results,
  });
}

async function handleDeleteSetting(
  env: Env,
  project: string,
  category: string,
  key: string
): Promise<Response> {
  if (!validateProject(project)) {
    return Response.json({ error: `Invalid project: ${project}` }, { status: 400 });
  }
  if (!validateCategory(category)) {
    return Response.json({ error: `Invalid category: ${category}` }, { status: 400 });
  }

  const result = await env.PLATFORM_DB.prepare(
    'DELETE FROM platform_settings WHERE project = ? AND category = ? AND key = ?'
  )
    .bind(project, category, key)
    .run();

  if (result.meta.changes === 0) {
    return Response.json({ error: 'Setting not found' }, { status: 404 });
  }

  return Response.json({ success: true, deleted: generateId(project, category, key) });
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
        service: 'platform-settings',
        timestamp: new Date().toISOString(),
      });
    }

    const log = createLoggerFromRequest(request, env, 'platform-settings', FEATURE_ID);

    try {
      const trackedEnv = withFeatureBudget(env, FEATURE_ID, { ctx });

      // GET /settings - List all settings
      if (url.pathname === '/settings' && request.method === 'GET') {
        return await handleListSettings(trackedEnv, url);
      }

      // PUT /settings/bulk - Bulk update
      if (url.pathname === '/settings/bulk' && request.method === 'PUT') {
        return await handleBulkUpdate(request, trackedEnv);
      }

      // Routes with project/category/key parameters
      // GET /settings/:project/:category
      const categoryMatch = url.pathname.match(/^\/settings\/([^/]+)\/([^/]+)$/);
      if (categoryMatch && request.method === 'GET') {
        return await handleGetSettings(trackedEnv, categoryMatch[1], categoryMatch[2]);
      }

      // GET/PUT/DELETE /settings/:project/:category/:key
      const keyMatch = url.pathname.match(/^\/settings\/([^/]+)\/([^/]+)\/([^/]+)$/);
      if (keyMatch) {
        const [, project, category, key] = keyMatch;
        if (request.method === 'GET') {
          return await handleGetSetting(trackedEnv, project, category, key);
        }
        if (request.method === 'PUT') {
          return await handleUpdateSetting(request, trackedEnv, project, category, key);
        }
        if (request.method === 'DELETE') {
          return await handleDeleteSetting(trackedEnv, project, category, key);
        }
      }

      // API index
      return Response.json({
        service: 'platform-settings',
        version: '1.0.0',
        endpoints: [
          'GET  /health - Health check',
          'GET  /settings - List all settings (with filters)',
          'GET  /settings/:project/:category - Get settings for project/category',
          'GET  /settings/:project/:category/:key - Get specific setting',
          'PUT  /settings/:project/:category/:key - Update setting',
          'DELETE /settings/:project/:category/:key - Delete setting',
          'PUT  /settings/bulk - Bulk update multiple settings',
        ],
        valid_projects: VALID_PROJECTS,
        valid_categories: VALID_CATEGORIES,
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
