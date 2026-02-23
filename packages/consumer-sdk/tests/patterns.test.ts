/**
 * Unit Tests for Platform SDK Transient Error Patterns
 *
 * Tests all static transient error patterns, ordering/precedence,
 * and the classifyErrorAsTransient() convenience function.
 *
 * @module tests/unit/platform-sdk/patterns
 */

import { describe, expect, it } from 'vitest';
import {
  TRANSIENT_ERROR_PATTERNS,
  classifyErrorAsTransient,
  type TransientErrorPattern,
} from '@littlebearapps/platform-consumer-sdk/patterns';

// =============================================================================
// PATTERNS ARRAY VALIDATION
// =============================================================================

describe('TRANSIENT_ERROR_PATTERNS', () => {
  it('exports a non-empty array of patterns', () => {
    expect(TRANSIENT_ERROR_PATTERNS).toBeInstanceOf(Array);
    expect(TRANSIENT_ERROR_PATTERNS.length).toBeGreaterThan(0);
  });

  it('each pattern has a regex and category', () => {
    for (const entry of TRANSIENT_ERROR_PATTERNS) {
      expect(entry.pattern).toBeInstanceOf(RegExp);
      expect(typeof entry.category).toBe('string');
      expect(entry.category.length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate patterns (same regex source + flags)', () => {
    const seen = new Set<string>();
    for (const { pattern } of TRANSIENT_ERROR_PATTERNS) {
      const key = `${pattern.source}:${pattern.flags}`;
      expect(seen.has(key), `Duplicate pattern: ${pattern.source}`).toBe(false);
      seen.add(key);
    }
  });
});

// =============================================================================
// QUOTA SAFETY LIMIT PATTERNS
// =============================================================================

describe('quota-safety-limit patterns', () => {
  it('matches "safety limit exceeded"', () => {
    const result = classifyErrorAsTransient('Safety limit exceeded for D1 writes');
    expect(result).toEqual({ isTransient: true, category: 'quota-safety-limit' });
  });

  it('matches "QuotaGuard safety limit"', () => {
    const result = classifyErrorAsTransient('QuotaGuard safety limit reached');
    expect(result).toEqual({ isTransient: true, category: 'quota-safety-limit' });
  });

  it('matches generic "safety limit"', () => {
    const result = classifyErrorAsTransient('Hit safety limit on API calls');
    expect(result).toEqual({ isTransient: true, category: 'quota-safety-limit' });
  });
});

// =============================================================================
// YOUTUBE QUOTA PATTERNS
// =============================================================================

describe('youtube-quota patterns', () => {
  it('matches "Trending videos quota exceeded"', () => {
    const result = classifyErrorAsTransient('Trending videos quota exceeded');
    expect(result).toEqual({ isTransient: true, category: 'youtube-quota' });
  });

  it('matches "Video search quota exceeded"', () => {
    const result = classifyErrorAsTransient('Video search quota exceeded');
    expect(result).toEqual({ isTransient: true, category: 'youtube-quota' });
  });
});

// =============================================================================
// QUOTA EXHAUSTION PATTERNS
// =============================================================================

describe('quota-exhausted patterns', () => {
  it('matches QUOTA_EXHAUSTED', () => {
    const result = classifyErrorAsTransient('QUOTA_EXHAUSTED: Daily limit reached');
    expect(result).toEqual({ isTransient: true, category: 'quota-exhausted' });
  });

  it('matches quotaExceeded', () => {
    const result = classifyErrorAsTransient('quotaExceeded');
    expect(result).toEqual({ isTransient: true, category: 'quota-exhausted' });
  });

  it('matches "quota limit"', () => {
    const result = classifyErrorAsTransient('You have exceeded the quota limit');
    expect(result).toEqual({ isTransient: true, category: 'quota-exhausted' });
  });

  it('matches "daily limit exceeded"', () => {
    const result = classifyErrorAsTransient('daily limit exceeded for this API');
    expect(result).toEqual({ isTransient: true, category: 'quota-exhausted' });
  });

  it('matches quota_exceeded (YouTube API)', () => {
    const result = classifyErrorAsTransient('Error: quota_exceeded for channel');
    expect(result).toEqual({ isTransient: true, category: 'quota-exhausted' });
  });
});

// =============================================================================
// RATE LIMITING PATTERNS
// =============================================================================

describe('rate-limited patterns', () => {
  it('matches RATE_LIMITED', () => {
    const result = classifyErrorAsTransient('RATE_LIMITED: Slow down');
    expect(result).toEqual({ isTransient: true, category: 'rate-limited' });
  });

  it('matches "rate limit"', () => {
    const result = classifyErrorAsTransient('Hit rate limit on endpoint');
    expect(result).toEqual({ isTransient: true, category: 'rate-limited' });
  });

  it('matches "too many requests"', () => {
    const result = classifyErrorAsTransient('Too many requests, please retry');
    expect(result).toEqual({ isTransient: true, category: 'rate-limited' });
  });

  it('matches HTTP 429', () => {
    const result = classifyErrorAsTransient('Request failed with status 429');
    expect(result).toEqual({ isTransient: true, category: 'rate-limited' });
  });
});

// =============================================================================
// SERVICE AVAILABILITY PATTERNS
// =============================================================================

describe('service-unavailable and bad-gateway patterns', () => {
  it('matches "service unavailable"', () => {
    const result = classifyErrorAsTransient('Service unavailable, please try later');
    expect(result).toEqual({ isTransient: true, category: 'service-unavailable' });
  });

  it('matches HTTP 503', () => {
    const result = classifyErrorAsTransient('Error 503: Backend unavailable');
    expect(result).toEqual({ isTransient: true, category: 'service-unavailable' });
  });

  it('matches HTTP 502', () => {
    const result = classifyErrorAsTransient('Received 502 from upstream');
    expect(result).toEqual({ isTransient: true, category: 'bad-gateway' });
  });

  it('matches "bad gateway"', () => {
    const result = classifyErrorAsTransient('Bad gateway error from proxy');
    expect(result).toEqual({ isTransient: true, category: 'bad-gateway' });
  });
});

// =============================================================================
// CONNECTION PATTERNS
// =============================================================================

describe('connection patterns', () => {
  it('matches ECONNREFUSED', () => {
    const result = classifyErrorAsTransient('connect ECONNREFUSED 127.0.0.1:3000');
    expect(result).toEqual({ isTransient: true, category: 'connection-refused' });
  });

  it('matches ETIMEDOUT', () => {
    const result = classifyErrorAsTransient('connect ETIMEDOUT 10.0.0.1:443');
    expect(result).toEqual({ isTransient: true, category: 'connection-timeout' });
  });

  it('matches ECONNRESET', () => {
    const result = classifyErrorAsTransient('socket hang up ECONNRESET');
    expect(result).toEqual({ isTransient: true, category: 'connection-reset' });
  });

  it('matches ENOTFOUND', () => {
    const result = classifyErrorAsTransient('getaddrinfo ENOTFOUND example.com');
    expect(result).toEqual({ isTransient: true, category: 'dns-not-found' });
  });
});

// =============================================================================
// TIMEOUT PATTERNS (PRECEDENCE)
// =============================================================================

describe('timeout patterns (precedence)', () => {
  it('matches "scan timed out" before generic timeout', () => {
    const result = classifyErrorAsTransient('scan timed out after 30s');
    expect(result).toEqual({ isTransient: true, category: 'scan-timeout' });
  });

  it('matches "Platform fetch timeout" before generic timeout', () => {
    const result = classifyErrorAsTransient('Platform fetch timeout exceeded');
    expect(result).toEqual({ isTransient: true, category: 'platform-timeout' });
  });

  it('matches generic "timeout"', () => {
    const result = classifyErrorAsTransient('Request timeout after 10000ms');
    expect(result).toEqual({ isTransient: true, category: 'timeout' });
  });
});

// =============================================================================
// DEPLOYMENT/INFRASTRUCTURE PATTERNS
// =============================================================================

describe('deployment patterns', () => {
  it('matches "Durable Object reset"', () => {
    const result = classifyErrorAsTransient('Durable Object reset during upgrade');
    expect(result).toEqual({ isTransient: true, category: 'do-reset' });
  });

  it('matches "code was updated"', () => {
    const result = classifyErrorAsTransient('The script code was updated');
    expect(result).toEqual({ isTransient: true, category: 'deployment-reset' });
  });
});

// =============================================================================
// YOUTUBE API PATTERNS
// =============================================================================

describe('youtube API patterns', () => {
  it('matches YOUTUBE_API_ERROR', () => {
    const result = classifyErrorAsTransient('[YOUTUBE_API_ERROR] Forbidden');
    expect(result).toEqual({ isTransient: true, category: 'youtube-api-error' });
  });

  it('matches "Channel lookup failed"', () => {
    const result = classifyErrorAsTransient('Channel lookup failed for UCxyz');
    expect(result).toEqual({ isTransient: true, category: 'channel-lookup-failed' });
  });

  it('matches "Playlist fetch failed"', () => {
    const result = classifyErrorAsTransient('Playlist fetch failed: 403');
    expect(result).toEqual({ isTransient: true, category: 'youtube-fetch-failed' });
  });

  it('matches "YouTube subscription sync failed"', () => {
    const result = classifyErrorAsTransient('YouTube subscription sync failed');
    expect(result).toEqual({ isTransient: true, category: 'youtube-fetch-failed' });
  });
});

// =============================================================================
// D1 AND DO PATTERNS
// =============================================================================

describe('D1 and Durable Object patterns', () => {
  it('matches "D1 inefficient query"', () => {
    const result = classifyErrorAsTransient('D1 inefficient query detected');
    expect(result).toEqual({ isTransient: true, category: 'd1-inefficient-query' });
  });

  it('matches "Too many API requests by single worker"', () => {
    const result = classifyErrorAsTransient('Too many API requests by single worker invocation');
    expect(result).toEqual({ isTransient: true, category: 'd1-rate-limited' });
  });

  it('matches "DO stub error"', () => {
    const result = classifyErrorAsTransient('DO stub error: connection reset');
    expect(result).toEqual({ isTransient: true, category: 'do-stub-error' });
  });

  it('matches "stub.fetch is not a function"', () => {
    const result = classifyErrorAsTransient('TypeError: stub.fetch is not a function');
    expect(result).toEqual({ isTransient: true, category: 'do-stub-error' });
  });
});

// =============================================================================
// CLOUDFLARE PLATFORM PATTERNS
// =============================================================================

describe('Cloudflare platform patterns', () => {
  it('matches cross-request promise warning', () => {
    const result = classifyErrorAsTransient(
      'A promise was resolved or rejected from a different request context'
    );
    expect(result).toEqual({ isTransient: true, category: 'cross-request-promise' });
  });

  it('matches R2 internal error (10001)', () => {
    const result = classifyErrorAsTransient('We encountered an internal error. (10001)');
    expect(result).toEqual({ isTransient: true, category: 'r2-internal-error' });
  });

  it('matches "Failed to log AI call to R2"', () => {
    const result = classifyErrorAsTransient('Failed to log AI call to R2: write error');
    expect(result).toEqual({ isTransient: true, category: 'r2-logging-failed' });
  });
});

// =============================================================================
// BRAND COPILOT OPERATIONAL PATTERNS
// =============================================================================

describe('Brand Copilot operational patterns', () => {
  it('matches workers.dev auth rejection', () => {
    const result = classifyErrorAsTransient('[SEC] workers.dev auth FAILED for /api/scan');
    expect(result).toEqual({ isTransient: true, category: 'auth-rejected-workersdev' });
  });

  it('matches "Budget exhausted, skipping"', () => {
    const result = classifyErrorAsTransient('Budget exhausted, skipping RSS scan');
    expect(result).toEqual({ isTransient: true, category: 'budget-exhausted' });
  });

  it('matches Gatekeeper AI error', () => {
    const result = classifyErrorAsTransient('[Gatekeeper] AI error, failing open');
    expect(result).toEqual({ isTransient: true, category: 'gatekeeper-fail-open' });
  });

  it('matches "Mastodon OAuth not configured"', () => {
    const result = classifyErrorAsTransient('Mastodon OAuth not configured for this instance');
    expect(result).toEqual({ isTransient: true, category: 'mastodon-oauth-missing' });
  });
});

// =============================================================================
// NON-TRANSIENT ERRORS
// =============================================================================

describe('non-transient errors', () => {
  it('returns isTransient: false for TypeError', () => {
    const result = classifyErrorAsTransient('TypeError: Cannot read property x of undefined');
    expect(result).toEqual({ isTransient: false });
  });

  it('returns isTransient: false for ReferenceError', () => {
    const result = classifyErrorAsTransient('ReferenceError: foo is not defined');
    expect(result).toEqual({ isTransient: false });
  });

  it('returns isTransient: false for empty string', () => {
    const result = classifyErrorAsTransient('');
    expect(result).toEqual({ isTransient: false });
  });

  it('returns isTransient: false for generic errors', () => {
    const result = classifyErrorAsTransient('Something went wrong processing your request');
    expect(result).toEqual({ isTransient: false });
  });
});

// =============================================================================
// PATTERN PRECEDENCE
// =============================================================================

describe('pattern precedence', () => {
  it('safety limit matches before generic quota', () => {
    // "safety limit" contains the word "limit" which could match quota patterns
    const result = classifyErrorAsTransient('safety limit exceeded for quota');
    expect(result?.category).toBe('quota-safety-limit');
  });

  it('YouTube quota matches before generic quota', () => {
    const result = classifyErrorAsTransient('Trending videos quota exceeded');
    expect(result?.category).toBe('youtube-quota');
  });

  it('scan timeout matches before generic timeout', () => {
    const result = classifyErrorAsTransient('scan timed out');
    expect(result?.category).toBe('scan-timeout');
  });

  it('platform timeout matches before generic timeout', () => {
    const result = classifyErrorAsTransient('Platform fetch timeout');
    expect(result?.category).toBe('platform-timeout');
  });
});
