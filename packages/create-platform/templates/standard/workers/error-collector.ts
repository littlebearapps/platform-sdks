/**
 * Error Collector Tail Worker
 *
 * Captures errors from Cloudflare Workers across your projects and creates
 * AI-agent-ready GitHub issues for investigation.
 *
 * @see docs/plans/2026-01-28-error-collector-tail-worker-design.md
 */

import type {
  TailEvent,
  Env,
  ScriptMapping,
  ErrorType,
  ErrorStatus,
  GitHubIssueType,
} from './lib/error-collector/types';
import {
  shouldCapture,
  calculatePriority,
  getLabels,
  formatErrorTitle,
  extractCoreMessage,
  normalizeUrl,
} from './lib/error-collector/capture';
import {
  computeFingerprint,
  generateId,
  normalizeDynamicValues,
  isTransientError,
  classifyError,
  classifyErrorWithSource,
  loadDynamicPatterns,
  type FingerprintResult,
  type CompiledPattern,
} from './lib/error-collector/fingerprint';
import { GitHubClient } from './lib/error-collector/github';
import { processWarningDigests, storeWarningForDigest } from './lib/error-collector/digest';
import { processGapAlert } from './lib/error-collector/gap-alerts';
import { processEmailHealthAlerts } from './lib/error-collector/email-health-alerts';
import { recordPatternMatchEvidence } from './lib/pattern-discovery/storage';
import type { GapAlertEvent, EmailHealthAlertEvent } from './lib/error-collector/types';
import { pingHeartbeat } from '@littlebearapps/platform-sdk';

// TODO: Set your GitHub organisation name
const GITHUB_ORG = 'your-github-org';

// Rate limit: max issues per script per hour
const MAX_ISSUES_PER_SCRIPT_PER_HOUR = 10;

/**
 * Map error type to GitHub issue type
 * - Exceptions, CPU/memory limits, soft errors → Bug
 * - Warnings → Task
 */
function getGitHubIssueType(errorType: ErrorType): GitHubIssueType {
  if (errorType === 'warning') {
    return 'Task';
  }
  return 'Bug';
}

/**
 * Look up script mapping from KV
 */
async function getScriptMapping(
  kv: KVNamespace,
  scriptName: string
): Promise<ScriptMapping | null> {
  const key = `SCRIPT_MAP:${scriptName}`;
  const value = await kv.get(key);

  if (!value) return null;

  try {
    return JSON.parse(value) as ScriptMapping;
  } catch {
    console.error(`Invalid script mapping for ${scriptName}`);
    return null;
  }
}

/**
 * Check and update rate limit
 * Returns true if within limits, false if rate limited
 */
async function checkRateLimit(kv: KVNamespace, scriptName: string): Promise<boolean> {
  const hour = Math.floor(Date.now() / (1000 * 60 * 60));
  const key = `ERROR_RATE:${scriptName}:${hour}`;

  const current = await kv.get(key);
  const count = current ? parseInt(current, 10) : 0;

  if (count >= MAX_ISSUES_PER_SCRIPT_PER_HOUR) {
    return false;
  }

  await kv.put(key, String(count + 1), { expirationTtl: 7200 }); // 2 hour TTL
  return true;
}

/**
 * Get today's date key in YYYY-MM-DD format (UTC)
 */
function getDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Check if a transient error already has an issue created today.
 * For transient errors (quota exhaustion, rate limits, etc.), we only
 * create one issue per 24-hour window to avoid noise.
 *
 * Returns the existing issue number if one exists, null otherwise.
 */
async function checkTransientErrorWindow(
  kv: KVNamespace,
  scriptName: string,
  category: string
): Promise<number | null> {
  const windowKey = `TRANSIENT:${scriptName}:${category}:${getDateKey()}`;
  const existing = await kv.get(windowKey);
  return existing ? parseInt(existing, 10) : null;
}

/**
 * Record that a transient error issue was created for today's window.
 */
async function setTransientErrorWindow(
  kv: KVNamespace,
  scriptName: string,
  category: string,
  issueNumber: number
): Promise<void> {
  const windowKey = `TRANSIENT:${scriptName}:${category}:${getDateKey()}`;
  // TTL of 25 hours to cover the full day plus buffer
  await kv.put(windowKey, String(issueNumber), { expirationTtl: 90000 });
}

/**
 * Check if an issue is muted via the cf:muted label.
 * Muted issues should not be reopened or receive comments.
 */
async function isIssueMuted(
  github: GitHubClient,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<boolean> {
  try {
    const issue = await github.getIssue(owner, repo, issueNumber);
    return (
      issue.labels?.some(
        (l: { name: string } | string) => (typeof l === 'string' ? l : l.name) === 'cf:muted'
      ) ?? false
    );
  } catch {
    // If we can't check, assume not muted
    return false;
  }
}

/** Labels that prevent issue reopening */
const SKIP_REOPEN_LABELS = ['cf:muted', 'cf:wont-fix'];

/**
 * Acquire an optimistic lock for issue creation.
 * Prevents race conditions where concurrent workers create duplicate issues.
 *
 * @returns true if lock acquired, false if another worker holds it
 */
async function acquireIssueLock(kv: KVNamespace, fingerprint: string): Promise<boolean> {
  const lockKey = `ISSUE_LOCK:${fingerprint}`;
  const existing = await kv.get(lockKey);

  if (existing) {
    // Another worker is creating an issue for this fingerprint
    return false;
  }

  // Set lock with 60s TTL (enough time for GitHub API calls)
  await kv.put(lockKey, Date.now().toString(), { expirationTtl: 60 });
  return true;
}

/**
 * Release the issue creation lock.
 */
async function releaseIssueLock(kv: KVNamespace, fingerprint: string): Promise<void> {
  const lockKey = `ISSUE_LOCK:${fingerprint}`;
  await kv.delete(lockKey);
}

/**
 * Create a dashboard notification for P0-P2 errors.
 * Non-blocking - failures are logged but don't affect issue creation.
 */
async function createDashboardNotification(
  api: Fetcher | undefined,
  priority: string, // 'P0', 'P1', 'P2', etc.
  errorType: ErrorType,
  scriptName: string,
  message: string,
  issueNumber: number,
  issueUrl: string,
  project: string
): Promise<void> {
  // Extract numeric priority from string like 'P0', 'P1', etc.
  const priorityNum = parseInt(priority.replace('P', ''), 10);

  // Only create notifications for P0-P2 errors
  if (priorityNum > 2 || isNaN(priorityNum) || !api) return;

  const priorityMap: Record<number, 'critical' | 'high' | 'medium'> = {
    0: 'critical',
    1: 'high',
    2: 'medium',
  };

  try {
    await api.fetch('https://platform-notifications.internal/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'error',
        source: 'error-collector',
        source_id: String(issueNumber),
        title: `${priority} ${errorType}: ${scriptName}`,
        description: message.slice(0, 200),
        priority: priorityMap[priorityNum],
        action_url: issueUrl,
        action_label: 'View Issue',
        project: project || null,
      }),
    });
  } catch (e) {
    // Non-blocking - log and continue
    console.error('Failed to create dashboard notification:', e);
  }
}

/**
 * Search GitHub for an existing issue with this fingerprint.
 * Used as a fallback when D1/KV don't have the mapping.
 *
 * @returns Issue details if found, null otherwise
 */
async function findExistingIssueByFingerprint(
  github: GitHubClient,
  owner: string,
  repo: string,
  fingerprint: string
): Promise<{
  number: number;
  state: 'open' | 'closed';
  shouldSkip: boolean; // true if muted/wontfix
} | null> {
  try {
    // Search for issues containing this fingerprint in the body
    // The fingerprint appears as "Fingerprint: `{hash}`" in the issue body
    const issues = await github.searchIssues(owner, repo, `"Fingerprint: \`${fingerprint}\`" in:body`);

    if (issues.length === 0) return null;

    // Prefer open issues over closed
    const openIssue = issues.find((i) => i.state === 'open');
    if (openIssue) {
      const labelNames = openIssue.labels.map((l) => l.name);
      const shouldSkip = SKIP_REOPEN_LABELS.some((l) => labelNames.includes(l));
      return { number: openIssue.number, state: 'open', shouldSkip };
    }

    // Return most recent closed issue (search results are sorted by best match)
    const closedIssue = issues[0];
    const labelNames = closedIssue.labels.map((l) => l.name);
    const shouldSkip = SKIP_REOPEN_LABELS.some((l) => labelNames.includes(l));

    return {
      number: closedIssue.number,
      state: closedIssue.state as 'open' | 'closed',
      shouldSkip,
    };
  } catch (error) {
    // Fail open - if search fails, allow creating a new issue
    console.error(`GitHub search failed for fingerprint ${fingerprint}:`, error);
    return null;
  }
}

/**
 * Format a comment for when an error recurs and we're adding to an existing issue
 */
function formatRecurrenceComment(
  event: TailEvent,
  errorType: ErrorType,
  occurrenceCount: number,
  isReopen: boolean
): string {
  const timestamp = new Date().toISOString();
  const rayId = event.event?.rayId || event.event?.request?.headers?.['cf-ray'];

  let comment = isReopen ? `## Error Recurrence (Reopened)\n\n` : `## New Occurrence\n\n`;

  comment += `| | |\n|---|---|\n`;
  comment += `| **Time** | ${timestamp} |\n`;
  comment += `| **Total Occurrences** | ${occurrenceCount} |\n`;
  comment += `| **Worker** | \`${event.scriptName}\` |\n`;

  if (event.scriptVersion?.id) {
    comment += `| **Version** | \`${event.scriptVersion.id.slice(0, 8)}\` |\n`;
  }
  if (rayId) {
    comment += `| **Ray ID** | \`${rayId}\` |\n`;
  }
  if (event.event?.request?.cf?.colo) {
    comment += `| **Colo** | ${event.event.request.cf.colo} |\n`;
  }

  // Include stack trace snippet for exceptions
  if (errorType === 'exception' && event.exceptions.length > 0) {
    const exc = event.exceptions[0];
    const stackPreview = exc.message?.slice(0, 300) || 'N/A';
    comment += `\n### Exception\n\`\`\`\n${exc.name}: ${stackPreview}${exc.message?.length > 300 ? '...' : ''}\n\`\`\`\n`;
  }

  if (isReopen) {
    comment += `\n> This issue was reopened because the error recurred after being closed.\n`;
  }

  return comment;
}

/**
 * Get or create error occurrence record
 */
async function getOrCreateOccurrence(
  db: D1Database,
  kv: KVNamespace,
  fingerprint: string,
  scriptName: string,
  project: string,
  errorType: ErrorType,
  priority: string,
  repo: string
): Promise<{
  isNew: boolean;
  occurrence: {
    id: string;
    occurrence_count: number;
    github_issue_number?: number;
    github_issue_url?: string;
    status: ErrorStatus;
  };
}> {
  // Check KV cache first for existing fingerprint
  const kvKey = `ERROR_FINGERPRINT:${fingerprint}`;
  const cached = await kv.get(kvKey);

  if (cached) {
    const data = JSON.parse(cached) as {
      issueNumber?: number;
      issueUrl?: string;
      status: ErrorStatus;
      occurrenceCount: number;
    };

    // Update occurrence count in D1
    await db
      .prepare(
        `
      UPDATE error_occurrences
      SET occurrence_count = occurrence_count + 1,
          last_seen_at = unixepoch(),
          updated_at = unixepoch()
      WHERE fingerprint = ?
    `
      )
      .bind(fingerprint)
      .run();

    // Update KV cache
    await kv.put(
      kvKey,
      JSON.stringify({
        ...data,
        occurrenceCount: data.occurrenceCount + 1,
        lastSeen: Date.now(),
      }),
      { expirationTtl: 90 * 24 * 60 * 60 }
    ); // 90 days

    return {
      isNew: false,
      occurrence: {
        id: fingerprint,
        occurrence_count: data.occurrenceCount + 1,
        github_issue_number: data.issueNumber,
        github_issue_url: data.issueUrl,
        status: data.status,
      },
    };
  }

  // Check D1 for existing occurrence
  const existing = await db
    .prepare(
      `
    SELECT id, occurrence_count, github_issue_number, github_issue_url, status
    FROM error_occurrences
    WHERE fingerprint = ?
  `
    )
    .bind(fingerprint)
    .first<{
      id: string;
      occurrence_count: number;
      github_issue_number?: number;
      github_issue_url?: string;
      status: ErrorStatus;
    }>();

  if (existing) {
    // Update occurrence count
    await db
      .prepare(
        `
      UPDATE error_occurrences
      SET occurrence_count = occurrence_count + 1,
          last_seen_at = unixepoch(),
          updated_at = unixepoch()
      WHERE fingerprint = ?
    `
      )
      .bind(fingerprint)
      .run();

    // Cache in KV
    await kv.put(
      kvKey,
      JSON.stringify({
        issueNumber: existing.github_issue_number,
        issueUrl: existing.github_issue_url,
        status: existing.status,
        occurrenceCount: existing.occurrence_count + 1,
        lastSeen: Date.now(),
      }),
      { expirationTtl: 90 * 24 * 60 * 60 }
    );

    return {
      isNew: false,
      occurrence: {
        ...existing,
        occurrence_count: existing.occurrence_count + 1,
      },
    };
  }

  // Create new occurrence with ON CONFLICT to handle race conditions
  // If another concurrent request already created this fingerprint, just update it
  const id = generateId();
  const now = Math.floor(Date.now() / 1000);

  const result = await db
    .prepare(
      `
    INSERT INTO error_occurrences (
      id, fingerprint, script_name, project, error_type, priority,
      github_repo, status, first_seen_at, last_seen_at, occurrence_count,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, 1, ?, ?)
    ON CONFLICT(fingerprint) DO UPDATE SET
      occurrence_count = occurrence_count + 1,
      last_seen_at = excluded.last_seen_at,
      updated_at = excluded.updated_at
    RETURNING id, occurrence_count, github_issue_number, github_issue_url, status
  `
    )
    .bind(id, fingerprint, scriptName, project, errorType, priority, repo, now, now, now, now)
    .first<{
      id: string;
      occurrence_count: number;
      github_issue_number?: number;
      github_issue_url?: string;
      status: ErrorStatus;
    }>();

  // Check if this was an insert (count=1) or update (count>1)
  const isNew = result?.occurrence_count === 1;

  // Cache in KV
  await kv.put(
    kvKey,
    JSON.stringify({
      issueNumber: result?.github_issue_number,
      issueUrl: result?.github_issue_url,
      status: result?.status || ('open' as ErrorStatus),
      occurrenceCount: result?.occurrence_count || 1,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
    }),
    { expirationTtl: 90 * 24 * 60 * 60 }
  );

  return {
    isNew,
    occurrence: {
      id: result?.id || id,
      occurrence_count: result?.occurrence_count || 1,
      github_issue_number: result?.github_issue_number,
      github_issue_url: result?.github_issue_url,
      status: result?.status || ('open' as ErrorStatus),
    },
  };
}

/**
 * Update occurrence with GitHub issue details
 */
async function updateOccurrenceWithIssue(
  db: D1Database,
  kv: KVNamespace,
  fingerprint: string,
  issueNumber: number,
  issueUrl: string
): Promise<void> {
  await db
    .prepare(
      `
    UPDATE error_occurrences
    SET github_issue_number = ?,
        github_issue_url = ?,
        updated_at = unixepoch()
    WHERE fingerprint = ?
  `
    )
    .bind(issueNumber, issueUrl, fingerprint)
    .run();

  // Update KV cache
  const kvKey = `ERROR_FINGERPRINT:${fingerprint}`;
  const cached = await kv.get(kvKey);
  if (cached) {
    const data = JSON.parse(cached);
    await kv.put(
      kvKey,
      JSON.stringify({
        ...data,
        issueNumber,
        issueUrl,
      }),
      { expirationTtl: 90 * 24 * 60 * 60 }
    );
  }
}

/**
 * Extract a normalized message for pattern discovery.
 * Prioritizes: exception message > error logs > warning logs
 * This ensures pattern-discovery can cluster errors even without exceptions.
 */
function extractNormalizedMessage(event: TailEvent): string | null {
  // Priority 1: Exception message
  if (event.exceptions[0]?.message) {
    return extractCoreMessage(event.exceptions[0].message);
  }

  // Priority 2: Error-level logs
  const errorLog = event.logs.find((l) => l.level === 'error');
  if (errorLog) {
    return extractCoreMessage(errorLog.message[0]);
  }

  // Priority 3: Warning-level logs
  const warnLog = event.logs.find((l) => l.level === 'warn');
  if (warnLog) {
    return extractCoreMessage(warnLog.message[0]);
  }

  return null;
}

/**
 * Update occurrence with request context
 */
async function updateOccurrenceContext(
  db: D1Database,
  fingerprint: string,
  event: TailEvent
): Promise<void> {
  const url = event.event?.request?.url;
  const method = event.event?.request?.method;
  const colo = event.event?.request?.cf?.colo;
  const country = event.event?.request?.cf?.country;
  const cfRay = event.event?.request?.headers?.['cf-ray'];
  const excName = event.exceptions[0]?.name;
  const logsJson = JSON.stringify(event.logs.slice(-20));

  // Extract normalized message for pattern discovery (works for all error types)
  const normalizedMessage = extractNormalizedMessage(event);

  // Use exception message if available, otherwise fall back to normalizedMessage.
  // Soft errors (console.error) have no exceptions[] but DO have error logs —
  // without this fallback, last_exception_message stays NULL and errors are
  // invisible to pattern matching and GitHub issue diagnostics.
  const excMessage = event.exceptions[0]?.message || normalizedMessage;

  await db
    .prepare(
      `
    UPDATE error_occurrences
    SET last_request_url = ?,
        last_request_method = ?,
        last_colo = ?,
        last_country = ?,
        last_cf_ray = ?,
        last_exception_name = ?,
        last_exception_message = ?,
        last_logs_json = ?,
        normalized_message = COALESCE(?, normalized_message),
        updated_at = unixepoch()
    WHERE fingerprint = ?
  `
    )
    .bind(
      url || null,
      method || null,
      colo || null,
      country || null,
      cfRay || null,
      excName || null,
      excMessage || null,
      logsJson,
      normalizedMessage,
      fingerprint
    )
    .run();
}

/**
 * Format the GitHub issue body with AI-agent-ready context
 * Includes comprehensive observability data for debugging
 */
function formatIssueBody(
  event: TailEvent,
  errorType: ErrorType,
  priority: string,
  mapping: ScriptMapping,
  fingerprint: string,
  occurrenceCount: number
): string {
  const now = new Date().toISOString();
  const eventTime = new Date(event.eventTimestamp).toISOString();
  const exc = event.exceptions[0];
  const req = event.event?.request;
  const rayId = event.event?.rayId || req?.headers?.['cf-ray'];

  let body = `## `;

  // Header based on error type - extract clean message from JSON
  if (errorType === 'exception') {
    body += `🔴 Exception: ${exc?.name || 'Unknown'}: ${exc?.message || 'No message'}\n\n`;
  } else if (errorType === 'cpu_limit') {
    body += `🟠 Exceeded CPU Limit\n\n`;
  } else if (errorType === 'memory_limit') {
    body += `🟠 Exceeded Memory Limit\n\n`;
  } else if (errorType === 'soft_error') {
    const errorLog = event.logs.find((l) => l.level === 'error');
    const cleanMsg = errorLog ? extractCoreMessage(errorLog.message[0]) : 'Unknown';
    body += `🟡 Soft Error: ${cleanMsg}\n\n`;
  } else {
    const warnLog = event.logs.find((l) => l.level === 'warn');
    const cleanMsg = warnLog ? extractCoreMessage(warnLog.message[0]) : 'Unknown';
    body += `⚪ Warning: ${cleanMsg}\n\n`;
  }

  // Summary table for quick context
  body += `| | |\n|---|---|\n`;
  body += `| **Project** | ${mapping.displayName} |\n`;
  body += `| **Worker** | \`${event.scriptName}\` |\n`;
  body += `| **Priority** | ${priority} |\n`;
  body += `| **Tier** | ${mapping.tier} |\n`;
  body += `| **Event Type** | ${event.eventType || 'fetch'} |\n`;
  if (event.scriptVersion?.id) {
    body += `| **Version** | \`${event.scriptVersion.id.slice(0, 8)}\` |\n`;
  }
  body += `| **Outcome** | ${event.outcome} |\n\n`;

  // Exception details - unescape newlines for readable stack traces
  if (exc) {
    const message = exc.message.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    body += `### Exception\n\`\`\`\n${exc.name}: ${message}\n\`\`\`\n\n`;
  }

  // Event context based on type
  if (req) {
    // HTTP Request context
    body += `### Request Context\n`;
    body += `| Field | Value |\n`;
    body += `|-------|-------|\n`;
    body += `| **URL** | \`${req.method} ${req.url}\` |\n`;
    if (event.event?.response?.status) {
      body += `| **Response** | ${event.event.response.status} |\n`;
    }
    if (rayId) body += `| **Ray ID** | \`${rayId}\` |\n`;
    if (req.cf?.colo) body += `| **Colo** | ${req.cf.colo} |\n`;
    if (req.cf?.country) {
      const geo = [req.cf.country, req.cf.city, req.cf.region].filter(Boolean).join(', ');
      body += `| **Location** | ${geo} |\n`;
    }
    if (req.cf?.asOrganization)
      body += `| **Network** | ${req.cf.asOrganization} (AS${req.cf.asn}) |\n`;
    if (req.cf?.timezone) body += `| **Timezone** | ${req.cf.timezone} |\n`;
    if (req.headers?.['user-agent']) {
      const ua = req.headers['user-agent'].slice(0, 80);
      body += `| **User Agent** | \`${ua}${req.headers['user-agent'].length > 80 ? '...' : ''}\` |\n`;
    }
    body += `| **Timestamp** | ${eventTime} |\n\n`;
  } else if (event.event?.scheduledTime || event.event?.cron) {
    // Scheduled/Cron context
    body += `### Scheduled Event Context\n`;
    body += `| Field | Value |\n`;
    body += `|-------|-------|\n`;
    if (event.event.cron) body += `| **Cron** | \`${event.event.cron}\` |\n`;
    if (event.event.scheduledTime) {
      body += `| **Scheduled** | ${new Date(event.event.scheduledTime).toISOString()} |\n`;
    }
    body += `| **Executed** | ${eventTime} |\n\n`;
  } else if (event.event?.queue) {
    // Queue context
    body += `### Queue Event Context\n`;
    body += `| Field | Value |\n`;
    body += `|-------|-------|\n`;
    body += `| **Queue** | ${event.event.queue} |\n`;
    if (event.event.batchSize) body += `| **Batch Size** | ${event.event.batchSize} |\n`;
    body += `| **Timestamp** | ${eventTime} |\n\n`;
  }

  // Performance metrics
  body += `### Performance\n`;
  body += `| Metric | Value |\n`;
  body += `|--------|-------|\n`;
  if (event.cpuTime !== undefined) body += `| **CPU Time** | ${event.cpuTime}ms |\n`;
  if (event.wallTime !== undefined) body += `| **Wall Time** | ${event.wallTime}ms |\n`;
  body += `| **Execution** | ${event.executionModel || 'stateless'} |\n\n`;

  // Categorize logs by level
  const errorLogs = event.logs.filter((l) => l.level === 'error' || l.level === 'warn');
  const debugLogs = event.logs.filter((l) => l.level === 'debug');
  const infoLogs = event.logs.filter((l) => l.level === 'info' || l.level === 'log');
  const allLogs = event.logs;

  // Show error/warning logs prominently
  if (errorLogs.length > 0) {
    body += `### Error/Warning Logs\n`;
    for (const log of errorLogs.slice(-5)) {
      const rawMsg = log.message
        .map((m) => (typeof m === 'string' ? m : JSON.stringify(m, null, 2)))
        .join(' ');
      body += `\`\`\`\n[${log.level.toUpperCase()}] ${rawMsg}\n\`\`\`\n`;
    }
  }

  // Debug context section - shows debug logs that provide investigation context
  if (debugLogs.length > 0) {
    body += `### 🔍 Debug Context\n`;
    body += `> Debug logs from the same invocation - may contain useful investigation context\n\n`;
    for (const log of debugLogs.slice(-10)) {
      const ts = new Date(log.timestamp).toISOString().split('T')[1].slice(0, 12);
      const rawMsg = log.message
        .map((m) => (typeof m === 'string' ? m : JSON.stringify(m, null, 2)))
        .join(' ')
        .slice(0, 500);
      body += `**${ts}**:\n\`\`\`\n${rawMsg}\n\`\`\`\n`;
    }
    if (debugLogs.length > 10) {
      body += `_...and ${debugLogs.length - 10} more debug entries_\n`;
    }
    body += `\n`;
  }

  // Full log timeline in collapsible section
  if (allLogs.length > 0) {
    body += `<details>\n<summary>📋 Full Log Timeline (${allLogs.length} entries)</summary>\n\n`;
    body += `| Time | Level | Message |\n`;
    body += `|------|-------|--------|\n`;
    for (const log of allLogs.slice(-30)) {
      const ts = new Date(log.timestamp).toISOString().split('T')[1].slice(0, 12);
      const msg = log.message
        .map((m) => (typeof m === 'string' ? m : JSON.stringify(m)))
        .join(' ')
        .slice(0, 150)
        .replace(/\|/g, '\\|')
        .replace(/\n/g, ' ');
      body += `| ${ts} | ${log.level.toUpperCase()} | ${msg}${log.message.join(' ').length > 150 ? '...' : ''} |\n`;
    }
    if (allLogs.length > 30) {
      body += `| ... | ... | _(${allLogs.length - 30} more entries)_ |\n`;
    }
    body += `\n</details>\n\n`;
  }

  // Tracking metadata
  body += `### Tracking\n`;
  body += `| Field | Value |\n`;
  body += `|-------|-------|\n`;
  body += `| **Fingerprint** | \`${fingerprint}\` |\n`;
  body += `| **First Seen** | ${now} |\n`;
  body += `| **Occurrences** | ${occurrenceCount} |\n\n`;

  // Quick links with observability deep link
  body += `### Quick Links\n`;

  // Observability link with Ray ID filter if available
  if (rayId) {
    body += `- 🔍 [View in CF Observability](https://dash.cloudflare.com/?to=/:account/workers/observability/logs?filters=%5B%7B%22key%22%3A%22%24metadata.requestId%22%2C%22operation%22%3A%22eq%22%2C%22value%22%3A%22${rayId}%22%7D%5D) ← **Start here**\n`;
  } else {
    body += `- 🔍 [CF Observability](https://dash.cloudflare.com/?to=/:account/workers/observability)\n`;
  }

  body += `- 📄 [Worker Source](https://github.com/${mapping.repository}/blob/main/workers/${event.scriptName}.ts)\n`;
  body += `- 📊 [Worker Dashboard](https://dash.cloudflare.com/?to=/:account/workers/services/view/${event.scriptName})\n`;
  body += `- 📁 [Repository](https://github.com/${mapping.repository})\n`;
  body += `- 📖 [CLAUDE.md](https://github.com/${mapping.repository}/blob/main/CLAUDE.md)\n`;
  body += `- 🔗 [Related Issues](https://github.com/${mapping.repository}/issues?q=is:issue+label:cf:error+${encodeURIComponent(event.scriptName)})\n\n`;

  // Suggested investigation with more specific guidance
  body += `### Investigation Steps\n`;
  if (errorType === 'exception') {
    body += `1. **Click the Observability link above** to see the full request trace\n`;
    body += `2. Check the exception and logs for error context\n`;
    body += `3. Open [Worker Source](https://github.com/${mapping.repository}/blob/main/workers/${event.scriptName}.ts) and find the failing code\n`;
    body += `4. Review recent commits: \`git log --oneline -10 workers/${event.scriptName}.ts\`\n`;
  } else if (errorType === 'cpu_limit' || errorType === 'memory_limit') {
    body += `1. **Check Observability** for CPU/memory usage patterns\n`;
    body += `2. Review [Worker Source](https://github.com/${mapping.repository}/blob/main/workers/${event.scriptName}.ts) for loops or heavy computation\n`;
    body += `3. Look for recent changes that increased resource usage\n`;
    body += `4. Consider optimizing, caching, or chunking work\n`;
  } else {
    body += `1. Review the logs above for context\n`;
    body += `2. Search for the log message in [Worker Source](https://github.com/${mapping.repository}/blob/main/workers/${event.scriptName}.ts)\n`;
    body += `3. Determine if this is expected or needs fixing\n`;
    body += `4. Consider adding error handling or validation\n`;
  }

  // Reference documentation for Claude Code agents
  body += `\n### Reference Documentation\n`;
  body += `- 📚 [Error Collector Integration](https://github.com/${GITHUB_ORG}/platform/blob/main/docs/quickrefs/guides/error-collector-integration.md)\n`;
  body += `- 📚 [Troubleshooting Guide](https://github.com/${GITHUB_ORG}/platform/blob/main/docs/quickrefs/troubleshooting.md)\n`;
  body += `- 📚 [Workers Inventory](https://github.com/${GITHUB_ORG}/platform/blob/main/docs/quickrefs/workers-inventory.md)\n`;

  body += `\n---\n`;
  body += `_Auto-generated by [Platform Error Collector](https://github.com/${GITHUB_ORG}/platform/blob/main/workers/error-collector.ts)_ | Fingerprint: \`${fingerprint}\`\n`;

  return body;
}

/**
 * Compute fingerprint for a specific error log (for multi-error processing)
 * Returns FingerprintResult with category for transient error detection
 */
async function computeFingerprintForLog(
  event: TailEvent,
  errorType: ErrorType,
  errorLog: { message: unknown[] },
  dynamicPatterns: CompiledPattern[] = []
): Promise<FingerprintResult> {
  const components: string[] = [event.scriptName, errorType];

  const coreMsg = extractCoreMessage(errorLog.message[0]);

  // Check for transient error classification first (static + dynamic patterns)
  const classification = classifyErrorWithSource(coreMsg, dynamicPatterns);
  let normalizedMessage: string;

  if (classification) {
    // Use stable category instead of variable message
    components.push(classification.category);
    normalizedMessage = normalizeDynamicValues(coreMsg).slice(0, 200);
  } else {
    // Standard message-based fingerprinting
    normalizedMessage = normalizeDynamicValues(coreMsg).slice(0, 100);
    components.push(normalizedMessage);
  }

  // Include normalized URL for HTTP errors (helps distinguish different endpoints)
  if (event.event?.request?.url) {
    components.push(normalizeUrl(event.event.request.url));
  }

  // Create hash
  const data = components.join(':');
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));

  const fingerprint = Array.from(new Uint8Array(hashBuffer))
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return {
    fingerprint,
    category: classification?.category ?? null,
    normalizedMessage,
    patternSource: classification?.source,
    dynamicPatternId: classification?.patternId,
  };
}

/**
 * Process a single soft error log from a tail event
 * Called for each unique error in an invocation with multiple errors
 */
async function processSoftErrorLog(
  event: TailEvent,
  env: Env,
  github: GitHubClient,
  mapping: ScriptMapping,
  errorLog: { level: string; message: unknown[]; timestamp: number },
  dynamicPatterns: CompiledPattern[] = []
): Promise<void> {
  const errorType: ErrorType = 'soft_error';

  // Check rate limit
  const withinLimits = await checkRateLimit(env.PLATFORM_CACHE, event.scriptName);
  if (!withinLimits) {
    const coreMsg = extractCoreMessage(errorLog.message[0]);
    console.log(`Rate limited for script: ${event.scriptName} (error: ${coreMsg.slice(0, 50)})`);
    return;
  }

  // Compute fingerprint for this specific error log (now returns FingerprintResult)
  const fingerprintResult = await computeFingerprintForLog(event, errorType, errorLog, dynamicPatterns);
  const { fingerprint, category, dynamicPatternId } = fingerprintResult;
  const isTransient = category !== null;

  // Log dynamic pattern matches for observability and record evidence
  if (dynamicPatternId) {
    console.log(`Dynamic pattern match (soft error): ${category} (pattern: ${dynamicPatternId})`);
    // Record match evidence for human review context
    await recordPatternMatchEvidence(env.PLATFORM_DB, {
      patternId: dynamicPatternId,
      scriptName: event.scriptName,
      project: mapping.project,
      errorFingerprint: fingerprint,
      normalizedMessage: fingerprintResult.normalizedMessage ?? undefined,
      errorType: 'soft_error',
      priority: calculatePriority(errorType, mapping.tier, 1),
    });
    // Increment match_count so shadow evaluation has accurate stats
    await env.PLATFORM_DB.prepare(
      `UPDATE transient_pattern_suggestions SET match_count = match_count + 1, last_matched_at = unixepoch() WHERE id = ?`
    ).bind(dynamicPatternId).run();
  }

  // For transient errors, check if we already have an issue for today's window
  if (isTransient && category) {
    const existingIssue = await checkTransientErrorWindow(
      env.PLATFORM_CACHE,
      event.scriptName,
      category
    );
    if (existingIssue) {
      // Just update occurrence count in D1, don't create new issue
      await env.PLATFORM_DB.prepare(
        `
        UPDATE error_occurrences
        SET occurrence_count = occurrence_count + 1,
            last_seen_at = unixepoch(),
            updated_at = unixepoch()
        WHERE fingerprint = ?
      `
      )
        .bind(fingerprint)
        .run();
      console.log(
        `Transient soft error (${category}) for ${event.scriptName} - issue #${existingIssue} exists for today`
      );
      return;
    }
  }

  // Get or create occurrence
  const { isNew, occurrence } = await getOrCreateOccurrence(
    env.PLATFORM_DB,
    env.PLATFORM_CACHE,
    fingerprint,
    event.scriptName,
    mapping.project,
    errorType,
    calculatePriority(errorType, mapping.tier, 1),
    mapping.repository
  );

  // Update context
  await updateOccurrenceContext(env.PLATFORM_DB, fingerprint, event);

  // Calculate priority with actual occurrence count
  const priority = calculatePriority(errorType, mapping.tier, occurrence.occurrence_count);

  // If this is a new error, create a GitHub issue (with dedup check)
  if (isNew) {
    try {
      const [owner, repo] = mapping.repository.split('/');

      // RACE CONDITION PREVENTION: Acquire lock before searching/creating
      const lockAcquired = await acquireIssueLock(env.PLATFORM_CACHE, fingerprint);
      if (!lockAcquired) {
        console.log(`Lock held by another worker for ${fingerprint}, skipping`);
        return;
      }

      try {
        // DEDUP CHECK: Search GitHub for existing issue with this fingerprint
        const existingIssue = await findExistingIssueByFingerprint(github, owner, repo, fingerprint);

        if (existingIssue) {
          // Check if issue is muted/wontfix - don't reopen or create new
          if (existingIssue.shouldSkip) {
            console.log(`Issue #${existingIssue.number} is muted/wontfix, skipping`);
            // Still link D1 record to prevent future searches
            await updateOccurrenceWithIssue(
              env.PLATFORM_DB,
              env.PLATFORM_CACHE,
              fingerprint,
              existingIssue.number,
              `https://github.com/${owner}/${repo}/issues/${existingIssue.number}`
            );
            return;
          }

          // Found existing issue - update it instead of creating new
          const comment = formatRecurrenceComment(
            event,
            errorType,
            occurrence.occurrence_count,
            existingIssue.state === 'closed'
          );

          if (existingIssue.state === 'closed') {
            // Reopen the issue
            await github.updateIssue({
              owner,
              repo,
              issue_number: existingIssue.number,
              state: 'open',
            });
            await github.addLabels(owner, repo, existingIssue.number, ['cf:regression']);
            console.log(`Reopened existing issue #${existingIssue.number} (dedup: ${fingerprint})`);
          }

          await github.addComment(owner, repo, existingIssue.number, comment);

          // Update D1 with the found issue number
          await updateOccurrenceWithIssue(
            env.PLATFORM_DB,
            env.PLATFORM_CACHE,
            fingerprint,
            existingIssue.number,
            `https://github.com/${owner}/${repo}/issues/${existingIssue.number}`
          );

          // For transient errors, record the issue in the window cache
          if (isTransient && category) {
            await setTransientErrorWindow(
              env.PLATFORM_CACHE,
              event.scriptName,
              category,
              existingIssue.number
            );
          }

          return; // Don't create a new issue
        }

        // No existing issue found - create new (original code)
        const coreMsg = extractCoreMessage(errorLog.message[0]);
        const title = `[${event.scriptName}] Error: ${coreMsg.slice(0, 60)}`.slice(0, 100);
        const body = formatIssueBody(
          event,
          errorType,
          priority,
          mapping,
          fingerprint,
          occurrence.occurrence_count
        );
        const labels = getLabels(errorType, priority);

        // Add transient label for transient errors
        if (isTransient) {
          labels.push('cf:transient');
        }

        const issue = await github.createIssue({
          owner,
          repo,
          title,
          body,
          labels,
          type: getGitHubIssueType(errorType),
          assignees: env.DEFAULT_ASSIGNEE ? [env.DEFAULT_ASSIGNEE] : [],
        });

        console.log(
          `Created issue #${issue.number} for ${event.scriptName} - ${coreMsg.slice(0, 30)}${isTransient ? ` (transient: ${category})` : ''}`
        );

        // Update occurrence with issue details
        await updateOccurrenceWithIssue(
          env.PLATFORM_DB,
          env.PLATFORM_CACHE,
          fingerprint,
          issue.number,
          issue.html_url
        );

        // For transient errors, record the issue in the window cache
        if (isTransient && category) {
          await setTransientErrorWindow(env.PLATFORM_CACHE, event.scriptName, category, issue.number);
        }

        // Add to project board
        try {
          const issueDetails = await github.getIssue(owner, repo, issue.number);
          await github.addToProject(issueDetails.node_id, env.GITHUB_PROJECT_ID);
        } catch (e) {
          console.error(`Failed to add to project board: ${e}`);
        }

        // Create dashboard notification for P0-P2 errors
        await createDashboardNotification(
          env.NOTIFICATIONS_API,
          priority,
          errorType,
          event.scriptName,
          coreMsg,
          issue.number,
          issue.html_url,
          mapping.project
        );
      } finally {
        // Always release lock
        await releaseIssueLock(env.PLATFORM_CACHE, fingerprint);
      }
    } catch (e) {
      console.error(`Failed to create GitHub issue: ${e}`);
    }
  } else if (occurrence.github_issue_number && occurrence.status === 'resolved') {
    // Error recurred after being resolved
    // Skip regression logic for transient errors - they're expected to recur
    if (isTransient) {
      console.log(
        `Transient soft error (${category}) recurred for ${event.scriptName} - not marking as regression`
      );
      // Just update to open status without regression label
      await env.PLATFORM_DB.prepare(
        `
        UPDATE error_occurrences
        SET status = 'open',
            resolved_at = NULL,
            resolved_by = NULL,
            updated_at = unixepoch()
        WHERE fingerprint = ?
      `
      )
        .bind(fingerprint)
        .run();
      return;
    }

    // Non-transient error: apply regression logic
    try {
      const [owner, repo] = mapping.repository.split('/');

      // Check if issue is muted - if so, don't reopen or comment
      const muted = await isIssueMuted(github, owner, repo, occurrence.github_issue_number);
      if (muted) {
        console.log(`Issue #${occurrence.github_issue_number} is muted, skipping reopen`);
        return;
      }

      await github.updateIssue({
        owner,
        repo,
        issue_number: occurrence.github_issue_number,
        state: 'open',
      });

      await github.addLabels(owner, repo, occurrence.github_issue_number, ['cf:regression']);

      await github.addComment(
        owner,
        repo,
        occurrence.github_issue_number,
        `⚠️ **Regression Detected**\n\nThis error has recurred after being marked as resolved.\n\n- **Occurrences**: ${occurrence.occurrence_count}\n- **Last Seen**: ${new Date().toISOString()}\n\nPlease investigate if the fix was incomplete.`
      );

      console.log(`Reopened issue #${occurrence.github_issue_number} as regression`);

      // Update status in D1
      await env.PLATFORM_DB.prepare(
        `
        UPDATE error_occurrences
        SET status = 'open',
            resolved_at = NULL,
            resolved_by = NULL,
            updated_at = unixepoch()
        WHERE fingerprint = ?
      `
      )
        .bind(fingerprint)
        .run();
    } catch (e) {
      console.error(`Failed to reopen issue: ${e}`);
    }
  } else if (occurrence.github_issue_number) {
    // Update existing issue with new occurrence count (every 10 occurrences)
    if (occurrence.occurrence_count % 10 === 0) {
      try {
        const [owner, repo] = mapping.repository.split('/');

        // Check if issue is muted - if so, don't add comments
        const muted = await isIssueMuted(github, owner, repo, occurrence.github_issue_number);
        if (muted) {
          console.log(`Issue #${occurrence.github_issue_number} is muted, skipping comment`);
          return;
        }

        await github.addComment(
          owner,
          repo,
          occurrence.github_issue_number,
          `📊 **Occurrence Update**\n\nThis error has now occurred **${occurrence.occurrence_count} times**.\n\n- **Last Seen**: ${new Date().toISOString()}\n- **Colo**: ${event.event?.request?.cf?.colo || 'unknown'}`
        );
        console.log(`Updated issue #${occurrence.github_issue_number} with occurrence count`);
      } catch (e) {
        console.error(`Failed to update issue: ${e}`);
      }
    }
  }
}

/**
 * Process a single tail event
 */
async function processEvent(
  event: TailEvent,
  env: Env,
  github: GitHubClient,
  dynamicPatterns: CompiledPattern[] = []
): Promise<void> {
  // Check if we should capture this event
  const decision = shouldCapture(event);
  if (!decision.capture || !decision.type) {
    return;
  }

  const errorType = decision.type;

  // Get script mapping
  const mapping = await getScriptMapping(env.PLATFORM_CACHE, event.scriptName);
  if (!mapping) {
    console.log(`No mapping found for script: ${event.scriptName}`);
    return;
  }

  // P4 warnings go to daily digest instead of immediate issues
  // Process ALL warning logs, not just the first one
  if (errorType === 'warning') {
    const warnLogs = event.logs.filter((l) => l.level === 'warn');
    const seenNormalizedMessages = new Set<string>();

    for (const warnLog of warnLogs) {
      const rawMessage = warnLog.message
        .map((m) => (typeof m === 'string' ? m : JSON.stringify(m)))
        .join(' ');
      const coreMessage = extractCoreMessage(warnLog.message[0]);
      const normalizedMessage = normalizeDynamicValues(coreMessage);

      // Dedupe warnings with identical normalized messages within same invocation
      if (seenNormalizedMessages.has(normalizedMessage)) {
        continue;
      }
      seenNormalizedMessages.add(normalizedMessage);

      const fingerprintResult = await computeFingerprintForLog(event, errorType, warnLog, dynamicPatterns);

      await storeWarningForDigest(
        env.PLATFORM_DB,
        env.PLATFORM_CACHE,
        fingerprintResult.fingerprint,
        event.scriptName,
        mapping.project,
        mapping.repository,
        normalizedMessage,
        rawMessage
      );

      console.log(
        `Stored warning for digest: ${event.scriptName} - ${normalizedMessage.slice(0, 50)}`
      );
    }
    return;
  }

  // For soft_error: Process ALL error logs, not just the first one
  // This fixes the bug where multiple console.error() calls in one invocation
  // only resulted in one GitHub issue (task-296)
  if (errorType === 'soft_error') {
    const errorLogs = event.logs.filter((l) => l.level === 'error');
    const seenNormalizedMessages = new Set<string>();

    for (const errorLog of errorLogs) {
      const coreMessage = extractCoreMessage(errorLog.message[0]);
      const normalizedMessage = normalizeDynamicValues(coreMessage);

      // Dedupe errors with identical normalized messages within same invocation
      // (e.g., same error logged twice in a loop)
      if (seenNormalizedMessages.has(normalizedMessage)) {
        continue;
      }
      seenNormalizedMessages.add(normalizedMessage);

      await processSoftErrorLog(event, env, github, mapping, errorLog, dynamicPatterns);
    }
    return;
  }

  // For exceptions and resource limits: use original single-error processing
  // Check rate limit (only for non-warning errors that create immediate issues)
  const withinLimits = await checkRateLimit(env.PLATFORM_CACHE, event.scriptName);
  if (!withinLimits) {
    console.log(`Rate limited for script: ${event.scriptName}`);
    return;
  }

  // Compute fingerprint (now returns FingerprintResult with category)
  // Pass dynamic patterns to enable AI-suggested pattern matching
  const fingerprintResult = await computeFingerprint(event, errorType, { dynamicPatterns });
  const { fingerprint, category, dynamicPatternId } = fingerprintResult;
  const isTransient = category !== null;

  // Log dynamic pattern matches for observability and record evidence
  if (dynamicPatternId) {
    console.log(`Dynamic pattern match: ${category} (pattern: ${dynamicPatternId})`);
    // Record match evidence for human review context
    await recordPatternMatchEvidence(env.PLATFORM_DB, {
      patternId: dynamicPatternId,
      scriptName: event.scriptName,
      project: mapping.project,
      errorFingerprint: fingerprint,
      normalizedMessage: fingerprintResult.normalizedMessage ?? undefined,
      errorType: errorType,
      priority: calculatePriority(errorType, mapping.tier, 1),
    });
    // Increment match_count so shadow evaluation has accurate stats
    await env.PLATFORM_DB.prepare(
      `UPDATE transient_pattern_suggestions SET match_count = match_count + 1, last_matched_at = unixepoch() WHERE id = ?`
    ).bind(dynamicPatternId).run();
  }

  // For transient errors, check if we already have an issue for today's window
  // This prevents noise from quota exhaustion errors that occur repeatedly
  if (isTransient && category) {
    const existingIssue = await checkTransientErrorWindow(
      env.PLATFORM_CACHE,
      event.scriptName,
      category
    );
    if (existingIssue) {
      // Just update occurrence count in D1, don't create new issue
      await env.PLATFORM_DB.prepare(
        `
        UPDATE error_occurrences
        SET occurrence_count = occurrence_count + 1,
            last_seen_at = unixepoch(),
            updated_at = unixepoch()
        WHERE fingerprint = ?
      `
      )
        .bind(fingerprint)
        .run();
      console.log(
        `Transient error (${category}) for ${event.scriptName} - issue #${existingIssue} exists for today`
      );
      return;
    }
  }

  // Get or create occurrence
  const { isNew, occurrence } = await getOrCreateOccurrence(
    env.PLATFORM_DB,
    env.PLATFORM_CACHE,
    fingerprint,
    event.scriptName,
    mapping.project,
    errorType,
    calculatePriority(errorType, mapping.tier, 1),
    mapping.repository
  );

  // Update context
  await updateOccurrenceContext(env.PLATFORM_DB, fingerprint, event);

  // Calculate priority with actual occurrence count
  const priority = calculatePriority(errorType, mapping.tier, occurrence.occurrence_count);

  // If this is a new error, create a GitHub issue (with dedup check)
  if (isNew) {
    try {
      const [owner, repo] = mapping.repository.split('/');

      // RACE CONDITION PREVENTION: Acquire lock before searching/creating
      const lockAcquired = await acquireIssueLock(env.PLATFORM_CACHE, fingerprint);
      if (!lockAcquired) {
        console.log(`Lock held by another worker for ${fingerprint}, skipping`);
        return;
      }

      try {
        // DEDUP CHECK: Search GitHub for existing issue with this fingerprint
        const existingIssue = await findExistingIssueByFingerprint(github, owner, repo, fingerprint);

        if (existingIssue) {
          // Check if issue is muted/wontfix - don't reopen or create new
          if (existingIssue.shouldSkip) {
            console.log(`Issue #${existingIssue.number} is muted/wontfix, skipping`);
            // Still link D1 record to prevent future searches
            await updateOccurrenceWithIssue(
              env.PLATFORM_DB,
              env.PLATFORM_CACHE,
              fingerprint,
              existingIssue.number,
              `https://github.com/${owner}/${repo}/issues/${existingIssue.number}`
            );
            return;
          }

          // Found existing issue - update it instead of creating new
          const comment = formatRecurrenceComment(
            event,
            errorType,
            occurrence.occurrence_count,
            existingIssue.state === 'closed'
          );

          if (existingIssue.state === 'closed') {
            // Reopen the issue
            await github.updateIssue({
              owner,
              repo,
              issue_number: existingIssue.number,
              state: 'open',
            });
            await github.addLabels(owner, repo, existingIssue.number, ['cf:regression']);
            console.log(`Reopened existing issue #${existingIssue.number} (dedup: ${fingerprint})`);
          }

          await github.addComment(owner, repo, existingIssue.number, comment);

          // Update D1 with the found issue number
          await updateOccurrenceWithIssue(
            env.PLATFORM_DB,
            env.PLATFORM_CACHE,
            fingerprint,
            existingIssue.number,
            `https://github.com/${owner}/${repo}/issues/${existingIssue.number}`
          );

          // For transient errors, record the issue in the window cache
          if (isTransient && category) {
            await setTransientErrorWindow(
              env.PLATFORM_CACHE,
              event.scriptName,
              category,
              existingIssue.number
            );
          }

          return; // Don't create a new issue
        }

        // No existing issue found - create new (original code)
        const title = formatErrorTitle(errorType, event, event.scriptName);
        const body = formatIssueBody(
          event,
          errorType,
          priority,
          mapping,
          fingerprint,
          occurrence.occurrence_count
        );
        const labels = getLabels(errorType, priority);

        // Add transient label for transient errors
        if (isTransient) {
          labels.push('cf:transient');
        }

        const issue = await github.createIssue({
          owner,
          repo,
          title,
          body,
          labels,
          type: getGitHubIssueType(errorType),
          assignees: env.DEFAULT_ASSIGNEE ? [env.DEFAULT_ASSIGNEE] : [],
        });

        console.log(
          `Created issue #${issue.number} for ${event.scriptName}${isTransient ? ` (transient: ${category})` : ''}`
        );

        // Update occurrence with issue details
        await updateOccurrenceWithIssue(
          env.PLATFORM_DB,
          env.PLATFORM_CACHE,
          fingerprint,
          issue.number,
          issue.html_url
        );

        // For transient errors, record the issue in the window cache
        if (isTransient && category) {
          await setTransientErrorWindow(env.PLATFORM_CACHE, event.scriptName, category, issue.number);
        }

        // Add to project board
        try {
          const issueDetails = await github.getIssue(owner, repo, issue.number);
          await github.addToProject(issueDetails.node_id, env.GITHUB_PROJECT_ID);
          console.log(`Added issue #${issue.number} to project board`);
        } catch (e) {
          console.error(`Failed to add to project board: ${e}`);
        }

        // Create dashboard notification for P0-P2 errors
        await createDashboardNotification(
          env.NOTIFICATIONS_API,
          priority,
          errorType,
          event.scriptName,
          title,
          issue.number,
          issue.html_url,
          mapping.project
        );
      } finally {
        // Always release lock
        await releaseIssueLock(env.PLATFORM_CACHE, fingerprint);
      }
    } catch (e) {
      console.error(`Failed to create GitHub issue: ${e}`);
    }
  } else if (occurrence.github_issue_number && occurrence.status === 'resolved') {
    // Error recurred after being resolved
    // Skip regression logic for transient errors - they're expected to recur
    if (isTransient) {
      console.log(
        `Transient error (${category}) recurred for ${event.scriptName} - not marking as regression`
      );
      // Just update to open status without regression label
      await env.PLATFORM_DB.prepare(
        `
        UPDATE error_occurrences
        SET status = 'open',
            resolved_at = NULL,
            resolved_by = NULL,
            updated_at = unixepoch()
        WHERE fingerprint = ?
      `
      )
        .bind(fingerprint)
        .run();
      return;
    }

    // Non-transient error: apply regression logic
    try {
      const [owner, repo] = mapping.repository.split('/');

      // Check if issue is muted - if so, don't reopen or comment
      const muted = await isIssueMuted(github, owner, repo, occurrence.github_issue_number);
      if (muted) {
        console.log(`Issue #${occurrence.github_issue_number} is muted, skipping reopen`);
        return;
      }

      await github.updateIssue({
        owner,
        repo,
        issue_number: occurrence.github_issue_number,
        state: 'open',
      });

      await github.addLabels(owner, repo, occurrence.github_issue_number, ['cf:regression']);

      await github.addComment(
        owner,
        repo,
        occurrence.github_issue_number,
        `⚠️ **Regression Detected**\n\nThis error has recurred after being marked as resolved.\n\n- **Occurrences**: ${occurrence.occurrence_count}\n- **Last Seen**: ${new Date().toISOString()}\n\nPlease investigate if the fix was incomplete.`
      );

      console.log(`Reopened issue #${occurrence.github_issue_number} as regression`);

      // Update status in D1
      await env.PLATFORM_DB.prepare(
        `
        UPDATE error_occurrences
        SET status = 'open',
            resolved_at = NULL,
            resolved_by = NULL,
            updated_at = unixepoch()
        WHERE fingerprint = ?
      `
      )
        .bind(fingerprint)
        .run();
    } catch (e) {
      console.error(`Failed to reopen issue: ${e}`);
    }
  } else if (occurrence.github_issue_number) {
    // Update existing issue with new occurrence count
    try {
      const [owner, repo] = mapping.repository.split('/');

      // Check if issue is muted - if so, don't add comments
      const muted = await isIssueMuted(github, owner, repo, occurrence.github_issue_number);
      if (muted) {
        console.log(`Issue #${occurrence.github_issue_number} is muted, skipping comment`);
        return;
      }

      // Add a comment every 10 occurrences to avoid spam
      if (occurrence.occurrence_count % 10 === 0) {
        await github.addComment(
          owner,
          repo,
          occurrence.github_issue_number,
          `📊 **Occurrence Update**\n\nThis error has now occurred **${occurrence.occurrence_count} times**.\n\n- **Last Seen**: ${new Date().toISOString()}\n- **Colo**: ${event.event?.request?.cf?.colo || 'unknown'}`
        );
        console.log(`Updated issue #${occurrence.github_issue_number} with occurrence count`);
      }
    } catch (e) {
      console.error(`Failed to update issue: ${e}`);
    }
  }
}

/**
 * Tail handler - receives events from producer workers
 */
async function tail(events: TailEvent[], env: Env): Promise<void> {
  const github = new GitHubClient(env);

  // Load dynamic patterns once for all events in this batch
  // These are AI-suggested, human-approved patterns from pattern-discovery
  const dynamicPatterns = await loadDynamicPatterns(env.PLATFORM_CACHE);
  if (dynamicPatterns.length > 0) {
    console.log(`Loaded ${dynamicPatterns.length} dynamic patterns from KV`);
  }

  for (const event of events) {
    try {
      await processEvent(event, env, github, dynamicPatterns);
    } catch (e) {
      console.error(`Error processing tail event: ${e}`);
    }
  }
}

/**
 * Scheduled handler - auto-close stale errors and process warning digests
 */
async function scheduled(
  event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const autoCloseSeconds = parseInt(env.AUTO_CLOSE_HOURS, 10) * 60 * 60;
  const warningCloseSeconds = parseInt(env.WARNING_AUTO_CLOSE_DAYS, 10) * 24 * 60 * 60;

  // At midnight UTC (0 0 * * *), process warning digests for the previous day
  const currentHour = new Date().getUTCHours();
  const currentMinute = new Date().getUTCMinutes();
  if (currentHour === 0 && currentMinute < 15) {
    console.log('Running daily warning digest processing...');
    try {
      const result = await processWarningDigests(env);
      console.log(
        `Digest complete: ${result.processed} warnings, ${result.issuesCreated} new issues, ${result.issuesUpdated} updated`
      );
      // Signal digest success to Gatus heartbeat
      pingHeartbeat(ctx, env.GATUS_HEARTBEAT_URL_DIGEST, env.GATUS_TOKEN, true);
    } catch (e) {
      console.error(`Failed to process warning digests: ${e}`);
      // Signal digest failure to Gatus heartbeat
      pingHeartbeat(ctx, env.GATUS_HEARTBEAT_URL_DIGEST, env.GATUS_TOKEN, false);
    }
  }

  // Find errors that haven't recurred in AUTO_CLOSE_HOURS
  const staleErrors = await env.PLATFORM_DB.prepare(
    `
    SELECT fingerprint, github_issue_number, github_repo, error_type
    FROM error_occurrences
    WHERE status = 'open'
      AND github_issue_number IS NOT NULL
      AND last_seen_at < ?
      AND (error_type != 'warning' OR last_seen_at < ?)
  `
  )
    .bind(now - autoCloseSeconds, now - warningCloseSeconds)
    .all<{
      fingerprint: string;
      github_issue_number: number;
      github_repo: string;
      error_type: string;
    }>();

  if (staleErrors.results?.length) {
    const github = new GitHubClient(env);

    for (const error of staleErrors.results) {
      try {
        const [owner, repo] = error.github_repo.split('/');

        await github.updateIssue({
          owner,
          repo,
          issue_number: error.github_issue_number,
          state: 'closed',
        });

        await github.addComment(
          owner,
          repo,
          error.github_issue_number,
          `✅ **Auto-closed**\n\nThis error has not recurred in ${env.AUTO_CLOSE_HOURS} hours and has been automatically closed.\n\nIf you know which commit fixed this, please link it here. If the error recurs, this issue will be automatically reopened.`
        );

        // Update status in D1
        await env.PLATFORM_DB.prepare(
          `
        UPDATE error_occurrences
        SET status = 'resolved',
            resolved_at = unixepoch(),
            resolved_by = 'auto-close',
            updated_at = unixepoch()
        WHERE fingerprint = ?
      `
        )
          .bind(error.fingerprint)
          .run();

        // Update KV cache
        const kvKey = `ERROR_FINGERPRINT:${error.fingerprint}`;
        const cached = await env.PLATFORM_CACHE.get(kvKey);
        if (cached) {
          const data = JSON.parse(cached);
          await env.PLATFORM_CACHE.put(
            kvKey,
            JSON.stringify({
              ...data,
              status: 'resolved',
            }),
            { expirationTtl: 90 * 24 * 60 * 60 }
          );
        }

        console.log(`Auto-closed issue #${error.github_issue_number}`);
      } catch (e) {
        console.error(`Failed to auto-close issue #${error.github_issue_number}: ${e}`);
      }
    }
  } else {
    console.log('No stale errors to auto-close');
  }

  // Signal scheduled run success to Gatus heartbeat (must always execute)
  pingHeartbeat(ctx, env.GATUS_HEARTBEAT_URL_15M, env.GATUS_TOKEN, true);
}

/**
 * Verify GitHub webhook signature
 */
async function verifyWebhookSignature(
  payload: string,
  signature: string | null,
  secret: string
): Promise<boolean> {
  if (!signature) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));

  const expectedSignature =
    'sha256=' +
    Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

  return signature === expectedSignature;
}

/**
 * Extract fingerprint from issue body
 */
function extractFingerprint(body: string): string | null {
  const match = body.match(/Fingerprint: `([a-f0-9]+)`/);
  return match ? match[1] : null;
}

/**
 * GitHub issue event payload
 */
interface GitHubIssueEvent {
  action: 'closed' | 'reopened' | 'labeled' | 'unlabeled' | 'opened' | 'edited';
  issue: {
    number: number;
    state: 'open' | 'closed';
    labels: Array<{ name: string }>;
    body: string | null;
    html_url: string;
  };
  repository: {
    full_name: string;
  };
  label?: {
    name: string;
  };
  sender: {
    login: string;
    type: 'User' | 'Bot';
  };
}

/**
 * Handle GitHub webhook for bidirectional sync
 */
async function handleGitHubWebhook(
  event: GitHubIssueEvent,
  env: Env
): Promise<{ processed: boolean; message: string }> {
  // Ignore events from our own bot
  if (event.sender.type === 'Bot' && event.sender.login.includes('error-collector')) {
    return { processed: false, message: 'Ignoring bot event' };
  }

  // Only process if issue has our auto-generated label
  const hasAutoLabel = event.issue.labels.some((l) => l.name === 'cf:error:auto-generated');
  if (!hasAutoLabel) {
    return { processed: false, message: 'Not an auto-generated error issue' };
  }

  // Extract fingerprint from issue body
  const fingerprint = extractFingerprint(event.issue.body || '');
  if (!fingerprint) {
    return { processed: false, message: 'Could not extract fingerprint' };
  }

  const repo = event.repository.full_name;

  if (event.action === 'closed') {
    // Issue was closed - mark as resolved
    await env.PLATFORM_DB.prepare(
      `
      UPDATE error_occurrences
      SET status = 'resolved',
          resolved_at = unixepoch(),
          resolved_by = ?,
          updated_at = unixepoch()
      WHERE fingerprint = ?
        AND github_repo = ?
    `
    )
      .bind(`github:${event.sender.login}`, fingerprint, repo)
      .run();

    // Update KV cache
    const kvKey = `ERROR_FINGERPRINT:${fingerprint}`;
    const cached = await env.PLATFORM_CACHE.get(kvKey);
    if (cached) {
      const data = JSON.parse(cached);
      await env.PLATFORM_CACHE.put(
        kvKey,
        JSON.stringify({
          ...data,
          status: 'resolved',
        }),
        { expirationTtl: 90 * 24 * 60 * 60 }
      );
    }

    console.log(`Marked ${fingerprint} as resolved via GitHub (closed by ${event.sender.login})`);
    return { processed: true, message: `Marked as resolved by ${event.sender.login}` };
  }

  if (event.action === 'reopened') {
    // Issue was reopened - clear resolved status
    await env.PLATFORM_DB.prepare(
      `
      UPDATE error_occurrences
      SET status = 'open',
          resolved_at = NULL,
          resolved_by = NULL,
          updated_at = unixepoch()
      WHERE fingerprint = ?
        AND github_repo = ?
    `
    )
      .bind(fingerprint, repo)
      .run();

    // Update KV cache
    const kvKey = `ERROR_FINGERPRINT:${fingerprint}`;
    const cached = await env.PLATFORM_CACHE.get(kvKey);
    if (cached) {
      const data = JSON.parse(cached);
      await env.PLATFORM_CACHE.put(
        kvKey,
        JSON.stringify({
          ...data,
          status: 'open',
        }),
        { expirationTtl: 90 * 24 * 60 * 60 }
      );
    }

    console.log(`Marked ${fingerprint} as open via GitHub (reopened by ${event.sender.login})`);
    return { processed: true, message: `Reopened by ${event.sender.login}` };
  }

  if (event.action === 'labeled' && event.label) {
    // Check for specific status-changing labels
    if (event.label.name === 'cf:wont-fix') {
      await env.PLATFORM_DB.prepare(
        `
        UPDATE error_occurrences
        SET status = 'wont_fix',
            resolved_at = unixepoch(),
            resolved_by = ?,
            updated_at = unixepoch()
        WHERE fingerprint = ?
          AND github_repo = ?
      `
      )
        .bind(`github:${event.sender.login}`, fingerprint, repo)
        .run();

      console.log(`Marked ${fingerprint} as won't fix`);
      return { processed: true, message: `Marked as won't fix` };
    }
  }

  return { processed: false, message: 'No action taken' };
}

// ============================================================================
// Dashboard API Handlers
// ============================================================================

/**
 * List errors with optional filtering
 */
async function handleListErrors(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const script = url.searchParams.get('script');
  const priority = url.searchParams.get('priority');
  const status = url.searchParams.get('status');
  const project = url.searchParams.get('project');
  const errorType = url.searchParams.get('error_type');
  const dateFrom = url.searchParams.get('date_from');
  const dateTo = url.searchParams.get('date_to');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  // Sorting - validated against allowed columns to prevent SQL injection
  const allowedSortColumns = ['priority', 'script_name', 'status', 'occurrence_count', 'last_seen_at', 'first_seen_at', 'project'];
  const sortByParam = url.searchParams.get('sort_by');
  const sortBy = allowedSortColumns.includes(sortByParam || '') ? sortByParam : 'last_seen_at';
  const sortOrderParam = url.searchParams.get('sort_order')?.toLowerCase();
  const sortOrder = sortOrderParam === 'asc' ? 'ASC' : 'DESC';

  // Build dynamic WHERE clause
  const conditions: string[] = [];
  const bindings: (string | number)[] = [];

  if (script) {
    conditions.push('script_name = ?');
    bindings.push(script);
  }
  if (priority) {
    conditions.push('priority = ?');
    bindings.push(priority);
  }
  if (status) {
    conditions.push('status = ?');
    bindings.push(status);
  }
  if (project) {
    conditions.push('project = ?');
    bindings.push(project);
  }
  if (errorType) {
    conditions.push('error_type = ?');
    bindings.push(errorType);
  }
  if (dateFrom) {
    const fromTs = Math.floor(new Date(dateFrom).getTime() / 1000);
    conditions.push('last_seen_at >= ?');
    bindings.push(fromTs);
  }
  if (dateTo) {
    const toTs = Math.floor(new Date(dateTo).getTime() / 1000);
    conditions.push('last_seen_at <= ?');
    bindings.push(toTs);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Count total
  const countQuery = `SELECT COUNT(*) as total FROM error_occurrences ${whereClause}`;
  const countResult = await env.PLATFORM_DB.prepare(countQuery)
    .bind(...bindings)
    .first<{ total: number }>();

  // Fetch errors
  const query = `
    SELECT
      id, fingerprint, script_name, project, error_type, priority,
      github_issue_number, github_issue_url, github_repo,
      status, resolved_at, resolved_by,
      first_seen_at, last_seen_at, occurrence_count,
      last_request_url, last_request_method, last_colo, last_country, last_cf_ray,
      last_exception_name, last_exception_message,
      normalized_message, error_category
    FROM error_occurrences
    ${whereClause}
    ORDER BY ${sortBy} ${sortOrder}
    LIMIT ? OFFSET ?
  `;

  const result = await env.PLATFORM_DB.prepare(query)
    .bind(...bindings, limit, offset)
    .all();

  return new Response(JSON.stringify({
    errors: result.results || [],
    total: countResult?.total || 0,
    limit,
    offset,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Get error statistics for dashboard overview
 */
async function handleErrorStats(env: Env): Promise<Response> {
  // Counts by priority
  const priorityCounts = await env.PLATFORM_DB.prepare(`
    SELECT priority, COUNT(*) as count
    FROM error_occurrences
    WHERE status = 'open'
    GROUP BY priority
  `).all<{ priority: string; count: number }>();

  // Counts by status
  const statusCounts = await env.PLATFORM_DB.prepare(`
    SELECT status, COUNT(*) as count
    FROM error_occurrences
    GROUP BY status
  `).all<{ status: string; count: number }>();

  // Counts by error type
  const typeCounts = await env.PLATFORM_DB.prepare(`
    SELECT error_type, COUNT(*) as count
    FROM error_occurrences
    WHERE status = 'open'
    GROUP BY error_type
  `).all<{ error_type: string; count: number }>();

  // Counts by project
  const projectCounts = await env.PLATFORM_DB.prepare(`
    SELECT project, COUNT(*) as count
    FROM error_occurrences
    WHERE status = 'open'
    GROUP BY project
  `).all<{ project: string; count: number }>();

  // Recent errors (last 24h)
  const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
  const recentCount = await env.PLATFORM_DB.prepare(`
    SELECT COUNT(*) as count
    FROM error_occurrences
    WHERE last_seen_at > ?
  `).bind(oneDayAgo).first<{ count: number }>();

  // Transient error categories
  const transientCounts = await env.PLATFORM_DB.prepare(`
    SELECT error_category, COUNT(DISTINCT fingerprint) as count
    FROM error_occurrences
    WHERE error_category IS NOT NULL AND status = 'open'
    GROUP BY error_category
  `).all<{ error_category: string; count: number }>();

  // Total occurrences today
  const todayStart = Math.floor(new Date().setUTCHours(0, 0, 0, 0) / 1000);
  const todayOccurrences = await env.PLATFORM_DB.prepare(`
    SELECT SUM(occurrence_count) as total
    FROM error_occurrences
    WHERE last_seen_at >= ?
  `).bind(todayStart).first<{ total: number }>();

  // Build stats object
  const byPriority: Record<string, number> = {};
  for (const row of priorityCounts.results || []) {
    byPriority[row.priority] = row.count;
  }

  const byStatus: Record<string, number> = {};
  for (const row of statusCounts.results || []) {
    byStatus[row.status] = row.count;
  }

  const byType: Record<string, number> = {};
  for (const row of typeCounts.results || []) {
    byType[row.error_type] = row.count;
  }

  const byProject: Record<string, number> = {};
  for (const row of projectCounts.results || []) {
    byProject[row.project] = row.count;
  }

  const byTransientCategory: Record<string, number> = {};
  for (const row of transientCounts.results || []) {
    byTransientCategory[row.error_category] = row.count;
  }

  return new Response(JSON.stringify({
    byPriority,
    byStatus,
    byType,
    byProject,
    byTransientCategory,
    recentCount: recentCount?.count || 0,
    todayOccurrences: todayOccurrences?.total || 0,
    totalOpen: byStatus['open'] || 0,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// ============================================================================
// Warning Digest API Handlers
// ============================================================================

/**
 * List warning digests with filtering
 * GET /digests?script=&days=&limit=&offset=
 */
async function handleListDigests(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const script = url.searchParams.get('script');
  const days = parseInt(url.searchParams.get('days') || '30', 10);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoffDateStr = cutoffDate.toISOString().split('T')[0];

  // Build query with optional filters
  let query = `
    SELECT
      id,
      digest_date,
      script_name,
      fingerprint,
      normalized_message,
      github_repo,
      github_issue_number,
      github_issue_url,
      occurrence_count,
      first_occurrence_at,
      last_occurrence_at,
      created_at,
      updated_at
    FROM warning_digests
    WHERE digest_date >= ?
  `;
  const params: (string | number)[] = [cutoffDateStr];

  if (script) {
    query += ' AND script_name LIKE ?';
    params.push(`%${script}%`);
  }

  // Get total count
  let countQuery = `SELECT COUNT(*) as total FROM warning_digests WHERE digest_date >= ?`;
  const countParams: (string | number)[] = [cutoffDateStr];
  if (script) {
    countQuery += ' AND script_name LIKE ?';
    countParams.push(`%${script}%`);
  }

  const countResult = await env.PLATFORM_DB.prepare(countQuery)
    .bind(...countParams)
    .first<{ total: number }>();

  // Add ordering and pagination
  query += ' ORDER BY digest_date DESC, occurrence_count DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const result = await env.PLATFORM_DB.prepare(query)
    .bind(...params)
    .all();

  return new Response(JSON.stringify({
    digests: result.results || [],
    total: countResult?.total || 0,
    limit,
    offset,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Get warning digest statistics
 * GET /digests/stats
 */
async function handleDigestStats(env: Env): Promise<Response> {
  // Digests by date (last 14 days)
  const twoWeeksAgo = new Date();
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
  const cutoffDateStr = twoWeeksAgo.toISOString().split('T')[0];

  const byDate = await env.PLATFORM_DB.prepare(`
    SELECT digest_date, COUNT(*) as count, SUM(occurrence_count) as occurrences
    FROM warning_digests
    WHERE digest_date >= ?
    GROUP BY digest_date
    ORDER BY digest_date DESC
  `).bind(cutoffDateStr).all<{ digest_date: string; count: number; occurrences: number }>();

  // Digests by script (all time, top 10)
  const byScript = await env.PLATFORM_DB.prepare(`
    SELECT script_name, COUNT(*) as count, SUM(occurrence_count) as occurrences
    FROM warning_digests
    GROUP BY script_name
    ORDER BY occurrences DESC
    LIMIT 10
  `).all<{ script_name: string; count: number; occurrences: number }>();

  // Digests by repo (all time)
  const byRepo = await env.PLATFORM_DB.prepare(`
    SELECT github_repo, COUNT(*) as count, SUM(occurrence_count) as occurrences
    FROM warning_digests
    GROUP BY github_repo
    ORDER BY occurrences DESC
  `).all<{ github_repo: string; count: number; occurrences: number }>();

  // Recent totals
  const oneDayAgo = new Date();
  oneDayAgo.setDate(oneDayAgo.getDate() - 1);
  const yesterday = oneDayAgo.toISOString().split('T')[0];

  const todayDigests = await env.PLATFORM_DB.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(occurrence_count), 0) as occurrences
    FROM warning_digests
    WHERE digest_date = date('now')
  `).first<{ count: number; occurrences: number }>();

  const yesterdayDigests = await env.PLATFORM_DB.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(occurrence_count), 0) as occurrences
    FROM warning_digests
    WHERE digest_date = ?
  `).bind(yesterday).first<{ count: number; occurrences: number }>();

  // Total digests and occurrences
  const totals = await env.PLATFORM_DB.prepare(`
    SELECT COUNT(*) as totalDigests, COALESCE(SUM(occurrence_count), 0) as totalOccurrences
    FROM warning_digests
  `).first<{ totalDigests: number; totalOccurrences: number }>();

  // Most common warning types (top 5)
  const topWarnings = await env.PLATFORM_DB.prepare(`
    SELECT normalized_message, SUM(occurrence_count) as occurrences, COUNT(*) as days_occurred
    FROM warning_digests
    GROUP BY normalized_message
    ORDER BY occurrences DESC
    LIMIT 5
  `).all<{ normalized_message: string; occurrences: number; days_occurred: number }>();

  return new Response(JSON.stringify({
    byDate: byDate.results || [],
    byScript: byScript.results || [],
    byRepo: byRepo.results || [],
    todayDigests: todayDigests || { count: 0, occurrences: 0 },
    yesterdayDigests: yesterdayDigests || { count: 0, occurrences: 0 },
    totalDigests: totals?.totalDigests || 0,
    totalOccurrences: totals?.totalOccurrences || 0,
    topWarnings: topWarnings.results || [],
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Get single error by fingerprint
 */
async function handleGetError(
  fingerprint: string,
  env: Env
): Promise<Response> {
  const error = await env.PLATFORM_DB.prepare(`
    SELECT *
    FROM error_occurrences
    WHERE fingerprint = ?
  `).bind(fingerprint).first();

  if (!error) {
    return new Response(JSON.stringify({ error: 'Error not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify(error), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Mute an error (add cf:muted label to GitHub issue)
 */
async function handleMuteError(
  fingerprint: string,
  env: Env
): Promise<Response> {
  // Get error details
  const error = await env.PLATFORM_DB.prepare(`
    SELECT github_issue_number, github_repo
    FROM error_occurrences
    WHERE fingerprint = ?
  `).bind(fingerprint).first<{ github_issue_number: number; github_repo: string }>();

  if (!error || !error.github_issue_number) {
    return new Response(JSON.stringify({ error: 'Error not found or has no GitHub issue' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const github = new GitHubClient(env);
    const [owner, repo] = error.github_repo.split('/');

    await github.addLabels(owner, repo, error.github_issue_number, ['cf:muted']);

    return new Response(JSON.stringify({
      success: true,
      message: `Muted error - added cf:muted label to issue #${error.github_issue_number}`
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: `Failed to mute: ${e}` }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Resolve an error manually
 */
async function handleResolveError(
  fingerprint: string,
  env: Env
): Promise<Response> {
  // Get error details
  const error = await env.PLATFORM_DB.prepare(`
    SELECT github_issue_number, github_repo
    FROM error_occurrences
    WHERE fingerprint = ?
  `).bind(fingerprint).first<{ github_issue_number: number; github_repo: string }>();

  if (!error) {
    return new Response(JSON.stringify({ error: 'Error not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Update D1
  await env.PLATFORM_DB.prepare(`
    UPDATE error_occurrences
    SET status = 'resolved',
        resolved_at = unixepoch(),
        resolved_by = 'dashboard',
        updated_at = unixepoch()
    WHERE fingerprint = ?
  `).bind(fingerprint).run();

  // Update KV cache
  const kvKey = `ERROR_FINGERPRINT:${fingerprint}`;
  const cached = await env.PLATFORM_CACHE.get(kvKey);
  if (cached) {
    const data = JSON.parse(cached);
    await env.PLATFORM_CACHE.put(
      kvKey,
      JSON.stringify({ ...data, status: 'resolved' }),
      { expirationTtl: 90 * 24 * 60 * 60 }
    );
  }

  // Close GitHub issue if exists
  if (error.github_issue_number) {
    try {
      const github = new GitHubClient(env);
      const [owner, repo] = error.github_repo.split('/');

      await github.updateIssue({
        owner,
        repo,
        issue_number: error.github_issue_number,
        state: 'closed',
      });

      await github.addComment(
        owner,
        repo,
        error.github_issue_number,
        `✅ **Resolved via Dashboard**\n\nThis error was marked as resolved from the Platform Dashboard.`
      );
    } catch (e) {
      console.error(`Failed to close GitHub issue: ${e}`);
    }
  }

  return new Response(JSON.stringify({
    success: true,
    message: 'Error marked as resolved'
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// ============================================================================
// Main HTTP Handler
// ============================================================================

/**
 * HTTP handler - webhook endpoint for GitHub events + dashboard API
 */
async function fetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // Health check
  if (url.pathname === '/health') {
    return new Response(JSON.stringify({ status: 'ok', worker: 'error-collector' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ============================================================================
  // Dashboard API endpoints
  // ============================================================================

  // GET /errors - List errors with filtering
  if (url.pathname === '/errors' && request.method === 'GET') {
    return handleListErrors(request, env);
  }

  // GET /errors/stats - Get error statistics
  if (url.pathname === '/errors/stats' && request.method === 'GET') {
    return handleErrorStats(env);
  }

  // GET /errors/:fingerprint - Get single error
  const errorMatch = url.pathname.match(/^\/errors\/([a-f0-9]+)$/);
  if (errorMatch && request.method === 'GET') {
    return handleGetError(errorMatch[1], env);
  }

  // POST /errors/:fingerprint/mute - Mute an error
  const muteMatch = url.pathname.match(/^\/errors\/([a-f0-9]+)\/mute$/);
  if (muteMatch && request.method === 'POST') {
    return handleMuteError(muteMatch[1], env);
  }

  // POST /errors/:fingerprint/resolve - Resolve an error
  const resolveMatch = url.pathname.match(/^\/errors\/([a-f0-9]+)\/resolve$/);
  if (resolveMatch && request.method === 'POST') {
    return handleResolveError(resolveMatch[1], env);
  }

  // GET /digests - List warning digests with filtering
  if (url.pathname === '/digests' && request.method === 'GET') {
    return handleListDigests(request, env);
  }

  // GET /digests/stats - Get digest statistics
  if (url.pathname === '/digests/stats' && request.method === 'GET') {
    return handleDigestStats(env);
  }

  // POST /gap-alerts - Create GitHub issue for data coverage gap
  // Called by platform-sentinel when a project has low coverage
  if (url.pathname === '/gap-alerts' && request.method === 'POST') {
    try {
      const event = (await request.json()) as GapAlertEvent;

      // Validate required fields
      if (!event.project || event.coveragePct === undefined) {
        return new Response(
          JSON.stringify({ error: 'Missing required fields: project, coveragePct' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const result = await processGapAlert(event, env);

      return new Response(JSON.stringify(result), {
        status: result.processed ? 201 : 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (e) {
      console.error('Gap alert processing error:', e);
      return new Response(
        JSON.stringify({ error: 'Processing failed', details: String(e) }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  // POST /email-health-alerts - Create GitHub issues for email health check failures
  // Called by platform-email-healthcheck when a brand has failing checks
  if (url.pathname === '/email-health-alerts' && request.method === 'POST') {
    try {
      const event = (await request.json()) as EmailHealthAlertEvent;

      // Validate required fields
      if (!event.brand_id || !event.failures?.length || !event.repository) {
        return new Response(
          JSON.stringify({ error: 'Missing required fields: brand_id, failures, repository' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const result = await processEmailHealthAlerts(event, env);

      return new Response(JSON.stringify(result), {
        status: result.processed > 0 ? 201 : 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (e) {
      console.error('Email health alert processing error:', e);
      return new Response(
        JSON.stringify({ error: 'Processing failed', details: String(e) }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  // Test error endpoint - triggers an intentional error for testing the error collection pipeline
  // Usage: GET /test-error?type=exception|soft|warning
  if (url.pathname === '/test-error') {
    const errorType = url.searchParams.get('type') || 'exception';

    if (errorType === 'soft') {
      console.error(
        'TEST SOFT ERROR: This is a test soft error triggered via /test-error endpoint'
      );
      return new Response(JSON.stringify({ triggered: 'soft_error' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (errorType === 'warning') {
      console.warn('TEST WARNING: This is a test warning triggered via /test-error endpoint');
      return new Response(JSON.stringify({ triggered: 'warning' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Default: throw an exception
    throw new Error('TEST EXCEPTION: This is a test exception triggered via /test-error endpoint');
  }

  // GitHub webhook endpoint
  if (url.pathname === '/webhooks/github' && request.method === 'POST') {
    const eventType = request.headers.get('X-GitHub-Event');

    // Handle ping event (sent when webhook is created)
    if (eventType === 'ping') {
      console.log('Received GitHub webhook ping');
      return new Response(JSON.stringify({ message: 'pong' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Only handle issue events
    if (eventType !== 'issues') {
      return new Response(
        JSON.stringify({ processed: false, reason: `Event type '${eventType}' not handled` }),
        {
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    try {
      const payload = await request.text();
      const signature = request.headers.get('X-Hub-Signature-256');

      // Verify signature
      const isValid = await verifyWebhookSignature(payload, signature, env.GITHUB_WEBHOOK_SECRET);
      if (!isValid) {
        console.error('Invalid webhook signature');
        return new Response(JSON.stringify({ error: 'Invalid signature' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Parse and process issue event
      const event = JSON.parse(payload) as GitHubIssueEvent;
      const result = await handleGitHubWebhook(event, env);

      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (e) {
      console.error(`Webhook processing error: ${e}`);
      return new Response(JSON.stringify({ error: 'Processing failed', details: String(e) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  return new Response('Not Found', { status: 404 });
}

export default {
  tail,
  scheduled,
  fetch,
};
