/**
 * Anomaly Detection Module
 *
 * Functions for detecting usage anomalies using rolling statistics,
 * dataset drift detection, and alerting via Slack.
 * Extracted from platform-usage.ts as part of scheduled task modularisation.
 */

import type { Env, RollingStats } from '../shared';
import { KNOWN_DATASETS, QUERIED_DATASETS, generateId, fetchWithRetry } from '../shared';
import { createLoggerFromEnv } from '@littlebearapps/platform-consumer-sdk';

// =============================================================================
// SLACK ALERTING
// =============================================================================

/**
 * Slack alert payload structure.
 */
interface SlackAlertPayload {
  text: string;
  attachments?: Array<{
    color: string;
    fields: Array<{ title: string; value: string; short?: boolean }>;
  }>;
}

/**
 * Send a Slack alert.
 */
async function sendSlackAlert(env: Env, payload: SlackAlertPayload): Promise<void> {
  if (!env.SLACK_WEBHOOK_URL) return;

  try {
    await fetchWithRetry(env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:slack');
    log.error('Failed to send Slack alert', error instanceof Error ? error : undefined, {
      tag: 'SLACK_ERROR',
    });
  }
}

// =============================================================================
// ROLLING STATISTICS
// =============================================================================

/**
 * Allowed metrics for rolling stats calculation.
 * These metrics can be used in parameterised SQL queries.
 */
const ALLOWED_ROLLING_METRICS = [
  'workers_requests',
  'workers_errors',
  'workers_cost_usd',
  'd1_rows_read',
  'd1_rows_written',
  'd1_cost_usd',
  'kv_reads',
  'kv_writes',
  'kv_cost_usd',
  'r2_class_a_ops',
  'r2_class_b_ops',
  'r2_cost_usd',
  'aigateway_requests',
  'aigateway_cost_usd',
  'workersai_requests',
  'workersai_neurons',
  'workersai_cost_usd',
  'total_cost_usd',
] as const;

type AllowedMetric = (typeof ALLOWED_ROLLING_METRICS)[number];

/**
 * Check if a metric is in the allowed list.
 */
function isAllowedMetric(metric: string): metric is AllowedMetric {
  return ALLOWED_ROLLING_METRICS.includes(metric as AllowedMetric);
}

/**
 * Calculate 7-day rolling statistics for a metric.
 * Uses daily rollups for efficient computation.
 */
export async function calculate7DayRollingStats(
  env: Env,
  metric: string,
  project: string
): Promise<RollingStats | null> {
  if (!isAllowedMetric(metric)) {
    const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:anomaly');
    log.warn('Invalid metric for rolling stats', undefined, {
      tag: 'INVALID_METRIC',
      metric,
    });
    return null;
  }

  try {
    // SQLite doesn't have native STDDEV, so calculate manually using sum and sum of squares
    const result = await env.PLATFORM_DB.prepare(
      `
      SELECT
        COUNT(*) as sample_count,
        SUM(${metric}) as sum_value,
        SUM(${metric} * ${metric}) as sum_squared,
        AVG(${metric}) as avg_value
      FROM daily_usage_rollups
      WHERE project = ?
        AND snapshot_date >= date('now', '-7 days')
        AND snapshot_date < date('now')
    `
    )
      .bind(project)
      .first<{
        sample_count: number;
        sum_value: number;
        sum_squared: number;
        avg_value: number;
      }>();

    if (!result || result.sample_count === 0) {
      return null;
    }

    const n = result.sample_count;
    const avg = result.avg_value;
    // Variance = (sum of squares - n * mean^2) / n
    const variance = (result.sum_squared - n * avg * avg) / n;
    const stddev = Math.sqrt(Math.max(0, variance)); // Ensure non-negative

    return {
      avg,
      stddev,
      samples: n,
    };
  } catch (error) {
    const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:anomaly');
    log.error('Error calculating rolling stats', error instanceof Error ? error : undefined, {
      tag: 'ROLLING_STATS_ERROR',
      metric,
      project,
    });
    return null;
  }
}

// =============================================================================
// TODAY'S METRIC VALUE
// =============================================================================

/**
 * Get today's value for a metric from hourly snapshots.
 */
export async function getTodayMetricValue(
  env: Env,
  metric: string,
  project: string = 'all'
): Promise<number> {
  if (!isAllowedMetric(metric)) {
    return 0;
  }

  try {
    const result = await env.PLATFORM_DB.prepare(
      `
      SELECT SUM(${metric}) as total
      FROM hourly_usage_snapshots
      WHERE project = ?
        AND snapshot_hour >= datetime('now', 'start of day')
        AND snapshot_hour < datetime('now', '+1 day', 'start of day')
    `
    )
      .bind(project)
      .first<{ total: number }>();

    return result?.total ?? 0;
  } catch (error) {
    const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:anomaly');
    log.error('Error getting today metric', error instanceof Error ? error : undefined, {
      tag: 'TODAY_METRIC_ERROR',
      metric,
      project,
    });
    return 0;
  }
}

// =============================================================================
// ANOMALY RECORDING
// =============================================================================

/**
 * Record an anomaly to the D1 database.
 */
export async function recordAnomaly(
  env: Env,
  metric: string,
  currentValue: number,
  stats: RollingStats,
  deviation: number,
  project: string = 'all'
): Promise<void> {
  try {
    await env.PLATFORM_DB.prepare(
      `
      INSERT INTO usage_anomalies (
        id, detected_at, metric_name, project,
        current_value, rolling_avg, rolling_stddev, deviation_factor
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
    )
      .bind(
        generateId(),
        Math.floor(Date.now() / 1000),
        metric,
        project,
        currentValue,
        stats.avg,
        stats.stddev,
        deviation
      )
      .run();
  } catch (error) {
    const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:anomaly');
    log.error('Error recording anomaly', error instanceof Error ? error : undefined, {
      tag: 'RECORD_ANOMALY_ERROR',
      metric,
      project,
    });
  }
}

// =============================================================================
// ANOMALY ALERTING
// =============================================================================

/**
 * Send a Slack alert for detected anomaly.
 */
export async function sendAnomalySlackAlert(
  env: Env,
  metric: string,
  currentValue: number,
  stats: RollingStats,
  deviation: number
): Promise<void> {
  // Determine severity color
  const color = deviation > 5 ? 'danger' : 'warning';

  // Format metric for display
  const metricDisplay = metric.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  // Format values
  const formatValue = (val: number): string => {
    if (metric.includes('cost')) {
      return `$${val.toFixed(4)}`;
    }
    if (val >= 1_000_000) {
      return `${(val / 1_000_000).toFixed(2)}M`;
    }
    if (val >= 1_000) {
      return `${(val / 1_000).toFixed(2)}K`;
    }
    return val.toFixed(2);
  };

  const payload: SlackAlertPayload = {
    text: `:warning: Usage Anomaly Detected`,
    attachments: [
      {
        color,
        fields: [
          { title: 'Metric', value: metricDisplay, short: true },
          { title: 'Deviation', value: `${deviation.toFixed(1)} stddev`, short: true },
          { title: 'Current Value', value: formatValue(currentValue), short: true },
          { title: '7-Day Avg', value: formatValue(stats.avg), short: true },
          { title: 'Stddev', value: formatValue(stats.stddev), short: true },
          { title: 'Samples', value: `${stats.samples} days`, short: true },
        ],
      },
    ],
  };

  await sendSlackAlert(env, payload);
}

// =============================================================================
// ALERT ROUTER INTEGRATION
// =============================================================================

/**
 * Route anomaly alert through the central alert-router.
 * Provides unified Slack alerting + in-app notifications.
 * Falls back to direct Slack webhook if alert-router unavailable.
 */
async function sendAnomalyToAlertRouter(
  env: Env,
  metric: string,
  currentValue: number,
  stats: RollingStats,
  deviation: number,
  project: string = 'all'
): Promise<void> {
  if (!env.ALERT_ROUTER) {
    await sendAnomalySlackAlert(env, metric, currentValue, stats, deviation);
    return;
  }

  const metricDisplay = metric.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const severity = deviation > 5 ? 'p0' : deviation > 3 ? 'p1' : 'p2';

  const formatVal = (val: number): string => {
    if (metric.includes('cost')) return `$${val.toFixed(4)}`;
    if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M`;
    if (val >= 1_000) return `${(val / 1_000).toFixed(2)}K`;
    return val.toFixed(2);
  };

  const payload = {
    source: 'anomaly-detection',
    severity,
    status: 'firing',
    service_id: 'platform-usage',
    summary: `Usage Anomaly: ${metricDisplay} (${deviation.toFixed(1)} stddev)`,
    message: `Current: ${formatVal(currentValue)}, 7-day avg: ${formatVal(stats.avg)}, StdDev: ${formatVal(stats.stddev)}, Project: ${project}`,
    timestamp: new Date().toISOString(),
    metadata: {
      metric,
      project,
      currentValue,
      rollingAvg: stats.avg,
      rollingStddev: stats.stddev,
      deviationFactor: deviation,
      samples: stats.samples,
    },
  };

  try {
    const response = await env.ALERT_ROUTER.fetch(
      // Service binding URL — the hostname is ignored; only the path matters
      'https://platform-alert-router.internal/custom',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );

    if (!response.ok) {
      const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:anomaly');
      log.warn('Alert router returned non-OK, falling back to direct Slack', undefined, {
        tag: 'ALERT_ROUTER_FALLBACK',
        status: response.status,
      });
      await sendAnomalySlackAlert(env, metric, currentValue, stats, deviation);
    }
  } catch (error) {
    const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:anomaly');
    log.error('Alert router failed, falling back to direct Slack', error instanceof Error ? error : undefined, {
      tag: 'ALERT_ROUTER_ERROR',
    });
    await sendAnomalySlackAlert(env, metric, currentValue, stats, deviation);
  }
}

// =============================================================================
// MAIN ANOMALY DETECTION
// =============================================================================

/**
 * Metrics to monitor for anomalies.
 */
const MONITORED_METRICS = [
  'workers_requests',
  'd1_rows_written',
  'total_cost_usd',
  'aigateway_requests',
  'workersai_neurons',
] as const;

/**
 * Projects monitored for per-project anomaly detection.
 * Includes 'all' (aggregate) plus individual projects.
 */
// TODO: Add your project IDs here (must match project_registry in D1)
const MONITORED_PROJECTS = ['all', 'platform'] as const;

/**
 * Run anomaly detection for key metrics across all monitored projects.
 * Called during scheduled runs (typically at midnight).
 *
 * @returns Number of anomalies detected
 */
export async function detectAnomalies(env: Env): Promise<number> {
  let anomaliesDetected = 0;

  for (const project of MONITORED_PROJECTS) {
    for (const metric of MONITORED_METRICS) {
      try {
        const stats = await calculate7DayRollingStats(env, metric, project);

        // Need at least 7 days of data for reliable anomaly detection
        if (!stats || stats.samples < 7) {
          continue;
        }

        const todayValue = await getTodayMetricValue(env, metric, project);

        // Skip if stddev is 0 (no variation in data)
        if (stats.stddev === 0) {
          continue;
        }

        const deviation = (todayValue - stats.avg) / stats.stddev;

        // Detect anomaly if deviation > 3 standard deviations
        if (deviation > 3) {
          const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:anomaly');
          log.info('Anomaly detected', {
            tag: 'ANOMALY_DETECTED',
            metric,
            project,
            todayValue,
            deviation: deviation.toFixed(1),
            avg: stats.avg.toFixed(2),
          });

          await recordAnomaly(env, metric, todayValue, stats, deviation, project);
          await sendAnomalyToAlertRouter(env, metric, todayValue, stats, deviation, project);
          anomaliesDetected++;
        }
      } catch (error) {
        const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:anomaly');
        log.error('Error checking metric for anomaly', error instanceof Error ? error : undefined, {
          tag: 'CHECK_ANOMALY_ERROR',
          metric,
          project,
        });
      }
    }
  }

  return anomaliesDetected;
}

// =============================================================================
// HOURLY D1 WRITE ANOMALY DETECTION
// =============================================================================

/**
 * Calculate rolling stats from hourly snapshots (168 hours = 7 days).
 * Used for hourly anomaly detection where daily rollups are too coarse.
 */
export async function calculateHourlyRollingStats(
  env: Env,
  metric: string,
  project: string
): Promise<RollingStats | null> {
  if (!isAllowedMetric(metric)) {
    return null;
  }

  try {
    const result = await env.PLATFORM_DB.prepare(
      `
      SELECT
        COUNT(*) as sample_count,
        SUM(${metric}) as sum_value,
        SUM(${metric} * ${metric}) as sum_squared,
        AVG(${metric}) as avg_value
      FROM hourly_usage_snapshots
      WHERE project = ?
        AND snapshot_hour >= datetime('now', '-7 days')
        AND snapshot_hour < datetime('now', '-1 hour')
    `
    )
      .bind(project)
      .first<{
        sample_count: number;
        sum_value: number;
        sum_squared: number;
        avg_value: number;
      }>();

    if (!result || result.sample_count < 48) {
      return null; // Need at least 2 days of hourly data
    }

    const n = result.sample_count;
    const avg = result.avg_value;
    const variance = (result.sum_squared - n * avg * avg) / n;
    const stddev = Math.sqrt(Math.max(0, variance));

    return { avg, stddev, samples: n };
  } catch (error) {
    const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:anomaly');
    log.error('Error calculating hourly rolling stats', error instanceof Error ? error : undefined, {
      tag: 'HOURLY_ROLLING_STATS_ERROR',
      metric,
      project,
    });
    return null;
  }
}

/**
 * Hourly D1 write anomaly check.
 * Runs every hour to catch write spikes within hours, not days.
 * Only checks d1_rows_written (highest-risk metric from Jan 2026 incident).
 *
 * @returns Number of anomalies detected (0 or 1)
 */
export async function detectHourlyD1WriteAnomalies(env: Env): Promise<number> {
  const metric = 'd1_rows_written';
  const project = 'all';
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:anomaly');

  try {
    // Get the last completed hour's value
    const lastHourResult = await env.PLATFORM_DB.prepare(
      `
      SELECT ${metric} as value
      FROM hourly_usage_snapshots
      WHERE project = ?
        AND snapshot_hour >= datetime('now', '-2 hours')
        AND snapshot_hour < datetime('now', '-1 hour')
      ORDER BY snapshot_hour DESC
      LIMIT 1
    `
    )
      .bind(project)
      .first<{ value: number }>();

    if (!lastHourResult || lastHourResult.value === 0) {
      return 0; // No data or zero writes — nothing to flag
    }

    const stats = await calculateHourlyRollingStats(env, metric, project);
    if (!stats || stats.stddev === 0) {
      return 0;
    }

    const deviation = (lastHourResult.value - stats.avg) / stats.stddev;

    if (deviation > 3) {
      log.info('Hourly D1 write anomaly detected', {
        tag: 'HOURLY_D1_ANOMALY',
        value: lastHourResult.value,
        deviation: deviation.toFixed(1),
        avg: stats.avg.toFixed(2),
        stddev: stats.stddev.toFixed(2),
      });

      await recordAnomaly(env, metric, lastHourResult.value, stats, deviation, project);
      await sendAnomalyToAlertRouter(env, metric, lastHourResult.value, stats, deviation, project);
      return 1;
    }

    return 0;
  } catch (error) {
    log.error('Error in hourly D1 write anomaly check', error instanceof Error ? error : undefined, {
      tag: 'HOURLY_D1_CHECK_ERROR',
    });
    return 0;
  }
}

// =============================================================================
// DATASET REGISTRY - Drift Detection for Cloudflare GraphQL Datasets
// =============================================================================

/**
 * Probe a single GraphQL dataset to check if it's available.
 * Returns true if the dataset exists and is queryable.
 */
export async function probeDataset(env: Env, datasetName: string): Promise<boolean> {
  const GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);

  // Build a minimal probe query
  const query = `
    query ProbeDataset($accountTag: String!, $limit: Int!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          ${datasetName}(limit: $limit, filter: {
            datetime_geq: "${yesterday.toISOString().split('T')[0]}T00:00:00Z",
            datetime_leq: "${now.toISOString().split('T')[0]}T00:00:00Z"
          }) {
            dimensions {
              datetime
            }
          }
        }
      }
    }
  `;

  try {
    const response = await fetchWithRetry(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      },
      body: JSON.stringify({
        query,
        variables: {
          accountTag: env.CLOUDFLARE_ACCOUNT_ID,
          limit: 1,
        },
      }),
    });

    if (!response.ok) {
      return false;
    }

    const result = (await response.json()) as { errors?: Array<{ message: string }> };

    // Check for GraphQL errors indicating dataset doesn't exist
    if (result.errors) {
      const errorStr = JSON.stringify(result.errors);
      if (
        errorStr.includes('Cannot query field') ||
        errorStr.includes('Unknown field') ||
        errorStr.includes('not enabled') ||
        errorStr.includes('not available')
      ) {
        return false;
      }
    }

    return true;
  } catch {
    // Network errors or other issues - assume unavailable
    return false;
  }
}

/**
 * Discover and update the dataset registry.
 * Probes known datasets, updates last_seen, and alerts on new billable datasets.
 *
 * @returns Object with counts of datasets checked and alerts generated
 */
export async function discoverAndUpdateDatasetRegistry(
  env: Env
): Promise<{ datasetsChecked: number; newBillableAlerts: number; d1Writes: number }> {
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:dataset-registry');
  log.info('Starting weekly dataset discovery');

  let datasetsChecked = 0;
  let newBillableAlerts = 0;
  let d1Writes = 0;
  const now = new Date().toISOString();

  for (const dataset of KNOWN_DATASETS) {
    const available = await probeDataset(env, dataset.name);
    datasetsChecked++;

    if (available) {
      // Update last_seen for this dataset
      try {
        await env.PLATFORM_DB.prepare(
          `
          INSERT INTO dataset_registry (dataset_name, first_seen, last_seen, is_queried, is_billable, category, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (dataset_name) DO UPDATE SET
            last_seen = excluded.last_seen,
            updated_at = excluded.updated_at
        `
        )
          .bind(
            dataset.name,
            now,
            now,
            QUERIED_DATASETS.has(dataset.name) ? 1 : 0,
            dataset.billable ? 1 : 0,
            dataset.category,
            now,
            now
          )
          .run();
        d1Writes++;

        // Alert if this is a billable dataset we're not querying
        if (dataset.billable && !QUERIED_DATASETS.has(dataset.name)) {
          log.info('Available billable dataset not queried', { dataset: dataset.name });
          newBillableAlerts++;

          // Send Slack alert for new billable dataset
          if (env.SLACK_WEBHOOK_URL) {
            await sendSlackAlert(env, {
              text: ':warning: Billable Dataset Not Queried',
              attachments: [
                {
                  color: 'warning',
                  fields: [
                    { title: 'Dataset', value: dataset.name, short: true },
                    { title: 'Category', value: dataset.category, short: true },
                    {
                      title: 'Action Required',
                      value: 'Consider adding query for accurate cost tracking',
                      short: false,
                    },
                  ],
                },
              ],
            });
          }
        }
      } catch (error) {
        log.error(`Error updating ${dataset.name}`, error instanceof Error ? error : undefined);
      }
    }

    // Small delay between probes to avoid rate limiting
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  log.info('Discovery complete', { datasetsChecked, newBillableAlerts, d1Writes });

  return { datasetsChecked, newBillableAlerts, d1Writes };
}
