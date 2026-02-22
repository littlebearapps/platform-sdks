/**
 * Error Capture Decision Logic
 * Determines which tail events should create/update GitHub issues
 */

import type { TailEvent, CaptureDecision, ErrorType, Priority } from './types';

/**
 * Normalize URL by removing dynamic path segments and query params
 * This helps group similar errors together
 */
export function normalizeUrl(url: string | undefined): string {
  if (!url) return 'no-url';

  try {
    const parsed = new URL(url);
    // Remove query string
    let path = parsed.pathname;

    // Replace common dynamic segments with placeholders
    // UUIDs
    path = path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id');
    // Numeric IDs
    path = path.replace(/\/\d+/g, '/:id');
    // Hash-like segments (e.g., /abc123def456/)
    path = path.replace(/\/[a-f0-9]{16,}/gi, '/:hash');

    return `${parsed.hostname}${path}`;
  } catch {
    return url.slice(0, 100);
  }
}

/**
 * Determine if this tail event should create/update a GitHub issue
 */
export function shouldCapture(event: TailEvent): CaptureDecision {
  // Resource limit failures - always capture
  if (event.outcome === 'exceededCpu') {
    return { capture: true, type: 'cpu_limit' };
  }
  if (event.outcome === 'exceededMemory') {
    return { capture: true, type: 'memory_limit' };
  }

  // Hard exceptions - always capture
  if (event.outcome === 'exception') {
    return { capture: true, type: 'exception' };
  }

  // Check for soft errors (console.error with 'ok' outcome)
  const hasErrorLogs = event.logs.some((l) => l.level === 'error');
  if (hasErrorLogs) {
    return { capture: true, type: 'soft_error' };
  }

  // Check for warnings (console.warn)
  const hasWarnings = event.logs.some((l) => l.level === 'warn');
  if (hasWarnings) {
    return { capture: true, type: 'warning' };
  }

  // Don't capture successful invocations without errors/warnings
  return { capture: false };
}

/**
 * Calculate priority based on error type, project tier, and occurrence count
 */
export function calculatePriority(
  errorType: ErrorType,
  tier: number,
  occurrenceCount: number
): Priority {
  // Resource limits are always critical
  if (errorType === 'cpu_limit' || errorType === 'memory_limit') {
    return 'P0';
  }

  // Exceptions based on project tier
  if (errorType === 'exception') {
    if (tier === 0) return 'P0'; // Tier 0 = Critical (revenue-generating)
    if (tier === 1) return 'P1'; // Tier 1 = High priority
    return 'P2'; // Tier 2+ = Medium priority
  }

  // Soft errors escalate with repeated occurrences
  if (errorType === 'soft_error') {
    return occurrenceCount > 5 ? 'P2' : 'P3';
  }

  // Warnings are lowest priority
  return 'P4';
}

/**
 * Get GitHub labels for an error
 */
export function getLabels(errorType: ErrorType, priority: Priority): string[] {
  const labels: string[] = ['cf:error:auto-generated'];

  // Priority label
  switch (priority) {
    case 'P0':
      labels.push('cf:priority:critical');
      break;
    case 'P1':
      labels.push('cf:priority:high');
      break;
    case 'P2':
      labels.push('cf:priority:medium');
      break;
    case 'P3':
      labels.push('cf:priority:low');
      break;
    case 'P4':
      labels.push('cf:priority:warning');
      break;
  }

  // Error type label
  switch (errorType) {
    case 'exception':
      labels.push('cf:error:exception');
      break;
    case 'cpu_limit':
      labels.push('cf:error:cpu-limit');
      break;
    case 'memory_limit':
      labels.push('cf:error:memory-limit');
      break;
    case 'soft_error':
      labels.push('cf:error:soft-error');
      break;
    case 'warning':
      labels.push('cf:error:warning');
      break;
  }

  return labels;
}

/**
 * Extract the core message from a log entry, stripping JSON wrapper and dynamic fields
 */
export function extractCoreMessage(message: unknown): string {
  if (typeof message === 'string') {
    // Try to parse as JSON to extract just the message field
    try {
      const parsed = JSON.parse(message);
      if (parsed && typeof parsed.message === 'string') {
        return parsed.message;
      }
    } catch {
      // Not JSON, use as-is
    }
    return message;
  }

  if (message && typeof message === 'object') {
    // If it's an object with a message field, extract it
    const obj = message as Record<string, unknown>;
    if (typeof obj.message === 'string') {
      return obj.message;
    }
  }

  return String(message);
}

/**
 * Format error title for GitHub issue
 * Extracts clean message from JSON log entries for readable titles
 */
export function formatErrorTitle(
  errorType: ErrorType,
  event: TailEvent,
  scriptName: string
): string {
  const maxLength = 100;

  if (errorType === 'cpu_limit') {
    return `[${scriptName}] Exceeded CPU limit`;
  }

  if (errorType === 'memory_limit') {
    return `[${scriptName}] Exceeded memory limit`;
  }

  if (errorType === 'exception' && event.exceptions.length > 0) {
    const exc = event.exceptions[0];
    const msg = exc.message.slice(0, 60);
    return `[${scriptName}] ${exc.name}: ${msg}`.slice(0, maxLength);
  }

  if (errorType === 'soft_error') {
    const errorLog = event.logs.find((l) => l.level === 'error');
    if (errorLog) {
      const msg = extractCoreMessage(errorLog.message[0]).slice(0, 60);
      return `[${scriptName}] Error: ${msg}`.slice(0, maxLength);
    }
  }

  if (errorType === 'warning') {
    const warnLog = event.logs.find((l) => l.level === 'warn');
    if (warnLog) {
      const msg = extractCoreMessage(warnLog.message[0]).slice(0, 60);
      return `[${scriptName}] Warning: ${msg}`.slice(0, maxLength);
    }
  }

  return `[${scriptName}] ${errorType} error`;
}
