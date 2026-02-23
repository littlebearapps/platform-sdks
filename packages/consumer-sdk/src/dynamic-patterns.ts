/// <reference types="@cloudflare/workers-types" />

/**
 * Dynamic Patterns
 *
 * AI-discovered transient error patterns loaded from KV at runtime.
 * Separate from static patterns (patterns.ts) because these require KV I/O.
 *
 * Pattern lifecycle: pending -> shadow -> ready for review -> approved -> KV cache -> runtime
 *
 * Supports a constrained DSL with 4 types: contains, startsWith, statusCode, regex.
 * Regex patterns have a 200-char safety limit to prevent ReDoS.
 *
 * Multi-account utilities (exportDynamicPatterns/importDynamicPatterns) enable
 * cross-account pattern sync via sync-config or platform-agent.
 *
 * @example
 * ```typescript
 * import { loadDynamicPatterns, classifyWithDynamicPatterns } from '@littlebearapps/platform-consumer-sdk/dynamic-patterns';
 *
 * const patterns = await loadDynamicPatterns(env.PLATFORM_CACHE);
 * const result = classifyWithDynamicPatterns('Custom error message', patterns);
 * if (result) {
 *   console.log(`Dynamic match: ${result.category} (${result.patternId})`);
 * }
 * ```
 */

// =============================================================================
// TYPES
// =============================================================================

/** Dynamic pattern rule from pattern-discovery system */
export interface DynamicPatternRule {
  type: 'contains' | 'startsWith' | 'statusCode' | 'regex';
  value: string;
  category: string;
  scope: string;
  id?: string;
}

/** Compiled pattern ready for classification */
export interface CompiledPattern {
  test: (message: string) => boolean;
  category: string;
  id?: string;
}

/** Classification result from dynamic pattern matching */
export interface ClassificationResult {
  category: string;
  source: 'dynamic';
  patternId?: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** KV key for approved dynamic patterns — useful for sync-config and multi-account */
export const DYNAMIC_PATTERNS_KV_KEY = 'PATTERNS:DYNAMIC:APPROVED';

// =============================================================================
// COMPILATION
// =============================================================================

/**
 * Compile a single dynamic pattern rule to a test function.
 * Uses the constrained DSL to ensure safety (no arbitrary regex execution).
 *
 * @returns Compiled pattern or null if compilation fails
 */
function compileDynamicPattern(rule: DynamicPatternRule): CompiledPattern | null {
  try {
    switch (rule.type) {
      case 'contains': {
        const tokens = rule.value.toLowerCase().split(/\s+/);
        return {
          test: (msg: string) => {
            const lowerMsg = msg.toLowerCase();
            return tokens.every((token) => lowerMsg.includes(token));
          },
          category: rule.category,
          id: rule.id,
        };
      }
      case 'startsWith': {
        const prefix = rule.value.toLowerCase();
        return {
          test: (msg: string) => msg.toLowerCase().startsWith(prefix),
          category: rule.category,
          id: rule.id,
        };
      }
      case 'statusCode': {
        const code = rule.value;
        const pattern = new RegExp(`\\b${code}\\b`);
        return {
          test: (msg: string) => pattern.test(msg),
          category: rule.category,
          id: rule.id,
        };
      }
      case 'regex': {
        // Add safety limit to prevent ReDoS
        if (rule.value.length > 200) {
          console.warn(`Skipping overly long regex pattern: ${rule.category}`);
          return null;
        }
        const pattern = new RegExp(rule.value, 'i');
        return {
          test: (msg: string) => pattern.test(msg),
          category: rule.category,
          id: rule.id,
        };
      }
      default:
        return null;
    }
  } catch (error) {
    console.warn(`Failed to compile pattern for ${rule.category}:`, error);
    return null;
  }
}

/**
 * Compile an array of dynamic pattern rules into test functions.
 * Invalid rules are silently dropped (logged via console.warn).
 *
 * @param rules - Array of dynamic pattern rules from D1/KV
 * @returns Array of compiled patterns ready for classification
 */
export function compileDynamicPatterns(rules: DynamicPatternRule[]): CompiledPattern[] {
  const compiled: CompiledPattern[] = [];
  for (const rule of rules) {
    const pattern = compileDynamicPattern(rule);
    if (pattern) {
      compiled.push(pattern);
    }
  }
  return compiled;
}

// =============================================================================
// IN-MEMORY CACHE
// =============================================================================

let dynamicPatternsCache: CompiledPattern[] | null = null;
let dynamicPatternsCacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// =============================================================================
// LOADING
// =============================================================================

/**
 * Load dynamic patterns from KV and compile them.
 * Uses in-memory cache (5-minute TTL) to avoid repeated KV reads within worker lifetime.
 *
 * @param kv - KV namespace containing approved patterns
 * @returns Compiled patterns ready for classification
 */
export async function loadDynamicPatterns(kv: KVNamespace): Promise<CompiledPattern[]> {
  const now = Date.now();
  if (dynamicPatternsCache && now - dynamicPatternsCacheTime < CACHE_TTL_MS) {
    return dynamicPatternsCache;
  }

  try {
    const cached = await kv.get(DYNAMIC_PATTERNS_KV_KEY);
    if (!cached) {
      dynamicPatternsCache = [];
      dynamicPatternsCacheTime = now;
      return [];
    }

    const rules = JSON.parse(cached) as DynamicPatternRule[];
    const compiled = compileDynamicPatterns(rules);

    dynamicPatternsCache = compiled;
    dynamicPatternsCacheTime = now;
    return compiled;
  } catch (error) {
    console.error('Failed to load dynamic patterns:', error);
    return dynamicPatternsCache || [];
  }
}

/**
 * Clear the in-memory dynamic patterns cache.
 * Call after pattern updates or for testing.
 */
export function clearDynamicPatternsCache(): void {
  dynamicPatternsCache = null;
  dynamicPatternsCacheTime = 0;
}

// =============================================================================
// CLASSIFICATION
// =============================================================================

/**
 * Classify an error message using dynamic patterns only.
 * For combined static + dynamic classification, use classifyErrorWithSource() in fingerprint.ts.
 *
 * @param message - Error message to classify
 * @param patterns - Pre-loaded compiled dynamic patterns
 * @returns Classification result or null if no match
 */
export function classifyWithDynamicPatterns(
  message: string,
  patterns: CompiledPattern[]
): ClassificationResult | null {
  for (const compiled of patterns) {
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

// =============================================================================
// MULTI-ACCOUNT UTILITIES
// =============================================================================

/**
 * Export raw dynamic patterns from KV for cross-account transfer.
 * Returns the JSON string as-is (no compilation) for writing to another KV.
 *
 * @param kv - Source KV namespace with approved patterns
 * @returns Raw JSON string or null if no patterns are cached
 */
export async function exportDynamicPatterns(kv: KVNamespace): Promise<string | null> {
  return await kv.get(DYNAMIC_PATTERNS_KV_KEY);
}

/**
 * Import dynamic patterns into a KV namespace.
 * Validates structure AND compiles each rule as a safety gate:
 * - Checks required fields (type, value, category)
 * - Compiles to verify regex validity + applies 200-char limit for regex type
 * - Silently drops rules that fail compilation (matches loadDynamicPatterns behaviour)
 *
 * TTL matches pattern-discovery's 7-day safety net.
 *
 * @param kv - Target KV namespace
 * @param patternsJson - Raw JSON string from exportDynamicPatterns()
 * @returns Count of imported and dropped rules
 */
export async function importDynamicPatterns(
  kv: KVNamespace,
  patternsJson: string
): Promise<{ imported: number; dropped: number }> {
  const rules = JSON.parse(patternsJson) as DynamicPatternRule[];

  // Structural validation
  const validTypes = new Set(['contains', 'startsWith', 'statusCode', 'regex']);
  const structurallyValid = rules.filter(
    (r) => r.type && r.value && r.category && validTypes.has(r.type)
  );

  // Compilation gate: verify each rule compiles (catches invalid regex, ReDoS-length limit)
  const compilable = structurallyValid.filter((r) => compileDynamicPatterns([r]).length > 0);

  await kv.put(DYNAMIC_PATTERNS_KV_KEY, JSON.stringify(compilable), { expirationTtl: 604800 });
  clearDynamicPatternsCache();

  return { imported: compilable.length, dropped: rules.length - compilable.length };
}
