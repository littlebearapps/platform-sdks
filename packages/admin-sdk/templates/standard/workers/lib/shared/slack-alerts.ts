/**
 * Unified Slack Alerts Module
 *
 * Provides a single interface for:
 * - Sending Slack alerts with consistent formatting
 * - Creating in-app notifications (D1)
 * - KV-based deduplication (1-hour window)
 *
 * Usage:
 * ```ts
 * import { sendAlert, sendAlertWithNotification } from './lib/shared/slack-alerts';
 *
 * // Just Slack
 * await sendAlert(env, {
 *   source: 'circuit-breaker',
 *   priority: 'critical',
 *   title: 'Circuit Breaker Tripped',
 *   message: 'Feature brand-copilot:scanner exceeded budget',
 *   project: 'brand-copilot',
 * });
 *
 * // Slack + In-app notification
 * await sendAlertWithNotification(env, {
 *   source: 'error-collector',
 *   priority: 'high',
 *   title: 'New P1 Error Detected',
 *   message: 'TypeError in my-project:worker',
 *   project: 'my-project',
 *   actionUrl: '/errors',
 *   actionLabel: 'View Errors',
 * });
 * ```
 *
 * @module workers/lib/shared/slack-alerts
 */

import type { KVNamespace, D1Database } from '@cloudflare/workers-types';

// TODO: Set your dashboard URL
const DASHBOARD_URL = 'https://your-dashboard.example.com';

// =============================================================================
// TYPES
// =============================================================================

export type AlertSource =
  | 'error-collector'
  | 'pattern-discovery'
  | 'circuit-breaker'
  | 'usage'
  | 'gap-detection'
  | 'gatus'
  | 'system'
  | 'sentinel';

export type AlertPriority = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type NotificationCategory = 'error' | 'warning' | 'info' | 'success';

export interface SlackAlert {
  source: AlertSource;
  priority: AlertPriority;
  title: string;
  message: string;
  project?: string;
  context?: Record<string, string | number | boolean>;
  actionUrl?: string;
  actionLabel?: string;
  /** Additional Slack blocks to include */
  additionalBlocks?: Array<Record<string, unknown>>;
  /** Skip deduplication for this alert */
  skipDedup?: boolean;
}

export interface AlertEnv {
  SLACK_WEBHOOK_URL?: string;
  PLATFORM_CACHE?: KVNamespace;
  PLATFORM_DB?: D1Database;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const DEDUPE_TTL = 3600; // 1 hour in seconds
const DEDUPE_PREFIX = 'SLACK_ALERT:';

/** Priority to Slack colour mapping */
const PRIORITY_COLOURS: Record<AlertPriority, string> = {
  critical: '#d32f2f', // Red
  high: '#ff9800', // Orange
  medium: '#ffc107', // Yellow
  low: '#2196f3', // Blue
  info: '#36a64f', // Green
};

/** Priority to emoji mapping */
const PRIORITY_EMOJI: Record<AlertPriority, string> = {
  critical: '🚨',
  high: '⚠️',
  medium: '📢',
  low: 'ℹ️',
  info: '✅',
};

/** Source to human-readable label */
const SOURCE_LABELS: Record<AlertSource, string> = {
  'error-collector': 'Error Collector',
  'pattern-discovery': 'Pattern Discovery',
  'circuit-breaker': 'Circuit Breaker',
  usage: 'Usage Monitor',
  'gap-detection': 'Gap Detection',
  gatus: 'Gatus',
  system: 'System',
  sentinel: 'Platform Sentinel',
};

/** Map priority to notification category */
const PRIORITY_TO_CATEGORY: Record<AlertPriority, NotificationCategory> = {
  critical: 'error',
  high: 'error',
  medium: 'warning',
  low: 'info',
  info: 'success',
};

// =============================================================================
// DEDUPLICATION
// =============================================================================

/**
 * Generate a deduplication key from alert content
 */
function generateDedupeKey(alert: SlackAlert): string {
  const content = `${alert.source}:${alert.priority}:${alert.title}:${alert.project || 'all'}`;
  // Simple hash for deduplication
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return `${DEDUPE_PREFIX}${Math.abs(hash).toString(36)}`;
}

/**
 * Check if alert was recently sent (within dedupe window)
 */
async function isDuplicate(kv: KVNamespace | undefined, alert: SlackAlert): Promise<boolean> {
  if (!kv || alert.skipDedup) return false;

  const key = generateDedupeKey(alert);
  const existing = await kv.get(key);
  return existing !== null;
}

/**
 * Mark alert as sent for deduplication
 */
async function markSent(kv: KVNamespace | undefined, alert: SlackAlert): Promise<void> {
  if (!kv || alert.skipDedup) return;

  const key = generateDedupeKey(alert);
  await kv.put(key, new Date().toISOString(), { expirationTtl: DEDUPE_TTL });
}

// =============================================================================
// SLACK MESSAGE BUILDING
// =============================================================================

/**
 * Build Slack message payload
 */
function buildSlackMessage(alert: SlackAlert): Record<string, unknown> {
  const emoji = PRIORITY_EMOJI[alert.priority];
  const colour = PRIORITY_COLOURS[alert.priority];
  const sourceLabel = SOURCE_LABELS[alert.source] || alert.source;
  const priorityLabel = alert.priority.toUpperCase();

  // Build header
  const headerText = `${emoji} [${priorityLabel}] ${alert.title}`;

  // Build context fields
  const contextFields: Array<{ type: string; text: string }> = [];

  if (alert.project) {
    contextFields.push({
      type: 'mrkdwn',
      text: `*Project:* ${alert.project}`,
    });
  }

  contextFields.push({
    type: 'mrkdwn',
    text: `*Source:* ${sourceLabel}`,
  });

  contextFields.push({
    type: 'mrkdwn',
    text: `*Time:* ${new Date().toISOString()}`,
  });

  // Build additional context if provided
  if (alert.context) {
    for (const [key, value] of Object.entries(alert.context)) {
      contextFields.push({
        type: 'mrkdwn',
        text: `*${key}:* ${value}`,
      });
    }
  }

  // Build blocks
  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: headerText,
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: alert.message,
      },
    },
    {
      type: 'section',
      fields: contextFields.slice(0, 10), // Slack limit
    },
  ];

  // Add action buttons if URL provided
  if (alert.actionUrl) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: alert.actionLabel || 'View Details',
            emoji: true,
          },
          url: alert.actionUrl,
          action_id: 'view_details',
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: '📊 Dashboard',
            emoji: true,
          },
          url: `${DASHBOARD_URL}/dashboard`,
          action_id: 'open_dashboard',
        },
      ],
    });
  }

  // Add any additional blocks
  if (alert.additionalBlocks) {
    blocks.push(...alert.additionalBlocks);
  }

  return {
    text: headerText, // Fallback for notifications
    blocks,
    attachments: [
      {
        color: colour,
        footer: `Platform Alerts | ${sourceLabel}`,
        ts: Math.floor(Date.now() / 1000),
      },
    ],
  };
}

// =============================================================================
// NOTIFICATION CREATION
// =============================================================================

/**
 * Generate notification ID
 */
function generateNotificationId(): string {
  return `notif_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Create in-app notification in D1
 */
async function createNotification(
  db: D1Database | undefined,
  alert: SlackAlert
): Promise<string | null> {
  if (!db) return null;

  const id = generateNotificationId();
  const now = Math.floor(Date.now() / 1000);
  const category = PRIORITY_TO_CATEGORY[alert.priority];

  try {
    await db
      .prepare(
        `INSERT INTO notifications (id, category, source, source_id, title, description, priority, action_url, action_label, project, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        category,
        alert.source,
        null, // source_id - could be extended for linking
        alert.title,
        alert.message,
        alert.priority,
        alert.actionUrl || null,
        alert.actionLabel || null,
        alert.project || null,
        now,
        null // no expiry by default
      )
      .run();

    return id;
  } catch (error) {
    console.error('[slack-alerts] Failed to create notification:', error);
    return null;
  }
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Send Slack alert only (no in-app notification)
 *
 * @param env Environment with SLACK_WEBHOOK_URL and optionally PLATFORM_CACHE for dedup
 * @param alert Alert details
 * @returns true if sent, false if deduplicated or failed
 */
export async function sendAlert(env: AlertEnv, alert: SlackAlert): Promise<boolean> {
  // Check deduplication
  if (await isDuplicate(env.PLATFORM_CACHE, alert)) {
    console.log('[slack-alerts] Alert deduplicated:', alert.title);
    return false;
  }

  // Check webhook URL
  if (!env.SLACK_WEBHOOK_URL) {
    console.warn('[slack-alerts] SLACK_WEBHOOK_URL not configured, skipping Slack');
    return false;
  }

  // Build and send message
  const message = buildSlackMessage(alert);

  try {
    const response = await fetch(env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      console.error('[slack-alerts] Slack webhook failed:', response.status);
      return false;
    }

    // Mark as sent for deduplication
    await markSent(env.PLATFORM_CACHE, alert);

    return true;
  } catch (error) {
    console.error('[slack-alerts] Failed to send Slack alert:', error);
    return false;
  }
}

/**
 * Send Slack alert AND create in-app notification
 *
 * Creates notification FIRST (so it's available even if Slack fails),
 * then sends Slack alert.
 *
 * @param env Environment with SLACK_WEBHOOK_URL, PLATFORM_CACHE, PLATFORM_DB
 * @param alert Alert details
 * @returns Object with notification ID and Slack success status
 */
export async function sendAlertWithNotification(
  env: AlertEnv,
  alert: SlackAlert
): Promise<{ notificationId: string | null; slackSent: boolean }> {
  // Check deduplication first
  if (await isDuplicate(env.PLATFORM_CACHE, alert)) {
    console.log('[slack-alerts] Alert deduplicated:', alert.title);
    return { notificationId: null, slackSent: false };
  }

  // Create notification first (more reliable than Slack)
  const notificationId = await createNotification(env.PLATFORM_DB, alert);

  // Then try Slack (graceful degradation)
  let slackSent = false;

  if (env.SLACK_WEBHOOK_URL) {
    const message = buildSlackMessage(alert);

    try {
      const response = await fetch(env.SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      });

      slackSent = response.ok;

      if (!response.ok) {
        console.error('[slack-alerts] Slack webhook failed:', response.status);
      }
    } catch (error) {
      console.error('[slack-alerts] Failed to send Slack alert:', error);
    }
  }

  // Mark as sent for deduplication (even if just notification was created)
  if (notificationId || slackSent) {
    await markSent(env.PLATFORM_CACHE, alert);
  }

  return { notificationId, slackSent };
}

/**
 * Create notification only (no Slack)
 *
 * Useful for lower-priority alerts that don't need Slack.
 *
 * @param env Environment with PLATFORM_DB
 * @param alert Alert details
 * @returns Notification ID or null if failed
 */
export async function createNotificationOnly(
  env: AlertEnv,
  alert: SlackAlert
): Promise<string | null> {
  return createNotification(env.PLATFORM_DB, alert);
}

// =============================================================================
// CONVENIENCE FUNCTIONS
// =============================================================================

/**
 * Send a critical circuit breaker alert
 */
export async function sendCircuitBreakerAlert(
  env: AlertEnv,
  options: {
    featureKey: string;
    project: string;
    budgetLimit: number;
    currentUsage: number;
    reason: 'tripped' | 'warning' | 'recovered';
  }
): Promise<{ notificationId: string | null; slackSent: boolean }> {
  const { featureKey, project, budgetLimit, currentUsage, reason } = options;

  const priority: AlertPriority = reason === 'tripped' ? 'critical' : reason === 'warning' ? 'high' : 'info';
  const title =
    reason === 'tripped'
      ? `Circuit Breaker Tripped: ${featureKey}`
      : reason === 'warning'
        ? `Budget Warning (80%): ${featureKey}`
        : `Circuit Breaker Recovered: ${featureKey}`;

  const message =
    reason === 'recovered'
      ? `Feature \`${featureKey}\` has recovered and is now operational.`
      : `Feature \`${featureKey}\` is at ${((currentUsage / budgetLimit) * 100).toFixed(1)}% of budget.\n\n*Budget:* ${budgetLimit}\n*Current Usage:* ${currentUsage}`;

  return sendAlertWithNotification(env, {
    source: 'circuit-breaker',
    priority,
    title,
    message,
    project,
    context: {
      'Feature Key': featureKey,
      'Budget Limit': budgetLimit,
      'Current Usage': currentUsage,
      'Usage %': `${((currentUsage / budgetLimit) * 100).toFixed(1)}%`,
    },
    actionUrl: `${DASHBOARD_URL}/circuit-breakers`,
    actionLabel: 'View Circuit Breakers',
  });
}

/**
 * Send a gap detection alert
 */
export async function sendGapAlert(
  env: AlertEnv,
  options: {
    project: string;
    coveragePercent: number;
    missingResources: string[];
    repoPath?: string;
  }
): Promise<{ notificationId: string | null; slackSent: boolean }> {
  const { project, coveragePercent, missingResources, repoPath } = options;

  const title = `Coverage Gap Detected: ${project}`;
  const message =
    `Project \`${project}\` has ${coveragePercent.toFixed(1)}% coverage (target: 90%).\n\n` +
    `*Missing Resources:*\n${missingResources.slice(0, 5).map((r) => `• ${r}`).join('\n')}` +
    (missingResources.length > 5 ? `\n_...and ${missingResources.length - 5} more_` : '');

  return sendAlertWithNotification(env, {
    source: 'gap-detection',
    priority: 'medium',
    title,
    message,
    project,
    context: {
      Coverage: `${coveragePercent.toFixed(1)}%`,
      'Missing Count': missingResources.length,
      ...(repoPath ? { Repository: repoPath } : {}),
    },
    actionUrl: `${DASHBOARD_URL}/reports/gap-detection`,
    actionLabel: 'View Gap Report',
  });
}

/**
 * Send a cost threshold alert
 */
export async function sendCostAlert(
  env: AlertEnv,
  options: {
    project: string;
    currentCost: number;
    threshold: number;
    period: 'daily' | 'weekly' | 'monthly';
    costBreakdown?: Record<string, number>;
  }
): Promise<{ notificationId: string | null; slackSent: boolean }> {
  const { project, currentCost, threshold, period, costBreakdown } = options;

  const priority: AlertPriority = currentCost > threshold * 1.5 ? 'critical' : 'high';
  const title = `Cost ${priority === 'critical' ? 'Spike' : 'Warning'}: ${project}`;

  let message = `${period.charAt(0).toUpperCase() + period.slice(1)} cost for \`${project}\` is $${currentCost.toFixed(2)} (threshold: $${threshold.toFixed(2)}).`;

  if (costBreakdown && Object.keys(costBreakdown).length > 0) {
    message +=
      '\n\n*Cost Breakdown:*\n' +
      Object.entries(costBreakdown)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([resource, cost]) => `• ${resource}: $${cost.toFixed(2)}`)
        .join('\n');
  }

  return sendAlertWithNotification(env, {
    source: 'sentinel',
    priority,
    title,
    message,
    project,
    context: {
      'Current Cost': `$${currentCost.toFixed(2)}`,
      Threshold: `$${threshold.toFixed(2)}`,
      Period: period,
      'Over By': `${(((currentCost - threshold) / threshold) * 100).toFixed(1)}%`,
    },
    actionUrl: `${DASHBOARD_URL}/costs`,
    actionLabel: 'View Costs',
  });
}
