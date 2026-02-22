/**
 * Error Fingerprinting
 * Creates stable hashes for error deduplication
 *
 * Supports both static patterns (from SDK) and dynamic patterns
 * (loaded from KV/D1 at runtime via AI-assisted pattern discovery).
 */

import type { TailEvent, ErrorType } from './types';
import { normalizeUrl, extractCoreMessage } from './capture';

// Re-export SDK patterns and types for backward compatibility
export {
  TRANSIENT_ERROR_PATTERNS,
  type TransientErrorPattern,
} from '@littlebearapps/platform-sdk/patterns';

export {
  loadDynamicPatterns,
  clearDynamicPatternsCache,
  compileDynamicPatterns,
  classifyWithDynamicPatterns,
  DYNAMIC_PATTERNS_KV_KEY,
  type DynamicPatternRule,
  type CompiledPattern,
} from '@littlebearapps/platform-sdk/dynamic-patterns';

// Import for local use in classify/fingerprint functions
import { TRANSIENT_ERROR_PATTERNS } from '@littlebearapps/platform-sdk/patterns';
import type { CompiledPattern } from '@littlebearapps/platform-sdk/dynamic-patterns';

/** Classification result including pattern source for analytics */
export interface ClassificationResult {
  category: string;
  source: 'static' | 'dynamic';
  patternId?: string;
}

/**
 * Classify an error message into a semantic category for transient errors.
 * Returns the category if matched, or null if the error should use
 * standard message-based fingerprinting.
 *
 * Checks static patterns first (higher trust), then dynamic patterns.
 *
 * @example
 * classifyError('[YOUTUBE_QUOTA_EXHAUSTED] Daily limit exceeded')
 * // Returns: 'quota-exhausted'
 *
 * classifyError('TypeError: Cannot read property x')
 * // Returns: null (not a transient error)
 */
export function classifyError(message: string): string | null {
  const result = classifyErrorWithSource(message);
  return result?.category ?? null;
}

/**
 * Classify an error message with source information.
 * Used internally and by analytics to track dynamic pattern effectiveness.
 */
export function classifyErrorWithSource(
  message: string,
  dynamicPatterns: CompiledPattern[] = []
): ClassificationResult | null {
  // Check static patterns first (trusted, from SDK)
  for (const { pattern, category } of TRANSIENT_ERROR_PATTERNS) {
    if (pattern.test(message)) {
      return { category, source: 'static' };
    }
  }

  // Check dynamic patterns (AI-suggested, human-approved)
  for (const compiled of dynamicPatterns) {
    if (compiled.test(message)) {
      return {
        category: compiled.category,
        source: 'dynamic',
        patternId: compiled.id,
      };
    }
  }

  return null;
}

/**
 * Check if an error is a transient (expected operational) error.
 * Transient errors are expected to self-resolve and should not be
 * treated as bugs or regressions.
 */
export function isTransientError(message: string): boolean {
  return classifyError(message) !== null;
}

/**
 * Normalize dynamic values in a message to create stable fingerprints.
 * Replaces numbers, UUIDs, timestamps, and other variable content with placeholders.
 *
 * Example:
 *   "Slow workflow step (durationMs: 116781, itemCount: 3)"
 *   -> "Slow workflow step (durationMs: {N}, itemCount: {N})"
 *
 *   "Only 29 requests remaining!"
 *   -> "Only {N} requests remaining!"
 */
export function normalizeDynamicValues(message: string): string {
  return (
    message
      // Remove UUIDs (must be before numbers to avoid partial replacement)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{UUID}')
      // Remove hex hashes (16+ chars, e.g., correlation IDs, fingerprints)
      .replace(/\b[0-9a-f]{16,}\b/gi, '{HASH}')
      // Remove IPv6 addresses (e.g., 2001:0db8:85a3::8a2e:0370:7334)
      .replace(/\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi, '{IPV6}')
      // Remove Base64-encoded strings (20+ chars to avoid false positives)
      .replace(/\b[A-Za-z0-9+/]{20,}={0,2}\b/g, '{BASE64}')
      // Remove ISO timestamps (2026-01-31T12:34:56.789Z)
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.\d]*Z?/g, '{TS}')
      // Remove date strings (2026-01-31)
      .replace(/\d{4}-\d{2}-\d{2}/g, '{DATE}')
      // Remove numbers (must be last to avoid breaking other patterns)
      .replace(/\d+/g, '{N}')
      // Normalize whitespace
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Result of fingerprint computation including classification metadata
 */
export interface FingerprintResult {
  fingerprint: string;
  category: string | null;
  normalizedMessage: string | null;
  patternSource?: 'static' | 'dynamic';
  dynamicPatternId?: string;
}

/** Options for computing fingerprints with dynamic pattern support */
export interface ComputeFingerprintOptions {
  /** Pre-loaded dynamic patterns (optional, for performance) */
  dynamicPatterns?: CompiledPattern[];
}

/**
 * Compute a fingerprint for an error event
 * Same fingerprint = same error = update existing issue
 *
 * For transient errors (quota exhaustion, rate limits, etc.), uses the
 * error category instead of the message to ensure stable fingerprints
 * even when external APIs return varying error messages.
 *
 * Supports both static patterns (from SDK) and dynamic patterns (from KV).
 */
export async function computeFingerprint(
  event: TailEvent,
  errorType: ErrorType,
  options: ComputeFingerprintOptions = {}
): Promise<FingerprintResult> {
  const components: string[] = [event.scriptName, errorType];
  let classification: ClassificationResult | null = null;
  let normalizedMessage: string | null = null;
  const dynamicPatterns = options.dynamicPatterns || [];

  // For exceptions, include exception name and either category or normalized message
  if (errorType === 'exception' && event.exceptions.length > 0) {
    const exc = event.exceptions[0];
    components.push(exc.name);

    // Check for transient error classification first (static + dynamic)
    classification = classifyErrorWithSource(exc.message, dynamicPatterns);
    if (classification) {
      // Use stable category instead of variable message
      components.push(classification.category);
      normalizedMessage = normalizeDynamicValues(exc.message).slice(0, 200);
    } else {
      // Standard message-based fingerprinting
      normalizedMessage = normalizeDynamicValues(exc.message).slice(0, 100);
      components.push(normalizedMessage);
    }
  }

  // For CPU/memory limits, just use script name + type (already in components)
  // These are script-level issues, not request-specific

  // For soft errors, include the normalized error message or category
  if (errorType === 'soft_error') {
    const errorLog = event.logs.find((l) => l.level === 'error');
    if (errorLog) {
      const coreMsg = extractCoreMessage(errorLog.message[0]);

      // Check for transient error classification (static + dynamic)
      classification = classifyErrorWithSource(coreMsg, dynamicPatterns);
      if (classification) {
        components.push(classification.category);
        normalizedMessage = normalizeDynamicValues(coreMsg).slice(0, 200);
      } else {
        normalizedMessage = normalizeDynamicValues(coreMsg).slice(0, 100);
        components.push(normalizedMessage);
      }
    }
  }

  // For warnings, include the normalized warning message or category
  if (errorType === 'warning') {
    const warnLog = event.logs.find((l) => l.level === 'warn');
    if (warnLog) {
      const coreMsg = extractCoreMessage(warnLog.message[0]);

      // Check for transient error classification (static + dynamic)
      classification = classifyErrorWithSource(coreMsg, dynamicPatterns);
      if (classification) {
        components.push(classification.category);
        normalizedMessage = normalizeDynamicValues(coreMsg).slice(0, 200);
      } else {
        normalizedMessage = normalizeDynamicValues(coreMsg).slice(0, 100);
        components.push(normalizedMessage);
      }
    }
  }

  // Include normalized URL for HTTP errors (helps distinguish different endpoints)
  // Note: Cron/scheduled events don't have request URLs
  if (event.event?.request?.url && (errorType === 'exception' || errorType === 'soft_error')) {
    components.push(normalizeUrl(event.event.request.url));
  }

  // Create hash
  const data = components.join(':');
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));

  // Return first 32 hex chars (16 bytes)
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
 * Generate a unique ID for a new error occurrence
 */
export function generateId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
