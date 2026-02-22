/**
 * DLQ Admin Handlers
 *
 * Admin endpoints for managing Dead Letter Queue messages.
 * Provides visibility into failed messages and replay capability.
 */

import type { Env, TelemetryMessage } from '../shared';
import { createLoggerFromEnv } from '@littlebearapps/platform-sdk';
import { jsonResponse, generateId } from '../shared';

// =============================================================================
// TYPES
// =============================================================================

interface DLQMessage {
  id: string;
  feature_key: string;
  project: string;
  category: string | null;
  feature: string | null;
  error_message: string | null;
  error_category: string | null;
  error_fingerprint: string | null;
  retry_count: number;
  correlation_id: string | null;
  status: string;
  created_at: number;
  replayed_at: number | null;
}

interface DLQListResponse {
  success: boolean;
  messages: DLQMessage[];
  total: number;
  pending: number;
  replayed: number;
  discarded: number;
  timestamp: string;
}

interface DLQStatsResponse {
  success: boolean;
  stats: {
    total: number;
    pending: number;
    replayed: number;
    discarded: number;
    byProject: Record<string, number>;
    byErrorCategory: Record<string, number>;
    oldestPending: string | null;
  };
  timestamp: string;
}

// =============================================================================
// LIST DLQ MESSAGES
// =============================================================================

/**
 * List DLQ messages with optional filtering.
 * GET /admin/dlq?status=pending&project=my-app&limit=50
 */
export async function handleListDLQ(url: URL, env: Env): Promise<Response> {
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:dlq-admin');

  const status = url.searchParams.get('status') || 'pending';
  const project = url.searchParams.get('project');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  try {
    // Build query with filters
    let query = `SELECT id, feature_key, project, category, feature, error_message,
                        error_category, error_fingerprint, retry_count, correlation_id,
                        status, created_at, replayed_at
                 FROM dead_letter_queue WHERE 1=1`;
    const params: (string | number)[] = [];

    if (status !== 'all') {
      query += ` AND status = ?`;
      params.push(status);
    }

    if (project) {
      query += ` AND project = ?`;
      params.push(project);
    }

    query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const result = await env.PLATFORM_DB.prepare(query)
      .bind(...params)
      .all<DLQMessage>();

    // Get counts
    const counts = await env.PLATFORM_DB.prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'replayed' THEN 1 ELSE 0 END) as replayed,
        SUM(CASE WHEN status = 'discarded' THEN 1 ELSE 0 END) as discarded
       FROM dead_letter_queue`
    ).first<{ total: number; pending: number; replayed: number; discarded: number }>();

    const response: DLQListResponse = {
      success: true,
      messages: result.results || [],
      total: counts?.total || 0,
      pending: counts?.pending || 0,
      replayed: counts?.replayed || 0,
      discarded: counts?.discarded || 0,
      timestamp: new Date().toISOString(),
    };

    log.info('DLQ list retrieved', { count: response.messages.length, status });
    return jsonResponse(response);
  } catch (error) {
    log.error('Failed to list DLQ messages', error);
    return jsonResponse({ success: false, error: 'Failed to list DLQ messages' }, 500);
  }
}

// =============================================================================
// GET DLQ STATS
// =============================================================================

/**
 * Get DLQ statistics for monitoring.
 * GET /admin/dlq/stats
 */
export async function handleDLQStats(env: Env): Promise<Response> {
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:dlq-admin');

  try {
    // Get overall counts
    const counts = await env.PLATFORM_DB.prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'replayed' THEN 1 ELSE 0 END) as replayed,
        SUM(CASE WHEN status = 'discarded' THEN 1 ELSE 0 END) as discarded
       FROM dead_letter_queue`
    ).first<{ total: number; pending: number; replayed: number; discarded: number }>();

    // Get counts by project
    const byProject = await env.PLATFORM_DB.prepare(
      `SELECT project, COUNT(*) as count FROM dead_letter_queue
       WHERE status = 'pending' GROUP BY project`
    ).all<{ project: string; count: number }>();

    // Get counts by error category
    const byCategory = await env.PLATFORM_DB.prepare(
      `SELECT error_category, COUNT(*) as count FROM dead_letter_queue
       WHERE status = 'pending' GROUP BY error_category`
    ).all<{ error_category: string | null; count: number }>();

    // Get oldest pending message
    const oldest = await env.PLATFORM_DB.prepare(
      `SELECT created_at FROM dead_letter_queue
       WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`
    ).first<{ created_at: number }>();

    const projectMap: Record<string, number> = {};
    for (const row of byProject.results || []) {
      projectMap[row.project] = row.count;
    }

    const categoryMap: Record<string, number> = {};
    for (const row of byCategory.results || []) {
      categoryMap[row.error_category || 'unknown'] = row.count;
    }

    const response: DLQStatsResponse = {
      success: true,
      stats: {
        total: counts?.total || 0,
        pending: counts?.pending || 0,
        replayed: counts?.replayed || 0,
        discarded: counts?.discarded || 0,
        byProject: projectMap,
        byErrorCategory: categoryMap,
        oldestPending: oldest ? new Date(oldest.created_at * 1000).toISOString() : null,
      },
      timestamp: new Date().toISOString(),
    };

    return jsonResponse(response);
  } catch (error) {
    log.error('Failed to get DLQ stats', error);
    return jsonResponse({ success: false, error: 'Failed to get DLQ stats' }, 500);
  }
}

// =============================================================================
// REPLAY DLQ MESSAGE
// =============================================================================

/**
 * Replay a DLQ message by re-queuing it.
 * POST /admin/dlq/:id/replay
 */
export async function handleReplayDLQ(messageId: string, env: Env): Promise<Response> {
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:dlq-admin');

  try {
    // Get the message
    const message = await env.PLATFORM_DB.prepare(
      `SELECT id, message_payload, status FROM dead_letter_queue WHERE id = ?`
    )
      .bind(messageId)
      .first<{ id: string; message_payload: string; status: string }>();

    if (!message) {
      return jsonResponse({ success: false, error: 'Message not found' }, 404);
    }

    if (message.status !== 'pending') {
      return jsonResponse(
        { success: false, error: `Message is not pending (status: ${message.status})` },
        400
      );
    }

    // Parse the payload
    const telemetry: TelemetryMessage = JSON.parse(message.message_payload);

    // Re-queue the message
    await env.PLATFORM_TELEMETRY.send(telemetry);

    // Update the DLQ record
    await env.PLATFORM_DB.prepare(
      `UPDATE dead_letter_queue
       SET status = 'replayed', replayed_at = unixepoch(), replayed_by = 'admin', updated_at = unixepoch()
       WHERE id = ?`
    )
      .bind(messageId)
      .run();

    log.info('DLQ message replayed', {
      messageId,
      feature_key: telemetry.feature_key,
    });

    return jsonResponse({
      success: true,
      message: 'Message replayed successfully',
      messageId,
      feature_key: telemetry.feature_key,
    });
  } catch (error) {
    log.error('Failed to replay DLQ message', error, { messageId });
    return jsonResponse({ success: false, error: 'Failed to replay message' }, 500);
  }
}

// =============================================================================
// DISCARD DLQ MESSAGE
// =============================================================================

/**
 * Discard a DLQ message (mark as not needing replay).
 * POST /admin/dlq/:id/discard
 */
export async function handleDiscardDLQ(
  messageId: string,
  reason: string,
  env: Env
): Promise<Response> {
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:dlq-admin');

  try {
    // Update the DLQ record
    const result = await env.PLATFORM_DB.prepare(
      `UPDATE dead_letter_queue
       SET status = 'discarded', discard_reason = ?, updated_at = unixepoch()
       WHERE id = ? AND status = 'pending'`
    )
      .bind(reason || 'Manually discarded by admin', messageId)
      .run();

    if (result.meta.changes === 0) {
      return jsonResponse({ success: false, error: 'Message not found or not pending' }, 404);
    }

    log.info('DLQ message discarded', { messageId, reason });

    return jsonResponse({
      success: true,
      message: 'Message discarded successfully',
      messageId,
    });
  } catch (error) {
    log.error('Failed to discard DLQ message', error, { messageId });
    return jsonResponse({ success: false, error: 'Failed to discard message' }, 500);
  }
}

// =============================================================================
// BULK OPERATIONS
// =============================================================================

/**
 * Replay all pending DLQ messages (with optional filter).
 * POST /admin/dlq/replay-all?project=my-app
 */
export async function handleReplayAllDLQ(url: URL, env: Env): Promise<Response> {
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:dlq-admin');
  const project = url.searchParams.get('project');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);

  try {
    // Get pending messages
    let query = `SELECT id, message_payload FROM dead_letter_queue WHERE status = 'pending'`;
    const params: (string | number)[] = [];

    if (project) {
      query += ` AND project = ?`;
      params.push(project);
    }

    query += ` LIMIT ?`;
    params.push(limit);

    const messages = await env.PLATFORM_DB.prepare(query)
      .bind(...params)
      .all<{ id: string; message_payload: string }>();

    let replayed = 0;
    let failed = 0;

    for (const msg of messages.results || []) {
      try {
        const telemetry: TelemetryMessage = JSON.parse(msg.message_payload);
        await env.PLATFORM_TELEMETRY.send(telemetry);

        await env.PLATFORM_DB.prepare(
          `UPDATE dead_letter_queue
           SET status = 'replayed', replayed_at = unixepoch(), replayed_by = 'admin-bulk', updated_at = unixepoch()
           WHERE id = ?`
        )
          .bind(msg.id)
          .run();

        replayed++;
      } catch {
        failed++;
      }
    }

    log.info('Bulk DLQ replay complete', { replayed, failed, project });

    return jsonResponse({
      success: true,
      replayed,
      failed,
      total: (messages.results || []).length,
    });
  } catch (error) {
    log.error('Failed to replay all DLQ messages', error);
    return jsonResponse({ success: false, error: 'Failed to replay messages' }, 500);
  }
}
