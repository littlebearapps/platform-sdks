/**
 * Alert Router Worker
 *
 * Consolidates alerts from multiple monitoring sources:
 * - Gatus (uptime monitors + heartbeats -- primary)
 * - HetrixTools (external HTTP checks)
 * - Netdata (VPS internal metrics)
 * - GitHub Actions (deployment failures)
 *
 * Features:
 * - Alert normalization (common event format)
 * - Deduplication (KV-based, 1-hour TTL)
 * - Dependency correlation (suppress child alerts when parent down)
 * - Priority-based routing (Slack channels + in-app notifications)
 * - Incident grouping (related alerts)
 *
 * Cost: $0/month (within Workers free tier)
 */

import {
  withFeatureBudget,
  CircuitBreakerError,
  completeTracking,
  MONITOR_ALERT_ROUTER,
  createLoggerFromRequest,
  type Logger,
} from '@littlebearapps/platform-consumer-sdk';

interface Env {
  PLATFORM_DB: D1Database;
  PLATFORM_CACHE: KVNamespace;
  PLATFORM_ALERTS: KVNamespace; // For deduplication
  SLACK_WEBHOOK_URL: string;
  SERVICE_REGISTRY: KVNamespace; // Cached service registry
  GITHUB_TOKEN: string; // For issue creation
  PLATFORM_TELEMETRY: Queue; // For SDK telemetry
  NOTIFICATIONS_API: Fetcher; // In-app notifications via platform-notifications
  CLOUDFLARE_ACCOUNT_ID: string;
  // Dashboard URL for action links (e.g. "https://admin.example.com")
  DASHBOARD_URL?: string;
  // Gatus status page URL (e.g. "https://status.example.com")
  GATUS_URL?: string;
}

interface Alert {
  id: string; // Generated UUID
  source: 'hetrixtools' | 'netdata' | 'github' | 'github-security' | 'gatus' | 'custom';
  severity: 'p0' | 'p1' | 'p2'; // Critical, High, Medium
  status: 'firing' | 'resolved';
  service_id: string; // Maps to service registry
  monitor_id?: string; // Source-specific monitor ID
  summary: string; // Short description
  message: string; // Detailed message
  timestamp: string; // ISO 8601
  metadata?: Record<string, any>; // Source-specific data
}

interface NormalizedIncident {
  incident_key: string; // For deduplication
  alert: Alert;
  parent_down: boolean; // If dependency is down
  suppressed: boolean; // If alert should be suppressed
  baseline_suppressed?: boolean; // If CodeQL baseline alert (48h window)
  related_alerts: string[]; // Other alerts in same incident
}

// Webhook payload interfaces
interface HetrixToolsPayload {
  monitor_id: string;
  monitor_name: string;
  monitor_target: string;
  monitor_type: string; // 'website' | 'ping' | 'service[X]' | 'smtp[X]'
  monitor_category: string;
  monitor_status: string; // 'online' | 'offline'
  timestamp: number; // UNIX timestamp
  monitor_errors?: Record<string, string>; // location -> error message (only when offline)
}

interface NetdataPayload {
  status: string; // 'WARNING' | 'CRITICAL' | 'CLEAR'
  alarm: string;
  chart: string;
  info: string;
  family?: string;
  host: string;
  value: string;
  units?: string;
}

interface GatusWebhookPayload {
  endpoint_name: string;
  endpoint_group: string;
  endpoint_url: string;
  alert_description: string;
  resolved: boolean;
}

/**
 * Parse Gatus default template body format (non-JSON with [PLACEHOLDER] syntax).
 * Extracts key-value pairs from lines like: "endpoint_name": [ENDPOINT_NAME]
 */
function parseGatusTemplateBody(body: string): GatusWebhookPayload {
  const extract = (key: string): string => {
    const match = body.match(new RegExp(`"${key}"\\s*:\\s*(.+)`));
    return match ? match[1].trim().replace(/^"/, '').replace(/"$/, '').replace(/,\s*$/, '') : '';
  };

  // Gatus substitutes [RESOLVED] as true/false text, or the literal [RESOLVED]/[NOT_RESOLVED]
  const resolvedRaw = extract('resolved');
  const resolved = resolvedRaw === 'true' || resolvedRaw === '[RESOLVED]';

  return {
    endpoint_name: extract('endpoint_name'),
    endpoint_group: extract('endpoint_group'),
    endpoint_url: extract('endpoint_url'),
    alert_description: extract('alert_description'),
    resolved,
  };
}

interface GitHubActionsPayload {
  event: string;
  service: string;
  status: string; // 'failure' | 'success'
  commit: string;
  workflow: string;
  timestamp: string;
}

// Error alert payload from platform-usage worker
interface ErrorAlertPayload {
  type: 'p0_immediate' | 'p1_digest' | 'p2_summary';
  feature_key: string; // e.g. 'my-project:scanner:github'
  project: string;
  category: string;
  feature: string;
  worker?: string;
  correlation_id?: string;

  // P0 fields
  error_category?: string; // 'CIRCUIT_BREAKER', 'NETWORK', etc.
  error_code?: string;
  error_message?: string;
  error_rate?: number; // Percentage 0-100
  window_minutes?: number;

  // P1/P2 digest fields
  total_errors?: number;
  distinct_types?: number;
  top_errors?: Array<{
    feature_key: string;
    error_category: string;
    count: number;
  }>;
  period_start?: string;
  period_end?: string;
}

interface GitHubCodeScanningPayload {
  action: string; // 'created' | 'reopened' | 'closed_by_user' | 'fixed' | 'appeared_in_branch' | 'closed_by_push'
  alert: {
    number: number;
    created_at: string;
    updated_at?: string;
    url: string;
    html_url: string;
    state: string; // 'open' | 'dismissed' | 'fixed'
    dismissed_by?: any;
    dismissed_at?: string;
    dismissed_reason?: string;
    rule: {
      id: string;
      severity: string; // 'error' | 'warning' | 'note'
      security_severity_level?: string; // 'critical' | 'high' | 'medium' | 'low'
      description: string;
      name?: string;
      tags?: string[];
    };
    tool: {
      name: string; // 'CodeQL'
      version?: string;
    };
    most_recent_instance: {
      ref: string;
      state: string;
      commit_sha: string;
      message: {
        text: string;
      };
      location: {
        path: string;
        start_line?: number;
        end_line?: number;
      };
    };
  };
  repository: {
    id: number;
    name: string;
    full_name: string;
    html_url: string;
  };
  sender: {
    login: string;
  };
}

/**
 * Helper: get dashboard URL from env or fallback
 */
function getDashboardUrl(env: Env): string {
  return env.DASHBOARD_URL || '/dashboard';
}

/**
 * Helper: get Gatus status page URL from env or fallback
 */
function getGatusUrl(env: Env): string {
  return env.GATUS_URL || '';
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check - bypass SDK for lightweight endpoint
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', service: 'alert-router' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Create structured logger
    const log = createLoggerFromRequest(request, env, 'alert-router', MONITOR_ALERT_ROUTER);

    // Capture raw Fetcher BEFORE SDK proxying -- the triple-layer Proxy in
    // withFeatureBudget() wraps Fetcher.fetch() in an async wrapper that causes
    // "Illegal invocation" on Cloudflare's native service bindings.
    const notificationsApi = env.NOTIFICATIONS_API;

    // Wrap with SDK tracking for all alert processing
    try {
      const trackedEnv = withFeatureBudget(env, MONITOR_ALERT_ROUTER, { ctx });

      let response: Response;

      // Route by source
      if (url.pathname === '/gatus') {
        response = await handleGatus(request, trackedEnv, log, notificationsApi);
      } else if (url.pathname === '/hetrixtools') {
        response = await handleHetrixTools(request, trackedEnv, log, notificationsApi);
      } else if (url.pathname === '/netdata') {
        response = await handleNetdata(request, trackedEnv, log, notificationsApi);
      } else if (url.pathname === '/github/code-scanning') {
        response = await handleGitHubCodeScanning(request, trackedEnv, log, notificationsApi);
      } else if (url.pathname === '/github') {
        response = await handleGitHubActions(request, trackedEnv, log, notificationsApi);
      } else if (url.pathname === '/errors') {
        response = await handleErrorAlert(request, trackedEnv, log, notificationsApi);
      } else if (url.pathname === '/custom') {
        response = await handleCustomAlert(request, trackedEnv, log, notificationsApi);
      } else {
        response = new Response('Alert Router Worker', { status: 200 });
      }

      await completeTracking(trackedEnv);
      return response;
    } catch (e) {
      if (e instanceof CircuitBreakerError) {
        log.warn('Circuit breaker STOP', e, { reason: e.reason });
        return new Response(
          JSON.stringify({
            error: 'Service temporarily unavailable',
            reason: e.reason,
          }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
      }
      throw e;
    }
  },
};

/**
 * Handle HetrixTools webhook (HTTP uptime monitoring)
 */
async function handleHetrixTools(request: Request, env: Env, log: Logger, notificationsApi?: Fetcher): Promise<Response> {
  try {
    const payload = (await request.json()) as HetrixToolsPayload;

    // Build error message from location-specific errors
    let errorMessage = 'No details provided';
    if (payload.monitor_errors && Object.keys(payload.monitor_errors).length > 0) {
      errorMessage = Object.entries(payload.monitor_errors)
        .map(([location, error]) => `${location}: ${error}`)
        .join(', ');
    }

    // Extract service_id from monitor_name: "Platform: error-collector /health" -> "error-collector"
    const serviceId = extractHetrixToolsServiceId(payload.monitor_name);

    const alert: Alert = {
      id: crypto.randomUUID(),
      source: 'hetrixtools',
      severity: payload.monitor_status === 'offline' ? 'p1' : 'p2',
      status: payload.monitor_status === 'offline' ? 'firing' : 'resolved',
      service_id: serviceId,
      monitor_id: payload.monitor_id,
      summary: `${payload.monitor_name}: ${payload.monitor_status}`,
      message: errorMessage,
      timestamp: new Date(payload.timestamp * 1000).toISOString(),
      metadata: {
        monitorTarget: payload.monitor_target,
        monitorType: payload.monitor_type,
        monitorCategory: payload.monitor_category,
        monitorErrors: payload.monitor_errors,
        rawPayload: payload,
      },
    };

    const incident = await processAlert(alert, env, log);
    await routeAlert(incident, env, log, notificationsApi);

    log.info('HetrixTools alert processed', {
      incident_key: incident.incident_key,
      status: alert.status,
    });

    return new Response(JSON.stringify({ status: 'processed', incident }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    log.error('HetrixTools webhook error', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Handle Netdata webhook
 */
async function handleNetdata(request: Request, env: Env, log: Logger, notificationsApi?: Fetcher): Promise<Response> {
  try {
    const payload = (await request.json()) as NetdataPayload;

    const alert: Alert = {
      id: crypto.randomUUID(),
      source: 'netdata',
      severity: payload.status === 'CRITICAL' ? 'p0' : payload.status === 'WARNING' ? 'p1' : 'p2',
      status: payload.status === 'CLEAR' ? 'resolved' : 'firing',
      service_id: extractNetdataServiceId(payload.alarm, payload.host),
      monitor_id: `${payload.host}:${payload.alarm}`,
      summary: `${payload.alarm} on ${payload.host}`,
      message: `${payload.info} (value: ${payload.value}${payload.units})`,
      timestamp: new Date().toISOString(),
      metadata: {
        chart: payload.chart,
        family: payload.family,
        rawPayload: payload,
      },
    };

    const incident = await processAlert(alert, env, log);
    await routeAlert(incident, env, log, notificationsApi);

    log.info('Netdata alert processed', {
      incident_key: incident.incident_key,
      status: alert.status,
    });

    return new Response(JSON.stringify({ status: 'processed', incident }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    log.error('Netdata webhook error', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Handle Gatus custom webhook alert
 *
 * Gatus sends alerts via its custom alerting provider when endpoints go down/up.
 * Payload template is configured in your Gatus config.yaml.
 */
async function handleGatus(request: Request, env: Env, log: Logger, notificationsApi?: Fetcher): Promise<Response> {
  try {
    // Parse body defensively - Gatus may send non-JSON with [PLACEHOLDER] syntax
    const bodyText = await request.text();
    let payload: GatusWebhookPayload;
    try {
      payload = JSON.parse(bodyText) as GatusWebhookPayload;
    } catch {
      // Gatus default template uses [RESOLVED], [ENDPOINT_NAME] etc. - not valid JSON
      log.warn('Gatus sent non-JSON body, parsing as template format', undefined, {
        bodyPreview: bodyText.slice(0, 200),
      });
      payload = parseGatusTemplateBody(bodyText);
    }

    const isHeartbeat = payload.endpoint_group === 'heartbeats';
    const isDown = !payload.resolved;
    const name = payload.endpoint_name || 'Unknown endpoint';

    const alert: Alert = {
      id: crypto.randomUUID(),
      source: 'gatus',
      severity: isDown ? (isHeartbeat ? 'p0' : 'p1') : 'p2',
      status: isDown ? 'firing' : 'resolved',
      service_id: extractGatusServiceId(name),
      monitor_id: `gatus:${payload.endpoint_group}:${name}`,
      summary: `${name}: ${isDown ? 'DOWN' : 'UP'}`,
      message: payload.alert_description || `Endpoint status: ${isDown ? 'down' : 'up'}`,
      timestamp: new Date().toISOString(),
      metadata: {
        endpointUrl: payload.endpoint_url,
        endpointGroup: payload.endpoint_group,
        rawPayload: payload,
      },
    };

    const incident = await processAlert(alert, env, log);
    await routeAlert(incident, env, log, notificationsApi);

    log.info('Gatus alert processed', {
      incident_key: incident.incident_key,
      status: alert.status,
    });

    return new Response(JSON.stringify({ status: 'processed', incident }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    log.error('Gatus webhook error', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Handle GitHub Actions webhook
 */
async function handleGitHubActions(request: Request, env: Env, log: Logger, notificationsApi?: Fetcher): Promise<Response> {
  try {
    const payload = (await request.json()) as GitHubActionsPayload;

    const alert: Alert = {
      id: crypto.randomUUID(),
      source: 'github',
      severity: 'p0', // Deployment failures are critical
      status: payload.status === 'failure' ? 'firing' : 'resolved',
      service_id: payload.service,
      monitor_id: `github:${payload.service}:${payload.event}`,
      summary: `${payload.workflow} failed for ${payload.service}`,
      message: `Commit: ${payload.commit}`,
      timestamp: payload.timestamp,
      metadata: {
        workflow: payload.workflow,
        commit: payload.commit,
        rawPayload: payload,
      },
    };

    const incident = await processAlert(alert, env, log);
    await routeAlert(incident, env, log, notificationsApi);

    log.info('GitHub Actions alert processed', {
      incident_key: incident.incident_key,
      status: alert.status,
    });

    return new Response(JSON.stringify({ status: 'processed', incident }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    log.error('GitHub Actions webhook error', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Handle GitHub Code Scanning webhook (CodeQL, etc.)
 */
async function handleGitHubCodeScanning(
  request: Request,
  env: Env,
  log: Logger,
  notificationsApi?: Fetcher
): Promise<Response> {
  try {
    const payload = (await request.json()) as GitHubCodeScanningPayload;

    // Map CodeQL severity to Platform severity
    const securityLevel =
      payload.alert.rule.security_severity_level ||
      (payload.alert.rule.severity === 'error' ? 'high' : 'medium');

    const severity = mapCodeQLSeverity(securityLevel);

    // Determine status from action
    const status = mapCodeQLAction(payload.action);

    // Extract repository name for service_id
    const repoName = payload.repository.name;
    const serviceId = `github-${repoName}`;

    // Build alert summary
    const location = payload.alert.most_recent_instance?.location?.path || 'unknown';
    const line = payload.alert.most_recent_instance?.location?.start_line || 0;
    const ruleName = payload.alert.rule.name || payload.alert.rule.id;

    const alert: Alert = {
      id: crypto.randomUUID(),
      source: 'github-security',
      severity,
      status,
      service_id: serviceId,
      monitor_id: `codeql:${payload.repository.full_name}:${payload.alert.number}`,
      summary: `CodeQL: ${ruleName} in ${location}${line > 0 ? `:${line}` : ''}`,
      message: payload.alert.rule.description,
      timestamp: payload.alert.created_at,
      metadata: {
        repository: payload.repository.full_name,
        alert_number: payload.alert.number,
        rule_id: payload.alert.rule.id,
        security_level: securityLevel,
        html_url: payload.alert.html_url,
        tool: payload.alert.tool.name,
        action: payload.action,
        location: {
          path: location,
          line: line,
        },
        rawPayload: payload,
      },
    };

    // Check 48h silent window for baseline suppression
    const silentWindowKey = `codeql-scan-start:${payload.repository.full_name}`;
    const scanStartTime = await env.PLATFORM_ALERTS.get(silentWindowKey);

    let baselineSuppressed = false;

    if (!scanStartTime && status === 'firing') {
      // First time seeing alerts from this repo - start 48h window
      await env.PLATFORM_ALERTS.put(silentWindowKey, new Date().toISOString(), {
        expirationTtl: 48 * 3600, // 48 hours
      });
      baselineSuppressed = true;
      log.info('Started 48h silent window', { repository: payload.repository.full_name });
    } else if (scanStartTime && status === 'firing') {
      // Check if we're still within 48h window
      const startTime = new Date(scanStartTime).getTime();
      const now = new Date().getTime();
      const hoursSinceStart = (now - startTime) / (1000 * 3600);

      if (hoursSinceStart < 48) {
        baselineSuppressed = true;
        log.info('Suppressing baseline alert', {
          repository: payload.repository.full_name,
          hours_since_start: hoursSinceStart.toFixed(1),
        });
      }
    }

    // Add baseline suppression to metadata
    if (baselineSuppressed) {
      if (!alert.metadata) alert.metadata = {};
      alert.metadata.baseline_suppressed = true;
      alert.metadata.suppression_reason = 'Within 48h of first CodeQL scan (baseline alerts)';
    }

    const incident = await processAlert(alert, env, log, baselineSuppressed);

    // Only route to Slack if not baseline-suppressed
    if (!baselineSuppressed) {
      await routeAlert(incident, env, log, notificationsApi);

      // Create GitHub Issue for P0 alerts
      if (severity === 'p0' && status === 'firing') {
        await createGitHubIssue(alert, payload, env, log);
      }
    }

    log.info('GitHub Code Scanning alert processed', {
      incident_key: incident.incident_key,
      status: alert.status,
      baseline_suppressed: baselineSuppressed,
    });

    return new Response(
      JSON.stringify({
        status: 'processed',
        incident,
        baseline_suppressed: baselineSuppressed,
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    log.error('GitHub Code Scanning webhook error', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Map CodeQL security severity to Platform severity
 */
function mapCodeQLSeverity(securityLevel: string): 'p0' | 'p1' | 'p2' {
  const mapping: Record<string, 'p0' | 'p1' | 'p2'> = {
    critical: 'p0',
    high: 'p0',
    medium: 'p1',
    low: 'p2',
    warning: 'p2',
    note: 'p2',
  };

  return mapping[securityLevel.toLowerCase()] || 'p1';
}

/**
 * Map CodeQL action to alert status
 */
function mapCodeQLAction(action: string): 'firing' | 'resolved' {
  const firingActions = ['created', 'reopened', 'appeared_in_branch'];
  const resolvedActions = ['closed_by_user', 'fixed', 'closed_by_push'];

  if (firingActions.includes(action)) {
    return 'firing';
  } else if (resolvedActions.includes(action)) {
    return 'resolved';
  }

  // Default to firing for unknown actions
  return 'firing';
}

/**
 * Handle error alerts from platform-usage worker
 *
 * Routes:
 * - P0: Immediate alert (circuit breaker, >50% error rate)
 * - P1: Hourly digest (>20% error rate, >100 errors)
 * - P2: Daily summary
 */
async function handleErrorAlert(request: Request, env: Env, log: Logger, notificationsApi?: Fetcher): Promise<Response> {
  try {
    const payload = (await request.json()) as ErrorAlertPayload;
    log.info('Processing error alert', { type: payload.type, feature_key: payload.feature_key });

    // Check deduplication for P0 alerts
    if (payload.type === 'p0_immediate') {
      const dedupeKey = `error:${payload.feature_key}:${payload.error_category}:${Math.floor(Date.now() / 3600000)}`;
      const existing = await env.PLATFORM_ALERTS.get(dedupeKey);
      if (existing) {
        log.info('Error alert deduplicated', { dedupe_key: dedupeKey });
        return new Response(JSON.stringify({ status: 'deduplicated', key: dedupeKey }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Store with TTL based on priority
      await env.PLATFORM_ALERTS.put(dedupeKey, JSON.stringify(payload), {
        expirationTtl: 3600, // 1 hour for P0
      });
    }

    // Build and send Slack message
    const slackMessage = buildErrorSlackMessage(payload, env);

    const response = await fetch(env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slackMessage),
    });

    if (!response.ok) {
      throw new Error(`Slack webhook failed: ${response.status}`);
    }

    // Store in D1 for historical analysis
    await storeErrorAlertInD1(payload, env, log);

    // Create in-app notification (uses raw Fetcher, not proxied env)
    if (notificationsApi) {
      const dashboardUrl = getDashboardUrl(env);
      const priorityMap: Record<string, string> = {
        p0_immediate: 'critical',
        p1_digest: 'high',
        p2_summary: 'medium',
      };
      const categoryMap: Record<string, string> = {
        p0_immediate: 'error',
        p1_digest: 'warning',
        p2_summary: 'info',
      };
      try {
        await notificationsApi.fetch(
          'https://platform-notifications/notifications',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              category: categoryMap[payload.type] || 'warning',
              source: 'alert-router:error',
              source_id: payload.correlation_id || `error-${Date.now()}`,
              title: payload.type === 'p0_immediate'
                ? `P0 Error: ${payload.feature_key}`
                : payload.type === 'p1_digest'
                  ? `Error Digest: ${payload.total_errors} errors`
                  : `Daily Summary: ${payload.total_errors} errors`,
              description: payload.error_message?.slice(0, 500) || `${payload.total_errors || 1} errors detected`,
              priority: priorityMap[payload.type] || 'medium',
              action_url: `${dashboardUrl}/errors`,
              action_label: 'View Errors',
              project: payload.project,
            }),
          }
        );
      } catch (error) {
        log.error('Failed to create error notification', error);
      }
    }

    return new Response(JSON.stringify({ status: 'processed', type: payload.type }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    log.error('Error alert processing failed', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Build Slack message for error alerts with rich investigation context
 */
function buildErrorSlackMessage(payload: ErrorAlertPayload, env: Env): Record<string, unknown> {
  const timestamp = new Date().toISOString();
  const dashboardUrl = getDashboardUrl(env);

  // Dashboard and observability URLs
  const monitorUrl = `${dashboardUrl}/usage/monitor`;
  const observabilityUrl = `https://dash.cloudflare.com/?to=/:account/workers/observability`;
  const featureKey = payload.feature_key;

  if (payload.type === 'p0_immediate') {
    // P0: Critical immediate alert with full context
    const isCircuitBreaker = payload.error_category === 'CIRCUIT_BREAKER';
    const emoji = isCircuitBreaker ? '🔴' : '🚨';
    const title = isCircuitBreaker
      ? `Circuit Breaker Tripped: ${featureKey}`
      : `High Error Rate: ${featureKey}`;

    return {
      text: `${emoji} [P0] ${title}`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: `${emoji} [P0] ${title}`,
            emoji: true,
          },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Feature:*\n\`${featureKey}\`` },
            { type: 'mrkdwn', text: `*Error Category:*\n${payload.error_category || 'Unknown'}` },
            { type: 'mrkdwn', text: `*Error Code:*\n${payload.error_code || 'N/A'}` },
            {
              type: 'mrkdwn',
              text: `*Error Rate:*\n${payload.error_rate?.toFixed(1)}% (last ${payload.window_minutes}min)`,
            },
            { type: 'mrkdwn', text: `*Worker:*\n${payload.worker || 'Unknown'}` },
            { type: 'mrkdwn', text: `*Time:*\n${timestamp}` },
          ],
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Error Message:*\n\`\`\`${(payload.error_message || 'No message available').slice(0, 500)}\`\`\``,
          },
        },
        {
          type: 'divider',
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              `*Investigation Context*\n` +
              `• *Correlation ID:* \`${payload.correlation_id || 'N/A'}\`\n` +
              `• *Project:* ${payload.project} | *Category:* ${payload.category} | *Feature:* ${payload.feature}\n` +
              `• *Pattern:* Check if this is a recurring failure or new issue`,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              `*Suggested Investigation Steps*\n` +
              `1. Check Workers Observability for recent logs with correlation ID\n` +
              `2. Review feature budget status in dashboard\n` +
              `3. Check if upstream dependencies are healthy\n` +
              `4. Look for recent deployments or config changes\n` +
              isCircuitBreaker
                ? `5. If safe, reset circuit breaker: \`KV delete CIRCUIT:${featureKey}:state\``
                : `5. Consider increasing error budget threshold if expected`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Usage Monitor', emoji: true },
              url: monitorUrl,
              action_id: 'open_dashboard',
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Workers Observability', emoji: true },
              url: observabilityUrl,
              action_id: 'open_observability',
            },
          ],
        },
      ],
      attachments: [
        {
          color: 'danger',
          footer: `Platform Alert Router | Feature: ${featureKey}`,
          ts: Math.floor(Date.now() / 1000),
        },
      ],
    };
  } else if (payload.type === 'p1_digest') {
    // P1: Hourly digest with aggregated errors
    return {
      text: `[P1] Error Digest: ${payload.total_errors} errors (last hour)`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: `[P1] Hourly Error Digest`,
            emoji: true,
          },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Total Errors:*\n${payload.total_errors}` },
            { type: 'mrkdwn', text: `*Distinct Types:*\n${payload.distinct_types}` },
            { type: 'mrkdwn', text: `*Period:*\n${payload.period_start} - ${payload.period_end}` },
          ],
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              '*Top Errors:*\n' +
              (payload.top_errors || [])
                .slice(0, 5)
                .map((e, i) => `${i + 1}. \`${e.feature_key}\` - ${e.error_category} (${e.count})`)
                .join('\n'),
          },
        },
        {
          type: 'divider',
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              `*Investigation Context*\n` +
              `• Review the top error features for patterns\n` +
              `• Check if errors correlate with traffic spikes\n` +
              `• Look for common error categories across features`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Usage Monitor', emoji: true },
              url: monitorUrl,
              action_id: 'open_dashboard',
            },
          ],
        },
      ],
      attachments: [
        {
          color: 'warning',
          footer: 'Platform Alert Router | Hourly Digest',
          ts: Math.floor(Date.now() / 1000),
        },
      ],
    };
  } else {
    // P2: Daily summary
    return {
      text: `[P2] Daily Error Summary: ${payload.total_errors} errors`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: `[P2] Daily Error Summary`,
            emoji: true,
          },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Total Errors:*\n${payload.total_errors}` },
            { type: 'mrkdwn', text: `*Features Affected:*\n${payload.distinct_types}` },
            { type: 'mrkdwn', text: `*Period:*\n${payload.period_start} - ${payload.period_end}` },
          ],
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              '*Error Breakdown:*\n' +
              (payload.top_errors || [])
                .map((e, i) => `${i + 1}. \`${e.feature_key}\` - ${e.error_category} (${e.count})`)
                .join('\n'),
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `_Low-priority errors aggregated for review. No immediate action required._`,
            },
          ],
        },
      ],
      attachments: [
        {
          color: '#439FE0',
          footer: 'Platform Alert Router | Daily Summary',
          ts: Math.floor(Date.now() / 1000),
        },
      ],
    };
  }
}

/**
 * Store error alert in D1 for historical analysis
 */
async function storeErrorAlertInD1(
  payload: ErrorAlertPayload,
  env: Env,
  log: Logger
): Promise<void> {
  try {
    await env.PLATFORM_DB.prepare(
      `INSERT INTO error_alerts (
        feature_key,
        alert_type,
        error_category,
        error_code,
        error_count,
        error_rate,
        correlation_id,
        worker,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        payload.feature_key,
        payload.type,
        payload.error_category || null,
        payload.error_code || null,
        payload.total_errors || 1,
        payload.error_rate || null,
        payload.correlation_id || null,
        payload.worker || null,
        Math.floor(Date.now() / 1000)
      )
      .run();
  } catch (error) {
    log.error('Failed to store error alert in D1', error);
    // Don't fail alert processing if D1 fails
  }
}

/**
 * Create GitHub Issue for P0 CodeQL alert
 */
async function createGitHubIssue(
  alert: Alert,
  payload: GitHubCodeScanningPayload,
  env: Env,
  log: Logger
): Promise<void> {
  try {
    // Extract repo details
    const repo = payload.repository.full_name;
    const [owner, repoName] = repo.split('/');

    // Check for existing issue (idempotency)
    const existingIssue = await findExistingIssue(owner, repoName, alert, env, log);
    if (existingIssue) {
      log.info('Issue already exists for alert', {
        monitor_id: alert.monitor_id,
        issue_number: existingIssue.number,
      });
      return;
    }

    // Build labels
    const labels = buildIssueLabels(alert, payload);

    // Build issue body
    const body = buildIssueBody(alert, payload);

    // Create issue via GitHub API
    const response = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'Platform-Alert-Router/1.0',
      },
      body: JSON.stringify({
        title: `[P0][CodeQL] ${alert.summary}`,
        body: body,
        labels: labels,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      log.error('Failed to create GitHub Issue', { status: response.status, error });
      return;
    }

    const issue = (await response.json()) as { number: number; html_url: string };
    log.info('Created GitHub Issue', {
      issue_number: issue.number,
      monitor_id: alert.monitor_id,
      url: issue.html_url,
    });
  } catch (error) {
    log.error('Failed to create GitHub Issue', error);
    // Don't fail alert processing if issue creation fails
  }
}

/**
 * Build labels for GitHub Issue
 */
function buildIssueLabels(alert: Alert, payload: GitHubCodeScanningPayload): string[] {
  const labels: string[] = [
    'security',
    'codeql',
    `severity/${alert.severity.toUpperCase()}`, // severity/P0
  ];

  // Add rule label (best-effort)
  if (payload.alert.rule?.id) {
    labels.push(`rule/${payload.alert.rule.id}`);
  }

  // Extract CWE from tags (best-effort)
  const cweTags = payload.alert.rule?.tags?.filter((tag: string) =>
    tag.startsWith('external/cwe/')
  );

  if (cweTags && cweTags.length > 0) {
    // Extract first CWE: "external/cwe/cwe-079" -> "cwe/CWE-79"
    const cweMatch = cweTags[0].match(/cwe-(\d+)/i);
    if (cweMatch) {
      labels.push(`cwe/CWE-${cweMatch[1]}`);
    }
  }

  return labels;
}

/**
 * Build issue body with alert details
 */
function buildIssueBody(alert: Alert, payload: GitHubCodeScanningPayload): string {
  const location = alert.metadata?.location as { path: string; line: number };
  const htmlUrl = alert.metadata?.html_url as string;
  const alertNumber = alert.metadata?.alert_number as number;
  const ruleId = alert.metadata?.rule_id as string;

  return `## CodeQL Security Alert

**Severity**: ${alert.severity.toUpperCase()} (${payload.alert.rule.security_severity_level || 'N/A'})
**Rule**: ${ruleId}
**File**: \`${location.path}:${location.line}\`

### Description

${payload.alert.rule.description}

### Remediation

See CodeQL documentation for remediation guidance for rule \`${ruleId}\`.

### Alert Details

- **Alert Number**: #${alertNumber}
- **Created**: ${payload.alert.created_at}
- **Tool**: ${payload.alert.tool.name} ${payload.alert.tool.version || ''}
- **View on GitHub**: ${htmlUrl}

### Fix Workflow

1. Create feature branch: \`git checkout -b fix/codeql-${ruleId}-${alertNumber}\`
2. Open file at line: \`${location.path}:${location.line}\`
3. Apply fix (see remediation guidance above)
4. Run tests: \`npm test\`
5. Commit: \`git commit -m "fix: CodeQL ${ruleId} (alert #${alertNumber})"\`
6. Create PR: \`gh pr create --fill\`
7. Merge and close this issue

---

Auto-created by Platform Alert Router
`;
}

/**
 * Find existing issue for alert (idempotency)
 */
async function findExistingIssue(
  owner: string,
  repo: string,
  alert: Alert,
  env: Env,
  log: Logger
): Promise<{ number: number } | null> {
  try {
    // Search for open issues with codeql label and alert number in title
    const alertNumber = alert.metadata?.alert_number as number;
    const ruleId = alert.metadata?.rule_id as string;

    const query = `repo:${owner}/${repo} is:issue is:open label:codeql "${ruleId}" in:title "${alertNumber}" in:body`;

    const response = await fetch(
      `https://api.github.com/search/issues?q=${encodeURIComponent(query)}`,
      {
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Platform-Alert-Router/1.0',
        },
      }
    );

    if (!response.ok) {
      log.error('Failed to search for existing issues', { status: response.status });
      return null;
    }

    const data = (await response.json()) as {
      items?: Array<{ number: number; title: string; body: string }>;
    };

    // Check if any results match this alert number
    const match = data.items?.find((issue) =>
      issue.body?.includes(`Alert Number**: #${alertNumber}`)
    );

    return match ? { number: match.number } : null;
  } catch (error) {
    log.error('Error searching for existing issues', error);
    return null;
  }
}

/**
 * Handle custom alerts from internal sources (anomaly detection, etc.)
 */
async function handleCustomAlert(request: Request, env: Env, log: Logger, notificationsApi?: Fetcher): Promise<Response> {
  try {
    const payload = (await request.json()) as {
      source: string;
      severity: string;
      status: string;
      service_id: string;
      summary: string;
      message: string;
      timestamp: string;
      metadata?: Record<string, unknown>;
    };

    const alert: Alert = {
      id: crypto.randomUUID(),
      source: 'custom',
      severity: (['p0', 'p1', 'p2'].includes(payload.severity) ? payload.severity : 'p2') as 'p0' | 'p1' | 'p2',
      status: payload.status === 'resolved' ? 'resolved' : 'firing',
      service_id: payload.service_id || 'unknown',
      summary: payload.summary,
      message: payload.message,
      timestamp: payload.timestamp || new Date().toISOString(),
      metadata: {
        ...payload.metadata,
        customSource: payload.source,
      },
    };

    const incident = await processAlert(alert, env, log);
    await routeAlert(incident, env, log, notificationsApi);

    log.info('Custom alert processed', {
      tag: 'CUSTOM_ALERT',
      incident_key: incident.incident_key,
      custom_source: payload.source,
    });

    return new Response(
      JSON.stringify({ status: 'processed', incident_key: incident.incident_key }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    log.error('Custom alert webhook error', error instanceof Error ? error : undefined);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Process alert: deduplicate, correlate, suppress
 */
async function processAlert(
  alert: Alert,
  env: Env,
  log: Logger,
  baselineSuppressed: boolean = false
): Promise<NormalizedIncident> {
  // 1. Generate incident key (for deduplication)
  const incident_key = `${alert.service_id}:${alert.status}:${alert.summary}`;

  // 2. Check deduplication (KV cache)
  const existingIncident = await env.PLATFORM_ALERTS.get(incident_key);
  if (existingIncident && alert.status === 'firing') {
    log.info('Alert deduplicated', { incident_key });
    return JSON.parse(existingIncident);
  }

  // 3. Load service registry (for dependency correlation)
  const serviceRegistry = await loadServiceRegistry(env, log);

  // 4. Check if parent service is down
  const parentDown = await checkParentDown(alert.service_id, serviceRegistry, env, log);

  // 5. Build incident
  const incident: NormalizedIncident = {
    incident_key,
    alert,
    parent_down: parentDown,
    suppressed: parentDown && alert.severity !== 'p0', // Suppress child alerts if parent down (unless P0)
    baseline_suppressed: baselineSuppressed, // CodeQL 48h baseline window suppression
    related_alerts: [],
  };

  // 6. Store in KV (1-hour TTL for deduplication)
  if (alert.status === 'firing') {
    await env.PLATFORM_ALERTS.put(incident_key, JSON.stringify(incident), {
      expirationTtl: 3600, // 1 hour
    });
  } else {
    // Clear resolved alerts
    await env.PLATFORM_ALERTS.delete(incident_key);
  }

  // 7. Store in D1 (historical record)
  await storeIncidentInD1(incident, env, log);

  return incident;
}

/**
 * Load service registry from KV cache
 */
async function loadServiceRegistry(env: Env, log: Logger): Promise<any> {
  const registryJSON = await env.SERVICE_REGISTRY.get('registry:latest');

  if (!registryJSON) {
    log.warn('Service registry not found in KV, using empty registry');
    return { services: [], connections: [] };
  }

  return JSON.parse(registryJSON);
}

/**
 * Check if parent service is down
 */
async function checkParentDown(
  serviceId: string,
  registry: any,
  env: Env,
  log: Logger
): Promise<boolean> {
  // Find service in registry
  const service = registry.services.find((s: any) => s.id === serviceId);

  if (!service || !service.dependencies || service.dependencies.length === 0) {
    return false; // No dependencies
  }

  // Check if any parent dependency has active DOWN alert
  for (const parentId of service.dependencies) {
    const parentIncidentKey = `${parentId}:firing:`;

    // Scan KV for parent incidents
    const keys = await env.PLATFORM_ALERTS.list({ prefix: parentIncidentKey });

    if (keys.keys.length > 0) {
      log.info('Parent service down, suppressing child alert', {
        parent_id: parentId,
        service_id: serviceId,
      });
      return true;
    }
  }

  return false;
}

/**
 * Store incident in D1 for historical analysis
 */
async function storeIncidentInD1(
  incident: NormalizedIncident,
  env: Env,
  log: Logger
): Promise<void> {
  try {
    await env.PLATFORM_DB.prepare(
      `INSERT INTO incidents (
        incident_key,
        source,
        severity,
        status,
        service_id,
        summary,
        message,
        timestamp,
        parent_down,
        suppressed,
        metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        incident.incident_key,
        incident.alert.source,
        incident.alert.severity,
        incident.alert.status,
        incident.alert.service_id,
        incident.alert.summary,
        incident.alert.message,
        incident.alert.timestamp,
        incident.parent_down ? 1 : 0,
        incident.suppressed ? 1 : 0,
        JSON.stringify(incident.alert.metadata)
      )
      .run();
  } catch (error) {
    log.error('Failed to store incident in D1', error);
    // Don't fail alert routing if D1 fails
  }
}

/**
 * Create in-app notification for an incident via platform-notifications.
 * Accepts the raw Fetcher binding directly (not proxied env) to avoid
 * the SDK triple-proxy wrapping Fetcher.fetch() incorrectly.
 */
async function createRouterNotification(
  api: Fetcher | undefined,
  incident: NormalizedIncident,
  env: Env,
  log: Logger
): Promise<void> {
  if (!api) return;

  const { alert } = incident;
  const priorityMap: Record<string, string> = { p0: 'critical', p1: 'high', p2: 'medium' };
  const category = alert.status === 'resolved' ? 'success' : alert.severity === 'p2' ? 'warning' : 'error';

  const project = mapServiceToProject(alert.service_id);
  const actionUrl = getAlertActionUrl(alert, env);

  try {
    const notifResponse = await api.fetch(
      'https://platform-notifications/notifications',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category,
          source: `alert-router:${alert.source}`,
          source_id: alert.id,
          title: alert.summary,
          description: alert.message.slice(0, 500),
          priority: priorityMap[alert.severity] || 'medium',
          action_url: actionUrl,
          action_label: 'Investigate',
          project,
        }),
      }
    );
    if (!notifResponse.ok) {
      const body = await notifResponse.text();
      log.error('Router notification failed', undefined, { status: notifResponse.status, body: body.slice(0, 300) });
    } else {
      log.info('Router notification created', { project, source: alert.source });
    }
  } catch (error) {
    log.error('Failed to create router notification', error);
  }
}

/**
 * Get dashboard action URL based on alert source
 */
function getAlertActionUrl(alert: Alert, env: Env): string {
  const dashboardUrl = getDashboardUrl(env);
  switch (alert.source) {
    case 'hetrixtools':
    case 'gatus':
      return `${dashboardUrl}/infrastructure`;
    case 'github':
      return `${dashboardUrl}/infrastructure`;
    case 'github-security':
      return (alert.metadata?.html_url as string) || `${dashboardUrl}/dashboard`;
    case 'netdata':
      return `${dashboardUrl}/infrastructure`;
    default:
      return `${dashboardUrl}/dashboard`;
  }
}

/**
 * Map service_id to a project name for notification filtering.
 * Customise this function to match your project naming conventions.
 */
function mapServiceToProject(serviceId: string): string {
  // Add your project prefix mappings here, e.g.:
  // if (serviceId.startsWith('my-project')) return 'my-project';
  if (serviceId.startsWith('platform')) return 'platform';
  if (serviceId.startsWith('github-')) return serviceId.replace('github-', '');
  if (serviceId.startsWith('vps-')) return 'infrastructure';
  return serviceId;
}

/**
 * Route alert to Slack and create in-app notification
 */
async function routeAlert(incident: NormalizedIncident, env: Env, log: Logger, notificationsApi?: Fetcher): Promise<void> {
  // Skip suppressed alerts (parent down OR baseline)
  if (incident.suppressed) {
    log.info('Alert suppressed due to parent down', { incident_key: incident.incident_key });
    return;
  }

  if (incident.baseline_suppressed) {
    log.info('Alert suppressed due to CodeQL baseline (48h window)', {
      incident_key: incident.incident_key,
    });
    return;
  }

  const { alert } = incident;

  // Build Slack message
  const color = getSeverityColor(alert.severity, alert.status);
  const emoji = getSeverityEmoji(alert.severity, alert.status);

  // Get investigation context based on alert source
  const investigationContext = getMonitoringInvestigationContext(alert, env);

  const slackMessage = {
    text: `${emoji} [${alert.severity.toUpperCase()}] ${alert.summary}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${emoji} *[${alert.severity.toUpperCase()}] ${alert.summary}*\n\n*Status*: ${alert.status}\n*Service*: ${alert.service_id}\n*Message*: ${alert.message}\n*Source*: ${alert.source}\n*Time*: ${alert.timestamp}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Investigation:*\n\`\`\`${investigationContext.commands}\`\`\``,
        },
      },
      {
        type: 'actions',
        elements: investigationContext.buttons,
      },
    ],
    attachments: [
      {
        color: color,
        fields: [
          {
            title: 'Incident Key',
            value: incident.incident_key,
            short: true,
          },
          {
            title: 'Parent Down',
            value: incident.parent_down ? 'Yes' : 'No',
            short: true,
          },
        ],
      },
    ],
  };

  // Send to Slack
  try {
    const response = await fetch(env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slackMessage),
    });

    if (!response.ok) {
      throw new Error(`Slack webhook failed: ${response.status}`);
    }

    log.info('Alert routed to Slack', { incident_key: incident.incident_key });
  } catch (error) {
    log.error('Failed to send alert to Slack', error);
    // Don't fail alert processing if Slack fails
  }

  // Create in-app notification (non-blocking, independent of Slack success)
  await createRouterNotification(notificationsApi, incident, env, log);
}

/**
 * Helper: Extract service ID from monitor name
 */
function extractServiceId(monitorName: string): string {
  const normalized = monitorName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .split('-')
    .slice(0, 3) // First 3 parts
    .join('-');

  return normalized;
}

/**
 * Helper: Extract service ID from Gatus endpoint name
 */
function extractGatusServiceId(endpointName: string): string {
  return endpointName
    .toLowerCase()
    .replace(/\.com$/, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

/**
 * Helper: Extract service ID from HetrixTools monitor name
 * "Platform: error-collector /health" -> "error-collector"
 * "Platform: platform-usage /health" -> "platform-usage"
 */
function extractHetrixToolsServiceId(monitorName: string): string {
  // Try "Platform: <service> /health" pattern first
  const platformMatch = monitorName.match(/^Platform:\s+(\S+)/i);
  if (platformMatch) {
    return platformMatch[1].toLowerCase();
  }

  // Fallback: normalise from monitor name
  return extractServiceId(monitorName);
}

/**
 * Helper: Extract service ID from Netdata alarm.
 * Customise the service-specific alarm detection for your projects.
 */
function extractNetdataServiceId(alarm: string, host: string): string {
  // Add your service-specific alarm mappings here, e.g.:
  // if (alarm.includes('myservice')) return 'my-service';

  // VPS-level alarms: "cpu_usage_high" -> "vps-<host>"
  return `vps-${host}`;
}

/**
 * Helper: Get Slack color for severity
 */
function getSeverityColor(severity: string, status: string): string {
  if (status === 'resolved') {
    return 'good'; // Green
  }

  const colors: Record<string, string> = {
    p0: 'danger', // Red
    p1: 'warning', // Orange
    p2: '#439FE0', // Blue
  };

  return colors[severity] || colors.p2;
}

/**
 * Helper: Get emoji for severity
 */
function getSeverityEmoji(severity: string, status: string): string {
  if (status === 'resolved') {
    return 'OK';
  }

  const emojis: Record<string, string> = {
    p0: 'CRITICAL',
    p1: 'WARNING',
    p2: 'INFO',
  };

  return emojis[severity] || emojis.p2;
}

/**
 * Get investigation context for monitoring alerts
 * Provides actionable commands and links
 */
function getMonitoringInvestigationContext(alert: Alert, env: Env): {
  commands: string;
  buttons: Array<{
    type: 'button';
    text: { type: 'plain_text'; text: string; emoji: boolean };
    url: string;
  }>;
} {
  const dashboardUrl = getDashboardUrl(env);
  const gatusUrl = getGatusUrl(env);

  const baseButtons = [
    {
      type: 'button' as const,
      text: { type: 'plain_text' as const, text: 'Platform Dashboard', emoji: true },
      url: `${dashboardUrl}/usage/monitor`,
    },
  ];

  // Source-specific investigation commands
  if (alert.source === 'gatus') {
    const endpointUrl = (alert.metadata?.endpointUrl as string) || 'N/A';
    const endpointGroup = (alert.metadata?.endpointGroup as string) || 'monitors';
    const isHeartbeat = endpointGroup === 'heartbeats';
    return {
      commands: isHeartbeat
        ? `# Check worker logs (last 15 min)
npx wrangler tail ${alert.service_id} --format pretty

# Check cron triggers
# Cloudflare dashboard > Workers > ${alert.service_id} > Triggers

# Manual heartbeat test
${gatusUrl ? `curl -X POST "${gatusUrl}/api/v1/endpoints/heartbeats_${alert.service_id}/external?success=true" -H "Authorization: Bearer $GATUS_TOKEN"` : '# Configure GATUS_URL to enable heartbeat testing'}`
        : `# Check endpoint directly
curl -s -o /dev/null -w "%{http_code}" "${endpointUrl}"

# Check worker logs
npx wrangler tail ${alert.service_id} --format pretty`,
      buttons: [
        ...baseButtons,
        ...(gatusUrl ? [{
          type: 'button' as const,
          text: { type: 'plain_text' as const, text: 'Gatus Status', emoji: true },
          url: gatusUrl,
        }] : []),
      ],
    };
  }

  if (alert.source === 'hetrixtools') {
    const monitorTarget = (alert.metadata?.monitorTarget as string) || 'N/A';
    const errors = alert.metadata?.monitorErrors as Record<string, string> | undefined;
    const errorDetail = errors
      ? Object.entries(errors).map(([loc, err]) => `  ${loc}: ${err}`).join('\n')
      : '  No error details';
    return {
      commands: `# Check endpoint directly
curl -s -o /dev/null -w "%{http_code}" "${monitorTarget}"

# Location errors:
${errorDetail}

# Check worker logs (last 15 min)
npx wrangler tail ${alert.service_id} --format pretty

# Check recent incidents
npx wrangler d1 execute platform-metrics --remote --command "SELECT * FROM incidents WHERE service_id = '${alert.service_id}' ORDER BY created_at DESC LIMIT 5"`,
      buttons: [
        ...baseButtons,
        {
          type: 'button' as const,
          text: { type: 'plain_text' as const, text: 'HetrixTools', emoji: true },
          url: 'https://hetrixtools.com/dashboard/uptime-monitors/',
        },
      ],
    };
  }

  if (alert.source === 'netdata') {
    const host = alert.metadata?.rawPayload?.host || 'unknown';
    const chart = alert.metadata?.chart || 'system.cpu';
    return {
      commands: `# SSH to VPS and check metrics
ssh ${host}

# Check Netdata dashboard
# URL: http://${host}:19999

# View specific chart
# Chart: ${chart}

# Check system resources
htop
df -h
free -m`,
      buttons: [
        ...baseButtons,
        {
          type: 'button' as const,
          text: { type: 'plain_text' as const, text: 'Netdata Dashboard', emoji: true },
          url: `http://${host}:19999`,
        },
      ],
    };
  }

  // Default for other sources
  return {
    commands: `# Check worker logs
npx wrangler tail ${alert.service_id} --format pretty

# View Workers Observability
# Filter by service: ${alert.service_id}`,
    buttons: [
      ...baseButtons,
      {
        type: 'button' as const,
        text: { type: 'plain_text' as const, text: 'Workers Observability', emoji: true },
        url: 'https://dash.cloudflare.com/?to=/:account/workers/observability',
      },
    ],
  };
}
