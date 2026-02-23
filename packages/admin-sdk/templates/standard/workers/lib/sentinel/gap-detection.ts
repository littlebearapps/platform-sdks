/**
 * Gap Detection Module for Platform Sentinel
 *
 * Detects missing hourly usage snapshots and stale projects.
 * Runs every 15 minutes as part of platform-sentinel's scheduled handler.
 *
 * @module workers/lib/sentinel/gap-detection
 */

import type { D1Database, KVNamespace } from '@cloudflare/workers-types';
import type { Logger } from '@littlebearapps/platform-consumer-sdk';

// TODO: Set your dashboard URL and alert email
const DASHBOARD_URL = 'https://your-dashboard.example.com';
const PLATFORM_USAGE_URL = 'https://platform-usage.your-subdomain.workers.dev';

// TODO: Set the email "from" address for your Resend domain
const ALERT_FROM_EMAIL = 'Platform Alerts <alerts@mail.your-domain.com>';

/**
 * Environment bindings required for gap detection
 */
export interface GapDetectionEnv {
  PLATFORM_DB: D1Database;
  PLATFORM_CACHE: KVNamespace;
  PLATFORM_ALERTS: KVNamespace;
  SLACK_WEBHOOK_URL?: string;
  RESEND_API_KEY?: string;
  ALERT_EMAIL_TO?: string;
}

/**
 * Missing hour entry
 */
export interface MissingHour {
  project: string;
  hour: string; // ISO datetime (YYYY-MM-DDTHH:00:00Z)
  expectedAt: string; // When it should have been collected
}

/**
 * Stale project entry
 */
export interface StaleProject {
  project: string;
  lastSnapshot: string;
  hoursSinceLastSnapshot: number;
}

/**
 * Gap detection report
 */
export interface GapReport {
  checkTime: string;
  missingHours: MissingHour[];
  staleProjects: StaleProject[];
  totalMissingHours: number;
  totalStaleProjects: number;
  severity: 'ok' | 'warning' | 'critical';
}

/**
 * Rate limit for gap alerts: 1 alert per hour
 */
const GAP_ALERT_RATE_LIMIT_TTL = 3600;

/**
 * Projects we expect to have hourly snapshots for.
 *
 * Note: Only 'all' project gets hourly snapshots from GraphQL collection.
 * Per-project data exists in resource_usage_snapshots table (per-resource granularity).
 */
const EXPECTED_PROJECTS = ['all'];

/**
 * How many hours back to check for gaps (24 hours)
 */
const LOOKBACK_HOURS = 24;

/**
 * Stale threshold: project with no snapshot in 2+ hours
 */
const STALE_THRESHOLD_HOURS = 2;

/**
 * Detect gaps in hourly usage snapshots
 */
export async function detectGaps(env: GapDetectionEnv, log: Logger): Promise<GapReport> {
  const checkTime = new Date().toISOString();
  const missingHours: MissingHour[] = [];
  const staleProjects: StaleProject[] = [];

  try {
    // 1. Find missing hours in the last 24h
    const missingResult = await findMissingHours(env, log);
    missingHours.push(...missingResult);

    // 2. Find stale projects (no recent snapshots)
    const staleResult = await findStaleProjects(env, log);
    staleProjects.push(...staleResult);
  } catch (error) {
    log.error('Gap detection query failed', error);
  }

  // Determine severity
  let severity: GapReport['severity'] = 'ok';

  if (
    missingHours.length > 3 ||
    staleProjects.length > 1 ||
    staleProjects.some((p) => p.hoursSinceLastSnapshot > 6)
  ) {
    severity = 'critical';
  } else if (missingHours.length > 0 || staleProjects.length > 0) {
    severity = 'warning';
  }

  const report: GapReport = {
    checkTime,
    missingHours,
    staleProjects,
    totalMissingHours: missingHours.length,
    totalStaleProjects: staleProjects.length,
    severity,
  };

  log.info('Gap detection complete', {
    missingHours: report.totalMissingHours,
    staleProjects: report.totalStaleProjects,
    severity: report.severity,
  });

  return report;
}

/**
 * Find missing hourly snapshots in the last 24 hours
 */
async function findMissingHours(env: GapDetectionEnv, log: Logger): Promise<MissingHour[]> {
  const missing: MissingHour[] = [];
  const now = new Date();

  // Generate expected hours for the last 24h
  const expectedHours: string[] = [];
  for (let i = 1; i <= LOOKBACK_HOURS; i++) {
    const hour = new Date(now);
    hour.setUTCHours(hour.getUTCHours() - i, 0, 0, 0);
    expectedHours.push(hour.toISOString().replace(':00:00.000Z', ':00:00Z'));
  }

  // Check each expected project
  for (const project of EXPECTED_PROJECTS) {
    try {
      // Get all snapshots for this project in the last 24h
      const result = await env.PLATFORM_DB.prepare(
        `
        SELECT snapshot_hour
        FROM hourly_usage_snapshots
        WHERE project = ?
          AND snapshot_hour >= datetime('now', '-24 hours')
        ORDER BY snapshot_hour DESC
      `
      )
        .bind(project)
        .all<{ snapshot_hour: string }>();

      const foundHours = new Set(result.results?.map((r) => r.snapshot_hour) ?? []);

      // Find missing hours
      for (const expectedHour of expectedHours) {
        // Normalize the expected hour format for comparison
        const normalizedExpected = expectedHour.replace('.000Z', 'Z');

        // Check various format variations
        const found =
          foundHours.has(normalizedExpected) ||
          foundHours.has(expectedHour) ||
          foundHours.has(normalizedExpected.replace('Z', '.000Z'));

        if (!found) {
          missing.push({
            project,
            hour: normalizedExpected,
            expectedAt: new Date(
              new Date(normalizedExpected).getTime() + 60 * 60 * 1000
            ).toISOString(),
          });
        }
      }
    } catch (error) {
      log.error('Failed to check missing hours for project', error, { project });
    }
  }

  // Sort by hour descending (most recent first)
  missing.sort((a, b) => b.hour.localeCompare(a.hour));

  return missing;
}

/**
 * Find projects that haven't sent snapshots recently.
 *
 * Only checks EXPECTED_PROJECTS (currently just 'all').
 */
async function findStaleProjects(env: GapDetectionEnv, log: Logger): Promise<StaleProject[]> {
  const stale: StaleProject[] = [];

  // Only check projects we expect to have hourly snapshots
  if (EXPECTED_PROJECTS.length === 0) return stale;

  // Build placeholder string for SQL IN clause
  const placeholders = EXPECTED_PROJECTS.map(() => '?').join(', ');

  try {
    const result = await env.PLATFORM_DB.prepare(
      `
      SELECT
        project,
        MAX(snapshot_hour) as last_snapshot,
        CAST((julianday('now') - julianday(MAX(snapshot_hour))) * 24 AS INTEGER) as hours_stale
      FROM hourly_usage_snapshots
      WHERE project IN (${placeholders})
      GROUP BY project
      HAVING hours_stale > ?
    `
    )
      .bind(...EXPECTED_PROJECTS, STALE_THRESHOLD_HOURS)
      .all<{ project: string; last_snapshot: string; hours_stale: number }>();

    for (const row of result.results ?? []) {
      stale.push({
        project: row.project,
        lastSnapshot: row.last_snapshot,
        hoursSinceLastSnapshot: row.hours_stale,
      });
    }
  } catch (error) {
    log.error('Failed to check stale projects', error);
  }

  return stale;
}

/**
 * Store gap report in D1 for aggregation by platform-auditor
 */
export async function storeGapReport(
  env: GapDetectionEnv,
  report: GapReport,
  log: Logger
): Promise<void> {
  try {
    const id = crypto.randomUUID();

    await env.PLATFORM_DB.prepare(
      `
      INSERT INTO gap_detection_log (id, detection_time, missing_hours_count, stale_projects_count, severity, report_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `
    )
      .bind(
        id,
        report.checkTime,
        report.totalMissingHours,
        report.totalStaleProjects,
        report.severity,
        JSON.stringify(report)
      )
      .run();

    log.debug('Stored gap report', { id, severity: report.severity });
  } catch (error) {
    log.error('Failed to store gap report', error);
  }
}

/**
 * Send Slack alert for detected gaps
 */
export async function alertGaps(
  env: GapDetectionEnv,
  report: GapReport,
  log: Logger
): Promise<void> {
  // Only alert for warning or critical
  if (report.severity === 'ok') {
    return;
  }

  // Check rate limit
  const alertKey = 'gap-detection:alert';
  const alreadySent = await env.PLATFORM_ALERTS.get(alertKey);

  if (alreadySent) {
    log.debug('Gap alert rate limited');
    return;
  }

  if (!env.SLACK_WEBHOOK_URL) {
    log.warn('No SLACK_WEBHOOK_URL configured, skipping gap alert');
    return;
  }

  const emoji = report.severity === 'critical' ? ':rotating_light:' : ':warning:';
  const colour = report.severity === 'critical' ? '#dc3545' : '#ffc107';

  // Build missing hours summary
  const missingByProject = new Map<string, number>();
  for (const m of report.missingHours) {
    missingByProject.set(m.project, (missingByProject.get(m.project) ?? 0) + 1);
  }
  const missingSummary = Array.from(missingByProject.entries())
    .map(([project, count]) => `${project}: ${count}h`)
    .join(', ');

  // Build stale projects summary
  const staleSummary = report.staleProjects
    .map((p) => `${p.project} (${p.hoursSinceLastSnapshot}h stale)`)
    .join(', ');

  const message = {
    text: `[${report.severity.toUpperCase()}] Usage data gaps detected - ${report.totalMissingHours} missing hours`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${emoji} Usage Data Gap Detected`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Severity:*\n${report.severity.toUpperCase()}` },
          { type: 'mrkdwn', text: `*Missing Hours:*\n${report.totalMissingHours}` },
          { type: 'mrkdwn', text: `*Stale Projects:*\n${report.totalStaleProjects}` },
          { type: 'mrkdwn', text: `*Check Time:*\n${report.checkTime}` },
        ],
      },
    ] as Array<{ type: string; text?: unknown; fields?: unknown[] }>,
    attachments: [
      {
        color: colour,
        fields: [] as Array<{ title: string; value: string; short: boolean }>,
      },
    ],
  };

  if (missingSummary) {
    message.attachments[0].fields.push({
      title: 'Missing Hours by Project',
      value: missingSummary,
      short: false,
    });
  }

  if (staleSummary) {
    message.attachments[0].fields.push({
      title: 'Stale Projects',
      value: staleSummary,
      short: false,
    });
  }

  // Add investigation commands
  message.blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Investigation Commands:*\n\`\`\`# Check recent hourly snapshots
npx wrangler d1 execute platform-metrics --remote --command "SELECT project, snapshot_hour FROM hourly_usage_snapshots WHERE snapshot_hour >= datetime('now', '-6 hours') ORDER BY snapshot_hour DESC"

# Check gap detection history
npx wrangler d1 execute platform-metrics --remote --command "SELECT * FROM gap_detection_log ORDER BY detection_time DESC LIMIT 5"

# Trigger backfill (if needed)
curl -X POST ${PLATFORM_USAGE_URL}/usage/gaps/backfill -H 'Content-Type: application/json' -d '{"startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD"}'\`\`\``,
    },
  } as { type: string; text: { type: string; text: string } });

  // Add dashboard link
  message.blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: 'Usage Dashboard',
          emoji: true,
        },
        url: `${DASHBOARD_URL}/usage/unified`,
      },
    ],
  } as unknown as { type: string; text?: unknown; fields?: unknown[] });

  try {
    const response = await fetch(env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    if (response.ok) {
      // Set rate limit
      await env.PLATFORM_ALERTS.put(alertKey, new Date().toISOString(), {
        expirationTtl: GAP_ALERT_RATE_LIMIT_TTL,
      });
      log.info('Sent gap detection Slack alert', { severity: report.severity });
    } else {
      const text = await response.text();
      log.error('Failed to send gap detection Slack alert', {
        status: response.status,
        error: text,
      });
    }
  } catch (error) {
    log.error('Error sending gap detection Slack alert', error);
  }
}

/**
 * Send email alert for critical gaps
 */
// =============================================================================
// PER-PROJECT GAP DETECTION
// =============================================================================

/**
 * Threshold for per-project coverage alerts (percentage)
 */
const PROJECT_COVERAGE_THRESHOLD = 90;

/**
 * On-demand resources excluded from coverage "expected" denominator.
 * These only appear in GraphQL when they receive traffic, so they create
 * false-positive gaps on quiet days. Format: "resource_type:resource_id"
 *
 * TODO: Customise this list for your projects' on-demand resources
 */
const ON_DEMAND_RESOURCE_EXCLUSIONS = new Set([
  'worker:platform-settings',       // Admin-only, on-demand API
  'worker:platform-search',         // Admin-only, on-demand API
  'worker:platform-alert-router',   // Only invoked by Gatus/GitHub webhooks
  'worker:platform-ingest-tester',  // Manual testing tool
  'worker:platform-query-tester',   // Manual testing tool
  'worker:sdk-test-client',         // Manual testing tool
]);

/**
 * Resource-level coverage breakdown
 */
export interface ResourceCoverage {
  resourceType: string;
  hoursWithData: number;
  coveragePct: number;
}

/**
 * Per-project gap detection result
 */
export interface ProjectGap {
  project: string;
  hoursWithData: number;
  expectedHours: number;
  coveragePct: number;
  missingHours: string[]; // ISO timestamps of missing hours
  repository?: string; // GitHub repo from project_registry
  resourceBreakdown?: ResourceCoverage[]; // Per-resource type coverage
  lastDataHour?: string; // Most recent hour with data
}

/**
 * Detect gaps in per-project data coverage.
 * Queries resource_usage_snapshots table for projects with less than
 * PROJECT_COVERAGE_THRESHOLD% coverage in the last 24 hours.
 *
 * @returns Array of projects with low coverage, including their repo mapping
 */
export async function detectProjectGaps(
  env: GapDetectionEnv,
  log: Logger
): Promise<ProjectGap[]> {
  const gaps: ProjectGap[] = [];

  try {
    // Query resource-based coverage per project from resource_usage_snapshots.
    // Build exclusion list for SQL (on-demand resources that create false-positive gaps)
    const exclusionKeys = Array.from(ON_DEMAND_RESOURCE_EXCLUSIONS);
    const exclusionPlaceholders = exclusionKeys.map(() => '?').join(', ');

    const coverageResult = await env.PLATFORM_DB.prepare(
      `
      WITH recent AS (
        SELECT project, resource_type, resource_id, snapshot_hour
        FROM resource_usage_snapshots
        WHERE snapshot_hour >= datetime('now', '-24 hours')
          AND project IS NOT NULL
          AND project NOT IN ('unknown', 'all')
      ),
      known AS (
        SELECT project, resource_type, resource_id
        FROM resource_usage_snapshots
        WHERE project IS NOT NULL
          AND project NOT IN ('unknown', 'all')
          AND (resource_type || ':' || resource_id) NOT IN (${exclusionPlaceholders})
      )
      SELECT
        k.project,
        COUNT(DISTINCT k.resource_type || ':' || k.resource_id) as expected_resources,
        COUNT(DISTINCT r.resource_type || ':' || r.resource_id) as active_resources,
        ROUND(
          COUNT(DISTINCT r.resource_type || ':' || r.resource_id) * 100.0 /
          MAX(COUNT(DISTINCT k.resource_type || ':' || k.resource_id), 1),
          1
        ) as coverage_pct,
        MAX(r.snapshot_hour) as last_data_hour
      FROM known k
      LEFT JOIN recent r
        ON k.project = r.project
        AND k.resource_type = r.resource_type
        AND k.resource_id = r.resource_id
      GROUP BY k.project
      HAVING coverage_pct < ?
    `
    )
      .bind(...exclusionKeys, PROJECT_COVERAGE_THRESHOLD)
      .all<{
        project: string;
        expected_resources: number;
        active_resources: number;
        coverage_pct: number;
        last_data_hour: string | null;
      }>();

    if (!coverageResult.results || coverageResult.results.length === 0) {
      log.debug('All projects have adequate coverage');
      return gaps;
    }

    // For each project with low coverage, get details
    for (const row of coverageResult.results) {
      // Get resources that are missing from recent data
      const missingResult = await env.PLATFORM_DB.prepare(
        `
        SELECT DISTINCT resource_type || ':' || resource_id as resource_key
        FROM resource_usage_snapshots
        WHERE project = ?
          AND resource_type || ':' || resource_id NOT IN (
            SELECT DISTINCT resource_type || ':' || resource_id
            FROM resource_usage_snapshots
            WHERE project = ?
              AND snapshot_hour >= datetime('now', '-24 hours')
          )
      `
      )
        .bind(row.project, row.project)
        .all<{ resource_key: string }>();

      const missingResources = missingResult.results?.map((r) => r.resource_key) ?? [];

      // Look up GitHub repo from project_registry
      let repository: string | undefined;
      try {
        const repoResult = await env.PLATFORM_DB.prepare(
          `SELECT repo_path FROM project_registry WHERE project_id = ? LIMIT 1`
        )
          .bind(row.project)
          .first<{ repo_path: string | null }>();
        repository = repoResult?.repo_path ?? undefined;
      } catch {
        log.warn('Could not look up repository for project', { project: row.project });
      }

      // Get resource-level breakdown: distinct resources per type
      let resourceBreakdown: ResourceCoverage[] | undefined;
      try {
        const resourceResult = await env.PLATFORM_DB.prepare(
          `
          WITH recent AS (
            SELECT resource_type, resource_id
            FROM resource_usage_snapshots
            WHERE snapshot_hour >= datetime('now', '-24 hours')
              AND project = ?
          ),
          known AS (
            SELECT resource_type, resource_id
            FROM resource_usage_snapshots
            WHERE project = ?
          )
          SELECT
            k.resource_type,
            COUNT(DISTINCT k.resource_id) as total_resources,
            COUNT(DISTINCT r.resource_id) as active_resources,
            ROUND(
              COUNT(DISTINCT r.resource_id) * 100.0 /
              MAX(COUNT(DISTINCT k.resource_id), 1),
              1
            ) as coverage_pct
          FROM known k
          LEFT JOIN recent r
            ON k.resource_type = r.resource_type
            AND k.resource_id = r.resource_id
          GROUP BY k.resource_type
          ORDER BY coverage_pct ASC
        `
        )
          .bind(row.project, row.project)
          .all<{ resource_type: string; total_resources: number; active_resources: number; coverage_pct: number }>();

        if (resourceResult.results && resourceResult.results.length > 0) {
          resourceBreakdown = resourceResult.results.map((r) => ({
            resourceType: r.resource_type,
            hoursWithData: r.active_resources,
            coveragePct: r.coverage_pct,
          }));
        }
      } catch {
        log.warn('Could not get resource breakdown for project', { project: row.project });
      }

      gaps.push({
        project: row.project,
        hoursWithData: row.active_resources,
        expectedHours: row.expected_resources,
        coveragePct: row.coverage_pct,
        missingHours: missingResources,
        repository,
        resourceBreakdown,
        lastDataHour: row.last_data_hour ?? undefined,
      });
    }

    log.info('Detected project gaps', {
      projectCount: gaps.length,
      projects: gaps.map((g) => `${g.project}:${g.coveragePct}%`),
    });
  } catch (error) {
    log.error('Failed to detect project gaps', error);
  }

  return gaps;
}

export async function alertGapsEmail(
  env: GapDetectionEnv,
  report: GapReport,
  log: Logger
): Promise<void> {
  // Only email for critical
  if (report.severity !== 'critical') {
    return;
  }

  // Check rate limit (4 hours for email)
  const alertKey = 'gap-detection:email';
  const alreadySent = await env.PLATFORM_ALERTS.get(alertKey);

  if (alreadySent) {
    log.debug('Gap email alert rate limited');
    return;
  }

  if (!env.RESEND_API_KEY || !env.ALERT_EMAIL_TO) {
    log.warn('Resend not configured, skipping gap email alert');
    return;
  }

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Critical: Usage Data Gaps Detected</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background-color: #f5f5f5;">
  <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
    <div style="background-color: #dc3545; color: white; padding: 20px;">
      <h1 style="margin: 0; font-size: 20px;">Critical: Usage Data Gaps Detected</h1>
    </div>
    <div style="padding: 20px;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 10px 0; border-bottom: 1px solid #eee;"><strong>Missing Hours</strong></td><td style="padding: 10px 0; border-bottom: 1px solid #eee;">${report.totalMissingHours}</td></tr>
        <tr><td style="padding: 10px 0; border-bottom: 1px solid #eee;"><strong>Stale Projects</strong></td><td style="padding: 10px 0; border-bottom: 1px solid #eee;">${report.totalStaleProjects}</td></tr>
        <tr><td style="padding: 10px 0;"><strong>Detection Time</strong></td><td style="padding: 10px 0;">${report.checkTime}</td></tr>
      </table>
      <div style="margin-top: 20px; padding: 15px; background: #f8f9fa; border-radius: 4px;">
        <strong>Affected Projects:</strong>
        <p style="margin: 10px 0 0 0; color: #666;">${report.staleProjects.map((p) => p.project).join(', ') || 'None stale'}</p>
      </div>
      <div style="margin-top: 20px;">
        <a href="${DASHBOARD_URL}/usage/unified" style="display: inline-block; padding: 10px 20px; background: #007bff; color: white; text-decoration: none; border-radius: 4px;">View Dashboard</a>
      </div>
    </div>
    <div style="background: #f8f9fa; padding: 15px 20px; font-size: 12px; color: #666;">
      <p style="margin: 0;">Platform Sentinel | Gap Detection</p>
    </div>
  </div>
</body>
</html>`;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: ALERT_FROM_EMAIL,
        to: env.ALERT_EMAIL_TO,
        subject: `[CRITICAL] Usage Data Gaps: ${report.totalMissingHours} missing hours`,
        html,
      }),
    });

    if (response.ok) {
      // Set rate limit (4 hours for email)
      await env.PLATFORM_ALERTS.put(alertKey, new Date().toISOString(), {
        expirationTtl: 14400,
      });
      log.info('Sent gap detection email alert');
    } else {
      const text = await response.text();
      log.error('Failed to send gap detection email alert', {
        status: response.status,
        error: text,
      });
    }
  } catch (error) {
    log.error('Error sending gap detection email alert', error);
  }
}
