/**
 * Error Collector Types
 */

// Cloudflare Tail Event types (from Cloudflare docs)
export type TailOutcome =
  | 'ok'
  | 'exception'
  | 'exceededCpu'
  | 'exceededMemory'
  | 'canceled'
  | 'scriptNotFound'
  | 'responseStreamDisconnected';

export interface TailLog {
  level: 'log' | 'warn' | 'error' | 'debug' | 'info';
  message: unknown[];
  timestamp: number;
}

export interface TailException {
  name: string;
  message: string;
  timestamp: number;
}

export interface TailDiagnosticEvent {
  channel: string;
  message: unknown;
  timestamp: number;
}

export interface TailEvent {
  scriptName: string;
  outcome: TailOutcome;
  eventTimestamp: number;
  cpuTime?: number;
  wallTime?: number;
  // Script version for identifying deployment
  scriptVersion?: {
    id?: string;
    tag?: string;
    message?: string;
  };
  // Event type: fetch, scheduled, queue, alarm, email, etc.
  eventType?: string;
  // Execution model: stateless, durableObject
  executionModel?: string;
  event?: {
    request?: {
      url: string;
      method: string;
      headers: Record<string, string>;
      cf?: {
        colo?: string;
        country?: string;
        city?: string;
        region?: string;
        regionCode?: string;
        continent?: string;
        timezone?: string;
        httpProtocol?: string;
        asn?: number;
        asOrganization?: string;
        [key: string]: unknown;
      };
    };
    response?: {
      status?: number;
    };
    // Queue event context
    queue?: string;
    batchSize?: number;
    // Scheduled event context
    scheduledTime?: number;
    cron?: string;
    // Ray ID for request tracing
    rayId?: string;
  };
  logs: TailLog[];
  exceptions: TailException[];
  diagnosticsChannelEvents?: TailDiagnosticEvent[];
}

// Error Collector types
export type ErrorType = 'exception' | 'cpu_limit' | 'memory_limit' | 'soft_error' | 'warning';
export type Priority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
export type ErrorStatus = 'open' | 'resolved' | 'wont_fix' | 'pending_digest' | 'digested';

export interface CaptureDecision {
  capture: boolean;
  type?: ErrorType;
}

export interface ScriptMapping {
  project: string;
  repository: string;
  tier: number;
  displayName: string;
  synced_at?: string;
}

export interface ErrorFingerprint {
  issueNumber?: number;
  issueUrl?: string;
  status: ErrorStatus;
  lastSeen: number;
  firstSeen: number;
  occurrenceCount: number;
}

export interface ErrorOccurrence {
  id: string;
  fingerprint: string;
  script_name: string;
  project: string;
  error_type: ErrorType;
  priority: Priority;
  github_issue_number?: number;
  github_issue_url?: string;
  github_repo: string;
  status: ErrorStatus;
  resolved_at?: number;
  resolved_by?: string;
  first_seen_at: number;
  last_seen_at: number;
  occurrence_count: number;
  last_request_url?: string;
  last_request_method?: string;
  last_colo?: string;
  last_country?: string;
  last_cf_ray?: string;
  last_exception_name?: string;
  last_exception_message?: string;
  last_logs_json?: string;
  // Digest-related fields (for P4 warnings)
  digest_date?: string; // YYYY-MM-DD format
  digest_issue_number?: number;
  normalized_message?: string; // For grouping in digests
}

/**
 * Pending warning for digest aggregation
 */
export interface PendingDigestWarning {
  id: string;
  fingerprint: string;
  script_name: string;
  project: string;
  github_repo: string;
  normalized_message: string;
  raw_message: string;
  event_timestamp: number;
  occurrence_count: number;
}

export type GitHubIssueType = 'Bug' | 'Task' | 'Feature';

export interface GitHubIssueCreate {
  owner: string;
  repo: string;
  title: string;
  body: string;
  labels: string[];
  type?: GitHubIssueType;
  assignees?: string[];
}

export interface GitHubIssueUpdate {
  owner: string;
  repo: string;
  issue_number: number;
  body?: string;
  state?: 'open' | 'closed';
}

export interface Env {
  // D1
  PLATFORM_DB: D1Database;
  // KV
  PLATFORM_CACHE: KVNamespace;
  // Service Bindings
  NOTIFICATIONS_API?: Fetcher; // Optional: for creating dashboard notifications
  // Secrets
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_INSTALLATION_ID: string;
  GITHUB_WEBHOOK_SECRET: string;
  // Vars
  GITHUB_ORG: string;
  GITHUB_PROJECT_NUMBER: string;
  GITHUB_PROJECT_ID: string;
  AUTO_CLOSE_HOURS: string;
  WARNING_AUTO_CLOSE_DAYS: string;
  DEFAULT_ASSIGNEE: string;
  // Gatus heartbeat ping URLs for cron monitoring
  GATUS_HEARTBEAT_URL_15M?: string; // For 15-minute tail handler health
  GATUS_HEARTBEAT_URL_DIGEST?: string; // For daily digest processing
  GATUS_TOKEN?: string; // Bearer token for Gatus external endpoints
}

// =============================================================================
// GAP ALERT TYPES (from platform-sentinel)
// =============================================================================

/**
 * Resource-level coverage breakdown
 */
export interface ResourceCoverage {
  resourceType: string;
  hoursWithData: number;
  coveragePct: number;
}

/**
 * Gap alert event sent by platform-sentinel when a project has
 * less than the threshold coverage (default 90%) in the last 24 hours.
 */
export interface GapAlertEvent {
  /** Project identifier (e.g., 'my-project') */
  project: string;
  /** Number of hours with data in the last 24h */
  hoursWithData: number;
  /** Expected hours (always 24) */
  expectedHours: number;
  /** Coverage percentage (0-100) */
  coveragePct: number;
  /** ISO timestamps of missing hours */
  missingHours: string[];
  /** GitHub repository in owner/repo format (from project_registry) */
  repository?: string;
  /** Per-resource type coverage breakdown */
  resourceBreakdown?: ResourceCoverage[];
  /** Most recent hour with data (YYYY-MM-DD HH:00 format) */
  lastDataHour?: string;
}

// =============================================================================
// EMAIL HEALTH ALERT TYPES (from platform-email-healthcheck)
// =============================================================================

/** Individual check failure from email health check worker */
export interface EmailHealthCheckFailure {
  check_type: string;
  status: 'fail';
  error_msg: string;
}

/**
 * Email health alert event sent by platform-email-healthcheck when
 * a brand has one or more failing health checks.
 */
export interface EmailHealthAlertEvent {
  /** Brand identifier */
  brand_id: string;
  /** List of failing checks */
  failures: EmailHealthCheckFailure[];
  /** GitHub repository in owner/repo format */
  repository: string;
  /** Run ID from the health check execution */
  run_id: string;
}
