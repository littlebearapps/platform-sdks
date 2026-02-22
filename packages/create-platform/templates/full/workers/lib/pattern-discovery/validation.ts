/**
 * Pattern Validation and Safety Checks
 *
 * Validates AI-generated patterns for safety (ReDoS prevention)
 * and correctness (backtest against historical data).
 *
 * @module workers/lib/pattern-discovery/validation
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { PatternType, PatternRule, BacktestResult } from './types';
import type { Logger } from '@littlebearapps/platform-sdk';

/** Maximum regex execution time in ms */
const MAX_REGEX_EXEC_TIME_MS = 10;

/** Match rate threshold for over-matching detection */
const OVER_MATCHING_THRESHOLD = 0.8;

/** Dangerous regex patterns to reject */
const DANGEROUS_PATTERNS = [
  /\(\.\*\)\+/, // (.*)+
  /\(\.\+\)\+/, // (.+)+
  /\([^)]*\|[^)]*\)\+/, // (a|b)+ nested alternation with quantifier
  /\(\?<[!=]/, // Lookbehind (not supported in all engines)
  /\\1/, // Backreferences
];

/** Maximum allowed regex length */
const MAX_REGEX_LENGTH = 200;

/** Maximum allowed alternations in regex */
const MAX_ALTERNATIONS = 10;

/**
 * Validate a pattern for safety
 * Returns error message if invalid, null if valid
 */
export function validatePatternSafety(
  patternType: PatternType,
  patternValue: string
): string | null {
  // Non-regex patterns are always safe
  if (patternType !== 'regex') {
    // Basic validation for other types
    if (!patternValue || patternValue.length === 0) {
      return 'Pattern value cannot be empty';
    }
    if (patternType === 'statusCode' && !/^\d{3}$/.test(patternValue)) {
      return 'Status code must be 3 digits';
    }
    return null;
  }

  // Regex validation
  if (patternValue.length > MAX_REGEX_LENGTH) {
    return `Regex too long (max ${MAX_REGEX_LENGTH} chars)`;
  }

  // Check for dangerous patterns
  for (const dangerous of DANGEROUS_PATTERNS) {
    if (dangerous.test(patternValue)) {
      return `Regex contains dangerous pattern: ${dangerous.source}`;
    }
  }

  // Check alternation count
  const alternations = (patternValue.match(/\|/g) || []).length;
  if (alternations > MAX_ALTERNATIONS) {
    return `Too many alternations (max ${MAX_ALTERNATIONS})`;
  }

  // Try to compile the regex
  try {
    new RegExp(patternValue, 'i');
  } catch (error) {
    return `Invalid regex: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }

  // Performance test with adversarial input
  const testResult = testRegexPerformance(patternValue);
  if (testResult !== null) {
    return testResult;
  }

  return null;
}

/**
 * Test regex performance with adversarial input
 * Returns error message if too slow, null if OK
 */
function testRegexPerformance(pattern: string): string | null {
  const regex = new RegExp(pattern, 'i');

  // Test with various adversarial inputs
  const adversarialInputs = [
    'a'.repeat(100),
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!',
    ' '.repeat(100),
    'x'.repeat(50) + 'y'.repeat(50),
    '0'.repeat(100),
  ];

  for (const input of adversarialInputs) {
    const start = performance.now();
    try {
      regex.test(input);
    } catch {
      return 'Regex execution failed';
    }
    const elapsed = performance.now() - start;

    if (elapsed > MAX_REGEX_EXEC_TIME_MS) {
      return `Regex too slow (${elapsed.toFixed(1)}ms > ${MAX_REGEX_EXEC_TIME_MS}ms)`;
    }
  }

  return null;
}

/**
 * Compile a pattern rule to a test function
 */
export function compilePattern(rule: PatternRule): (message: string) => boolean {
  switch (rule.type) {
    case 'contains': {
      const tokens = rule.value.toLowerCase().split(/\s+/);
      return (message: string) => {
        const lower = message.toLowerCase();
        return tokens.every((token) => lower.includes(token));
      };
    }

    case 'startsWith': {
      const prefix = rule.value.toLowerCase();
      return (message: string) => message.toLowerCase().startsWith(prefix);
    }

    case 'statusCode': {
      const code = rule.value;
      const codePattern = new RegExp(`\\b${code}\\b`);
      return (message: string) => codePattern.test(message);
    }

    case 'regex': {
      const regex = new RegExp(rule.value, 'i');
      return (message: string) => regex.test(message);
    }
  }
}

/**
 * Run backtest against historical error data
 */
export async function backtestPattern(
  patternId: string,
  rule: PatternRule,
  db: D1Database,
  log: Logger,
  daysBack: number = 7
): Promise<BacktestResult> {
  const cutoff = Math.floor(Date.now() / 1000) - daysBack * 24 * 60 * 60;

  // Get recent errors
  const result = await db
    .prepare(
      `
    SELECT fingerprint, normalized_message as message
    FROM error_occurrences
    WHERE last_seen_at >= ?
    LIMIT 10000
  `
    )
    .bind(cutoff)
    .all<{ fingerprint: string; message: string | null }>();

  const errors = result.results;
  const testFn = compilePattern(rule);

  const matchedFingerprints: string[] = [];
  let matchCount = 0;

  for (const error of errors) {
    if (error.message && testFn(error.message)) {
      matchCount++;
      if (matchedFingerprints.length < 100) {
        matchedFingerprints.push(error.fingerprint);
      }
    }
  }

  const totalErrors = errors.length;
  const matchRate = totalErrors > 0 ? matchCount / totalErrors : 0;
  const overMatching = matchRate > OVER_MATCHING_THRESHOLD;

  log.info('Backtest complete', {
    patternId,
    matchCount,
    totalErrors,
    matchRate: (matchRate * 100).toFixed(1) + '%',
    overMatching,
  });

  return {
    patternId,
    matchCount,
    totalErrors,
    matchRate,
    matchedFingerprints,
    overMatching,
    runAt: Math.floor(Date.now() / 1000),
  };
}

/**
 * Store backtest result in D1
 */
export async function storeBacktestResult(
  db: D1Database,
  result: BacktestResult,
  log: Logger
): Promise<void> {
  try {
    await db
      .prepare(
        `
      UPDATE transient_pattern_suggestions
      SET
        backtest_match_count = ?,
        backtest_total_errors = ?,
        backtest_match_rate = ?,
        backtest_run_at = ?,
        updated_at = unixepoch()
      WHERE id = ?
    `
      )
      .bind(
        result.matchCount,
        result.totalErrors,
        result.matchRate,
        result.runAt,
        result.patternId
      )
      .run();

    // Log audit event
    const action = result.overMatching ? 'backtest-failed' : 'backtest-passed';
    await db
      .prepare(
        `
      INSERT INTO pattern_audit_log (id, pattern_id, action, actor, reason, metadata)
      VALUES (?, ?, ?, 'system:backtest', ?, ?)
    `
      )
      .bind(
        `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        result.patternId,
        action,
        result.overMatching
          ? `Over-matching: ${(result.matchRate * 100).toFixed(1)}% match rate`
          : `Passed: ${(result.matchRate * 100).toFixed(1)}% match rate`,
        JSON.stringify({
          matchCount: result.matchCount,
          totalErrors: result.totalErrors,
          matchRate: result.matchRate,
        })
      )
      .run();

    log.info('Stored backtest result', {
      patternId: result.patternId,
      action,
    });
  } catch (error) {
    log.error('Failed to store backtest result', error, { patternId: result.patternId });
  }
}
