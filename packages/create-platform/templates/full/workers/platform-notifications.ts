/**
 * Platform Notifications Worker
 *
 * Unified notification system for cross-project notifications.
 * Provides API endpoints for listing, reading, and managing notifications.
 *
 * Storage:
 * - D1: Full notification history
 * - KV: Per-user read state (NOTIFICATION_READ:{email})
 *
 * @module workers/platform-notifications
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

interface Notification {
  id: string;
  category: 'error' | 'warning' | 'info' | 'success';
  source: string;
  source_id: string | null;
  title: string;
  description: string | null;
  priority: 'critical' | 'high' | 'medium' | 'low' | 'info';
  action_url: string | null;
  action_label: string | null;
  project: string | null;
  created_at: number;
  expires_at: number | null;
  is_read?: boolean;
}

interface NotificationPreferences {
  email_enabled: boolean;
  slack_enabled: boolean;
  in_app_enabled: boolean;
  digest_frequency: 'realtime' | 'hourly' | 'daily' | 'weekly';
  muted_sources: string[];
}

interface CreateNotificationRequest {
  category: Notification['category'];
  source: string;
  source_id?: string;
  title: string;
  description?: string;
  priority?: Notification['priority'];
  action_url?: string;
  action_label?: string;
  project?: string;
  expires_at?: number;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const FEATURE_ID = 'platform:notifications:api';
const KV_READ_PREFIX = 'NOTIFICATION_READ:';
const KV_COUNT_PREFIX = 'NOTIFICATION_COUNT:';
const KV_PREFS_PREFIX = 'NOTIFICATION_PREFS:';
const READ_STATE_TTL = 90 * 24 * 60 * 60; // 90 days
const COUNT_CACHE_TTL = 5 * 60; // 5 minutes

// =============================================================================
// HELPERS
// =============================================================================

function generateId(): string {
  return `notif_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

function getUserEmail(request: Request): string {
  // Get user email from Cloudflare Access JWT
  const cfAccessEmail = request.headers.get('cf-access-authenticated-user-email');
  return cfAccessEmail || 'anonymous';
}

async function getReadState(kv: KVNamespace, email: string): Promise<Set<string>> {
  const key = `${KV_READ_PREFIX}${email}`;
  const data = await kv.get(key);
  if (!data) return new Set();
  try {
    return new Set(JSON.parse(data));
  } catch {
    return new Set();
  }
}

async function setReadState(
  kv: KVNamespace,
  email: string,
  readIds: Set<string>
): Promise<void> {
  const key = `${KV_READ_PREFIX}${email}`;
  // Keep only last 1000 read IDs to prevent unbounded growth
  const idsArray = Array.from(readIds).slice(-1000);
  await kv.put(key, JSON.stringify(idsArray), { expirationTtl: READ_STATE_TTL });
}

async function invalidateCountCache(kv: KVNamespace, email: string): Promise<void> {
  const key = `${KV_COUNT_PREFIX}${email}`;
  await kv.delete(key);
}

// =============================================================================
// API HANDLERS
// =============================================================================

async function handleListNotifications(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const email = getUserEmail(request);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 100);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  const project = url.searchParams.get('project');
  const source = url.searchParams.get('source');
  const category = url.searchParams.get('category');

  // Build query
  let query = 'SELECT * FROM notifications WHERE (expires_at IS NULL OR expires_at > unixepoch())';
  const params: (string | number)[] = [];

  if (project) {
    query += ' AND project = ?';
    params.push(project);
  }
  if (source) {
    query += ' AND source = ?';
    params.push(source);
  }
  if (category) {
    query += ' AND category = ?';
    params.push(category);
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const result = await env.PLATFORM_DB.prepare(query).bind(...params).all<Notification>();
  const notifications = result.results || [];

  // Get read state and mark notifications
  const readIds = await getReadState(env.PLATFORM_CACHE, email);
  const enrichedNotifications = notifications.map((n) => ({
    ...n,
    is_read: readIds.has(n.id),
  }));

  return Response.json({
    notifications: enrichedNotifications,
    count: notifications.length,
    offset,
    limit,
  });
}

async function handleUnreadCount(request: Request, env: Env): Promise<Response> {
  const email = getUserEmail(request);

  // Check cache first
  const cacheKey = `${KV_COUNT_PREFIX}${email}`;
  const cached = await env.PLATFORM_CACHE.get(cacheKey);
  if (cached) {
    return Response.json({ count: parseInt(cached, 10) });
  }

  // Get all notification IDs from last 30 days
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
  const result = await env.PLATFORM_DB.prepare(
    `SELECT id FROM notifications
     WHERE created_at > ?
     AND (expires_at IS NULL OR expires_at > unixepoch())
     ORDER BY created_at DESC
     LIMIT 1000`
  )
    .bind(thirtyDaysAgo)
    .all<{ id: string }>();

  const allIds = new Set((result.results || []).map((r) => r.id));
  const readIds = await getReadState(env.PLATFORM_CACHE, email);

  // Count unread
  let unreadCount = 0;
  for (const id of allIds) {
    if (!readIds.has(id)) {
      unreadCount++;
    }
  }

  // Cache the count
  await env.PLATFORM_CACHE.put(cacheKey, String(unreadCount), {
    expirationTtl: COUNT_CACHE_TTL,
  });

  return Response.json({ count: unreadCount });
}

async function handleMarkRead(
  request: Request,
  env: Env,
  notificationId: string
): Promise<Response> {
  const email = getUserEmail(request);
  const readIds = await getReadState(env.PLATFORM_CACHE, email);
  readIds.add(notificationId);
  await setReadState(env.PLATFORM_CACHE, email, readIds);
  await invalidateCountCache(env.PLATFORM_CACHE, email);
  return Response.json({ success: true, id: notificationId });
}

async function handleMarkAllRead(request: Request, env: Env): Promise<Response> {
  const email = getUserEmail(request);

  // Get all notification IDs
  const result = await env.PLATFORM_DB.prepare(
    `SELECT id FROM notifications
     WHERE (expires_at IS NULL OR expires_at > unixepoch())
     ORDER BY created_at DESC
     LIMIT 1000`
  ).all<{ id: string }>();

  const allIds = new Set((result.results || []).map((r) => r.id));
  await setReadState(env.PLATFORM_CACHE, email, allIds);
  await invalidateCountCache(env.PLATFORM_CACHE, email);

  return Response.json({ success: true, marked_count: allIds.size });
}

async function handleCreateNotification(
  request: Request,
  env: Env
): Promise<Response> {
  const body = (await request.json()) as CreateNotificationRequest;

  if (!body.category || !body.source || !body.title) {
    return Response.json(
      { error: 'Missing required fields: category, source, title' },
      { status: 400 }
    );
  }

  const id = generateId();
  const now = Math.floor(Date.now() / 1000);

  await env.PLATFORM_DB.prepare(
    `INSERT INTO notifications (id, category, source, source_id, title, description, priority, action_url, action_label, project, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      body.category,
      body.source,
      body.source_id || null,
      body.title,
      body.description || null,
      body.priority || 'info',
      body.action_url || null,
      body.action_label || null,
      body.project || null,
      now,
      body.expires_at || null
    )
    .run();

  return Response.json({ success: true, id }, { status: 201 });
}

async function handleGetPreferences(request: Request, env: Env): Promise<Response> {
  const email = getUserEmail(request);
  const key = `${KV_PREFS_PREFIX}${email}`;
  const data = await env.PLATFORM_CACHE.get(key);

  const defaults: NotificationPreferences = {
    email_enabled: true,
    slack_enabled: true,
    in_app_enabled: true,
    digest_frequency: 'daily',
    muted_sources: [],
  };

  if (!data) {
    return Response.json(defaults);
  }

  try {
    const prefs = JSON.parse(data) as Partial<NotificationPreferences>;
    return Response.json({ ...defaults, ...prefs });
  } catch {
    return Response.json(defaults);
  }
}

async function handleUpdatePreferences(
  request: Request,
  env: Env
): Promise<Response> {
  const email = getUserEmail(request);
  const body = (await request.json()) as Partial<NotificationPreferences>;
  const key = `${KV_PREFS_PREFIX}${email}`;

  // Merge with existing preferences
  const existing = await env.PLATFORM_CACHE.get(key);
  const current = existing ? JSON.parse(existing) : {};
  const updated = { ...current, ...body };

  await env.PLATFORM_CACHE.put(key, JSON.stringify(updated));

  return Response.json({ success: true, preferences: updated });
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

    // Health check (lightweight, no SDK overhead)
    if (url.pathname === '/health') {
      return Response.json({
        status: 'ok',
        service: 'platform-notifications',
        timestamp: new Date().toISOString(),
      });
    }

    const log = createLoggerFromRequest(request, env, 'platform-notifications', FEATURE_ID);

    try {
      // Wrap with feature budget tracking
      const trackedEnv = withFeatureBudget(env, FEATURE_ID, { ctx });

      // GET /notifications - List notifications
      if (url.pathname === '/notifications' && request.method === 'GET') {
        return await handleListNotifications(request, trackedEnv, url);
      }

      // GET /notifications/unread-count - Get unread count for badge
      if (url.pathname === '/notifications/unread-count' && request.method === 'GET') {
        return await handleUnreadCount(request, trackedEnv);
      }

      // POST /notifications/:id/read - Mark single as read
      const readMatch = url.pathname.match(/^\/notifications\/([^/]+)\/read$/);
      if (readMatch && request.method === 'POST') {
        return await handleMarkRead(request, trackedEnv, readMatch[1]);
      }

      // POST /notifications/read-all - Mark all as read
      if (url.pathname === '/notifications/read-all' && request.method === 'POST') {
        return await handleMarkAllRead(request, trackedEnv);
      }

      // POST /notifications - Create notification (internal use)
      if (url.pathname === '/notifications' && request.method === 'POST') {
        return await handleCreateNotification(request, trackedEnv);
      }

      // GET /notifications/preferences - Get user preferences
      if (url.pathname === '/notifications/preferences' && request.method === 'GET') {
        return await handleGetPreferences(request, trackedEnv);
      }

      // PUT /notifications/preferences - Update user preferences
      if (url.pathname === '/notifications/preferences' && request.method === 'PUT') {
        return await handleUpdatePreferences(request, trackedEnv);
      }

      // API index
      return Response.json({
        service: 'platform-notifications',
        version: '1.0.0',
        endpoints: [
          'GET  /health - Health check',
          'GET  /notifications - List notifications (with filters)',
          'GET  /notifications/unread-count - Get unread count',
          'POST /notifications/:id/read - Mark as read',
          'POST /notifications/read-all - Mark all as read',
          'POST /notifications - Create notification (internal)',
          'GET  /notifications/preferences - Get user preferences',
          'PUT  /notifications/preferences - Update preferences',
        ],
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
