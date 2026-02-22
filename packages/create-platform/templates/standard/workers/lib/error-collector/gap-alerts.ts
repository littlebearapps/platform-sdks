/**
 * Gap Alert Handler
 *
 * Processes gap alerts from platform-sentinel and creates GitHub issues
 * in the correct project repository when data coverage drops below threshold.
 *
 * Uses existing GitHubClient and deduplication patterns from error-collector.
 *
 * @module workers/lib/error-collector/gap-alerts
 */

import type { Env, GapAlertEvent } from './types';
import { GitHubClient } from './github';

// TODO: Set your GitHub organisation and dashboard URL
const GITHUB_ORG = 'your-github-org';
const DASHBOARD_URL = 'https://your-dashboard.example.com';
const GATUS_URL = 'https://your-status.example.com';

/**
 * KV prefix for gap alert deduplication.
 * Format: GAP_ALERT:{project}:{date}
 * One issue per project per day maximum.
 */
const GAP_ALERT_PREFIX = 'GAP_ALERT';

/**
 * Labels applied to gap alert issues
 */
const GAP_ALERT_LABELS = ['cf:gap-alert', 'cf:priority:p2', 'cf:auto-generated'];

/**
 * Get today's date key in YYYY-MM-DD format (UTC)
 */
function getDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Check if a gap alert has already been created for this project today.
 *
 * @returns Issue number if exists, null otherwise
 */
async function checkGapAlertDedup(
  kv: KVNamespace,
  project: string
): Promise<number | null> {
  const key = `${GAP_ALERT_PREFIX}:${project}:${getDateKey()}`;
  const existing = await kv.get(key);
  return existing ? parseInt(existing, 10) : null;
}

/**
 * Record that a gap alert issue was created for today.
 */
async function setGapAlertDedup(
  kv: KVNamespace,
  project: string,
  issueNumber: number
): Promise<void> {
  const key = `${GAP_ALERT_PREFIX}:${project}:${getDateKey()}`;
  // TTL of 25 hours to cover the full day plus buffer
  await kv.put(key, String(issueNumber), { expirationTtl: 90000 });
}

/**
 * Format the GitHub issue body for a gap alert.
 * Designed to provide Claude Code with full context to investigate without additional lookups.
 */
function formatGapAlertBody(event: GapAlertEvent): string {
  const now = new Date();
  const startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const endTime = now.toISOString();

  // Format missing hours list (show first 10, then count)
  let missingHoursList: string;
  if (event.missingHours.length === 0) {
    missingHoursList = '_No specific hours identified_';
  } else if (event.missingHours.length <= 10) {
    missingHoursList = event.missingHours.map((h) => `- \`${h}\``).join('\n');
  } else {
    const shown = event.missingHours.slice(0, 10).map((h) => `- \`${h}\``).join('\n');
    missingHoursList = `${shown}\n- _... and ${event.missingHours.length - 10} more_`;
  }

  // Calculate gap duration and status
  const gapHours = event.expectedHours - event.hoursWithData;
  const hoursSinceLastData = event.lastDataHour
    ? Math.round((now.getTime() - new Date(event.lastDataHour.replace(' ', 'T') + ':00:00Z').getTime()) / (1000 * 60 * 60))
    : null;
  const isOngoing = hoursSinceLastData !== null && hoursSinceLastData > 2;

  // Format resource breakdown table
  let resourceBreakdownSection = '';
  if (event.resourceBreakdown && event.resourceBreakdown.length > 0) {
    resourceBreakdownSection = `### Resource Coverage (last 24h)

| Resource Type | Hours | Coverage |
|---------------|-------|----------|
${event.resourceBreakdown.map((r) => `| ${r.resourceType} | ${r.hoursWithData}/24 | ${r.coveragePct}% |`).join('\n')}

`;
  }

  // Collection status section
  let collectionStatusSection = '';
  if (event.lastDataHour || hoursSinceLastData !== null) {
    collectionStatusSection = `### Collection Status

| | |
|---|---|
| **Last Data Hour** | \`${event.lastDataHour || 'Unknown'}\` |
| **Hours Since Last Data** | ${hoursSinceLastData ?? 'Unknown'} |
| **Gap Duration** | ${gapHours} hours |
| **Status** | ${isOngoing ? 'Ongoing - collection may be broken' : 'Historical gap'} |

`;
  }

  const repoRef = event.repository || `${GITHUB_ORG}/platform`;

  return `## Data Coverage Gap Alert

| | |
|---|---|
| **Project** | \`${event.project}\` |
| **Coverage** | **${event.coveragePct}%** (threshold: 90%) |
| **Hours with data** | ${event.hoursWithData} / ${event.expectedHours} |
| **Missing hours** | ${gapHours} |
| **Period** | ${startTime.slice(0, 16)} to ${endTime.slice(0, 16)} UTC |

${collectionStatusSection}${resourceBreakdownSection}### Missing Hours

${missingHoursList}

### Impact

- Usage dashboards may show incomplete data for this project
- Anomaly detection accuracy may be reduced
- Cost attribution may be affected
- Circuit breaker thresholds may not trigger correctly

### Quick Links

- [Platform Dashboard - Usage](${DASHBOARD_URL}/usage)
- [Project Usage Details](${DASHBOARD_URL}/usage?project=${event.project})
- [CF Workers Observability](https://dash.cloudflare.com/?to=/:account/workers/observability)
- [Repository](https://github.com/${repoRef})
- [CLAUDE.md](https://github.com/${repoRef}/blob/main/CLAUDE.md)

### Investigation Steps

**For Claude Code agents investigating this issue:**

1. **Check if collection is currently working**:
   \`\`\`bash
   # Tail platform-usage logs to see if hourly collection is running
   wrangler tail platform-usage --format=pretty
   \`\`\`

2. **Query recent snapshots** to identify the gap pattern:
   \`\`\`bash
   npx wrangler d1 execute platform-metrics --remote --command "SELECT snapshot_hour, resource_type, COUNT(*) as rows FROM resource_usage_snapshots WHERE project = '${event.project}' AND snapshot_hour >= datetime('now', '-24 hours') GROUP BY snapshot_hour, resource_type ORDER BY snapshot_hour DESC"
   \`\`\`

3. **Check platform-usage worker health**:
   \`\`\`bash
   curl https://platform-usage.your-subdomain.workers.dev/health
   \`\`\`

4. **Check Gatus** for platform-usage heartbeat status:
   - Visit [Gatus Status Page](${GATUS_URL})
   - Look for \`platform-usage\` heartbeat status

5. **If SDK telemetry issue**, verify the project's wrangler config:
   \`\`\`bash
   # In the project directory, check for queue binding
   grep -r "PLATFORM_TELEMETRY" wrangler*.jsonc
   \`\`\`

### Reference Documentation

- [SDK Integration Guide](https://github.com/${GITHUB_ORG}/platform/blob/main/docs/quickrefs/guides/sdk-integration-checklist.md)
- [Error Collector Integration](https://github.com/${GITHUB_ORG}/platform/blob/main/docs/quickrefs/guides/error-collector-integration.md)
- [Data Flow Architecture](https://github.com/${GITHUB_ORG}/platform/blob/main/docs/quickrefs/data-flow.md)
- [Troubleshooting Guide](https://github.com/${GITHUB_ORG}/platform/blob/main/docs/quickrefs/troubleshooting.md)

---
Generated by [Platform Sentinel](https://github.com/${GITHUB_ORG}/platform/blob/main/workers/platform-sentinel.ts) gap detection
`;
}

/**
 * Process a gap alert event and create a GitHub issue if needed.
 *
 * @returns Result object with issue details or skip reason
 */
export async function processGapAlert(
  event: GapAlertEvent,
  env: Env
): Promise<{
  processed: boolean;
  issueNumber?: number;
  issueUrl?: string;
  skipped?: string;
}> {
  // Check deduplication - only one issue per project per day
  const existingIssue = await checkGapAlertDedup(env.PLATFORM_CACHE, event.project);
  if (existingIssue) {
    console.log(`Gap alert for ${event.project} already created today: #${existingIssue}`);
    return {
      processed: false,
      skipped: `Issue #${existingIssue} already created today for ${event.project}`,
    };
  }

  // Determine the repository to create the issue in
  if (!event.repository) {
    console.warn(`No repository mapping for project ${event.project}`);
    return {
      processed: false,
      skipped: `No repository mapping for project ${event.project}`,
    };
  }

  // Parse owner/repo
  const [owner, repo] = event.repository.split('/');
  if (!owner || !repo) {
    console.error(`Invalid repository format: ${event.repository}`);
    return {
      processed: false,
      skipped: `Invalid repository format: ${event.repository}`,
    };
  }

  // Create GitHub client
  const github = new GitHubClient(env);

  try {
    // Create the issue
    const issue = await github.createIssue({
      owner,
      repo,
      title: `Data Coverage Gap: ${event.project} at ${event.coveragePct}%`,
      body: formatGapAlertBody(event),
      labels: GAP_ALERT_LABELS,
    });

    console.log(`Created gap alert issue #${issue.number} for ${event.project}`);

    // Record deduplication
    await setGapAlertDedup(env.PLATFORM_CACHE, event.project, issue.number);

    // Create dashboard notification for gap alerts (P2 = medium priority)
    if (env.NOTIFICATIONS_API) {
      try {
        await env.NOTIFICATIONS_API.fetch(
          'https://platform-notifications.internal/notifications',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              category: 'gap_alert',
              source: 'platform-sentinel',
              source_id: String(issue.number),
              title: `Data Gap: ${event.project} (${event.coveragePct}%)`,
              description: `Coverage dropped below 90% threshold. ${event.missingHours.length} hours missing.`,
              priority: 'medium',
              action_url: issue.html_url,
              action_label: 'View Issue',
              project: event.project,
            }),
          }
        );
      } catch (e) {
        // Non-blocking - log and continue
        console.error('Failed to create dashboard notification:', e);
      }
    }

    return {
      processed: true,
      issueNumber: issue.number,
      issueUrl: issue.html_url,
    };
  } catch (error) {
    console.error(`Failed to create gap alert issue for ${event.project}:`, error);
    return {
      processed: false,
      skipped: `GitHub API error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
