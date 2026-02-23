/// <reference types="@cloudflare/workers-types" />

/**
 * Transient Error Patterns
 *
 * Static regex patterns for classifying transient (expected operational) errors.
 * These patterns enable stable category-based fingerprints instead of message-based
 * fingerprints, preventing duplicate issues when external APIs return varying messages.
 *
 * Zero I/O, fully portable — safe to import in any Cloudflare Worker.
 *
 * @example
 * ```typescript
 * import { classifyErrorAsTransient, TRANSIENT_ERROR_PATTERNS } from '@littlebearapps/platform-consumer-sdk/patterns';
 *
 * const result = classifyErrorAsTransient('quotaExceeded: Daily limit reached');
 * // { isTransient: true, category: 'quota-exhausted' }
 *
 * const notTransient = classifyErrorAsTransient('TypeError: Cannot read property x');
 * // { isTransient: false }
 * ```
 */

// =============================================================================
// TYPES
// =============================================================================

/** A static transient error pattern with regex and category */
export interface TransientErrorPattern {
  pattern: RegExp;
  category: string;
}

// =============================================================================
// PATTERNS
// =============================================================================

/**
 * Transient error patterns that should use stable category-based fingerprints
 * instead of message-based fingerprints. This prevents duplicate issues when
 * external APIs return slightly different error messages for the same condition.
 *
 * Patterns are checked in order — first match wins.
 * Categories are used as fingerprint components instead of the error message.
 */
export const TRANSIENT_ERROR_PATTERNS: TransientErrorPattern[] = [
  // Internal quota guards (self-imposed safety limits) - MUST be before generic quota patterns
  { pattern: /safety limit exceeded/i, category: 'quota-safety-limit' },
  { pattern: /QuotaGuard safety limit/i, category: 'quota-safety-limit' },
  { pattern: /safety limit/i, category: 'quota-safety-limit' },

  // YouTube-specific quota patterns - MUST be before generic quota patterns
  { pattern: /Trending videos quota exceeded/i, category: 'youtube-quota' },
  { pattern: /Video search quota exceeded/i, category: 'youtube-quota' },

  // Quota exhaustion patterns (most specific first)
  { pattern: /QUOTA.*EXHAUSTED/i, category: 'quota-exhausted' },
  { pattern: /quotaExceeded/i, category: 'quota-exhausted' },
  { pattern: /quota.*exceeded/i, category: 'quota-exhausted' },
  { pattern: /quota.*limit/i, category: 'quota-exhausted' },
  { pattern: /daily.*limit.*exceeded/i, category: 'quota-exhausted' },

  // Rate limiting patterns
  { pattern: /RATE.*LIMITED/i, category: 'rate-limited' },
  { pattern: /rate.?limit/i, category: 'rate-limited' },
  { pattern: /too.?many.?requests/i, category: 'rate-limited' },
  { pattern: /\b429\b/, category: 'rate-limited' },

  // Service availability patterns
  { pattern: /service.*unavailable/i, category: 'service-unavailable' },
  { pattern: /\b503\b/, category: 'service-unavailable' },
  { pattern: /\b502\b/, category: 'bad-gateway' },
  { pattern: /bad.*gateway/i, category: 'bad-gateway' },

  // Connection patterns
  { pattern: /ECONNREFUSED/i, category: 'connection-refused' },
  { pattern: /ETIMEDOUT/i, category: 'connection-timeout' },
  { pattern: /ECONNRESET/i, category: 'connection-reset' },
  { pattern: /ENOTFOUND/i, category: 'dns-not-found' },

  // Timeout patterns - specific patterns MUST be before generic /timeout/i
  { pattern: /scan timed out/i, category: 'scan-timeout' },
  { pattern: /Platform \w+ timeout/i, category: 'platform-timeout' },
  { pattern: /timeout/i, category: 'timeout' },

  // Deployment/infrastructure patterns (DO resets during code updates)
  { pattern: /Durable Object reset/i, category: 'do-reset' },
  { pattern: /code was updated/i, category: 'deployment-reset' },

  // YouTube API patterns (structured logging extracts message without quota fields)
  { pattern: /YOUTUBE_API_ERROR/i, category: 'youtube-api-error' },
  { pattern: /\bquota_exceeded\b/i, category: 'quota-exhausted' },
  { pattern: /Channel lookup failed/i, category: 'channel-lookup-failed' },
  { pattern: /Channel forbidden/i, category: 'channel-forbidden' },
  // YouTube transient fetch failures (403s during quota exhaustion, API issues)
  { pattern: /Playlist fetch failed/i, category: 'youtube-fetch-failed' },
  { pattern: /Video.*fetch failed/i, category: 'youtube-fetch-failed' },
  { pattern: /Subscriptions? fetch failed/i, category: 'youtube-fetch-failed' },
  { pattern: /Get subscriptions failed/i, category: 'youtube-fetch-failed' },
  { pattern: /YouTube subscription sync failed/i, category: 'youtube-fetch-failed' },

  // D1 patterns (inefficient queries are expected during development)
  { pattern: /D1 inefficient query/i, category: 'd1-inefficient-query' },
  // D1 rate limiting (Cloudflare limits API requests per worker invocation)
  { pattern: /Too many API requests by single worker/i, category: 'd1-rate-limited' },

  // Durable Object stub errors (transient during deployments/resets)
  { pattern: /DO stub error/i, category: 'do-stub-error' },
  { pattern: /DO transient error/i, category: 'do-stub-error' },
  { pattern: /stub\.fetch is not a function/i, category: 'do-stub-error' },
  { pattern: /\bdestroyed\b/, category: 'do-destroyed' },

  // Cloudflare platform behaviour (runtime warnings, R2 transient errors)
  { pattern: /promise was resolved or rejected from a different request context/i, category: 'cross-request-promise' },
  { pattern: /We encountered an internal error.*\(10001\)/i, category: 'r2-internal-error' },
  { pattern: /Failed to log AI call to R2/i, category: 'r2-logging-failed' },

  // Brand Copilot expected operational patterns
  { pattern: /\[SEC\] workers\.dev auth FAILED/i, category: 'auth-rejected-workersdev' },
  { pattern: /Budget exhausted, skipping/i, category: 'budget-exhausted' },
  { pattern: /\[Gatekeeper\] AI error, failing open/i, category: 'gatekeeper-fail-open' },
  { pattern: /Mastodon OAuth not configured/i, category: 'mastodon-oauth-missing' },
  { pattern: /Error fetching trending/i, category: 'external-api-trending' },
  { pattern: /Failed to scan discover feed/i, category: 'scanner-discover-feed' },
];

// =============================================================================
// CLASSIFICATION
// =============================================================================

/**
 * Classify an error message as transient or not.
 *
 * Checks the message against all static transient error patterns.
 * Returns the category if matched, or `isTransient: false` if the error
 * should use standard message-based fingerprinting.
 *
 * @param message - The error message to classify
 * @returns Classification result with category if transient
 *
 * @example
 * ```typescript
 * const result = classifyErrorAsTransient('RATE_LIMITED: Too many requests');
 * if (result.isTransient) {
 *   console.log(`Transient error: ${result.category}`); // 'rate-limited'
 * }
 * ```
 */
export function classifyErrorAsTransient(message: string): { isTransient: boolean; category?: string } {
  for (const { pattern, category } of TRANSIENT_ERROR_PATTERNS) {
    if (pattern.test(message)) {
      return { isTransient: true, category };
    }
  }
  return { isTransient: false };
}
