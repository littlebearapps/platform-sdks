# Error Patterns

The SDK provides two pattern systems for classifying errors as transient (expected operational errors that don't need individual attention).

## Static Patterns (`/patterns`)

125 built-in regex patterns that classify common Cloudflare and API errors. Zero I/O — pure in-memory matching. No KV, no network calls.

```typescript
import { classifyErrorAsTransient } from '@littlebearapps/platform-consumer-sdk/patterns';

const result = classifyErrorAsTransient('quotaExceeded: Daily limit reached');
// { isTransient: true, category: 'quota-exhausted' }

const result2 = classifyErrorAsTransient('TypeError: Cannot read properties of null');
// { isTransient: false }
```

### Pattern Categories

| Category | Examples |
|----------|---------|
| `quota-exhausted` | `QUOTA.*EXHAUSTED`, `quotaExceeded`, `dailyLimitExceeded` |
| `rate-limited` | `RATE.*LIMITED`, `429`, `Too Many Requests` |
| `service-unavailable` | `503`, `bad-gateway`, `502` |
| `timeout` | `TIMEOUT`, `timed out`, `deadline exceeded` |
| `connection-refused` | `ECONNREFUSED`, `connection refused` |
| `connection-timeout` | `ETIMEDOUT`, `ESOCKETTIMEDOUT` |
| `connection-reset` | `ECONNRESET`, `socket hang up` |
| `dns-not-found` | `ENOTFOUND`, `getaddrinfo` |
| `d1-rate-limited` | `D1.*rate.*limit`, `too many requests` |
| `d1-inefficient-query` | `D1.*inefficient.*query`, `SQLITE_BUSY` |
| `do-reset` | `Durable Object reset`, `stub was broken` |
| `deployment-reset` | `The script will be re-initialized` |
| `do-stub-error` | `stub was broken`, `Durable Object has been evicted` |
| `do-destroyed` | `DO.*destroyed`, `Durable Object.*not found` |
| `r2-internal-error` | `R2.*internal.*error` |
| `cross-request-promise` | `Cannot perform.*after responding` |
| `youtube-quota` | YouTube-specific quota errors |
| `scan-timeout` | Scanner-specific timeout patterns |
| `budget-exhausted` | Circuit breaker budget patterns |
| `auth-rejected-workersdev` | `.workers.dev` auth rejection patterns |

The full list is in `src/patterns.ts`. Patterns are checked in order — first match wins.

### Accessing Raw Patterns

```typescript
import { TRANSIENT_ERROR_PATTERNS } from '@littlebearapps/platform-consumer-sdk/patterns';

console.log(TRANSIENT_ERROR_PATTERNS.length); // 125

for (const pattern of TRANSIENT_ERROR_PATTERNS) {
  console.log(pattern.category, pattern.pattern);
}
```

## Dynamic Patterns (`/dynamic-patterns`)

AI-discovered patterns loaded from KV at runtime. These are managed by the pattern-discovery worker (Full tier) and go through a human-in-the-loop approval process before being loaded by the SDK.

```typescript
import { loadDynamicPatterns, classifyWithDynamicPatterns } from '@littlebearapps/platform-consumer-sdk/dynamic-patterns';

// Load approved patterns (5-minute in-memory cache)
const patterns = await loadDynamicPatterns(env.PLATFORM_CACHE);

// Classify an error message
const result = classifyWithDynamicPatterns('Custom error from my API', patterns);
// { category: 'my-api-error', source: 'dynamic', patternId: 'pat_abc123' }
// or null if no match
```

### Pattern DSL

Dynamic patterns use a constrained DSL with four rule types:

| Type | Description | Example |
|------|-------------|---------|
| `contains` | All whitespace-split tokens must appear (case-insensitive) | `"quota exceeded daily"` matches "Daily quota exceeded for user" |
| `startsWith` | String prefix match (case-insensitive) | `"Error: API rate"` matches "Error: API rate limit hit" |
| `statusCode` | Word-boundary match on status code | `"429"` matches "HTTP 429 Too Many Requests" |
| `regex` | Arbitrary regex (200-char limit, ReDoS prevention) | `"timeout.*\d+ms"` matches "timeout after 5000ms" |

### Pattern Lifecycle

```
AI Discovery (2am UTC daily)
    │  Clusters unclassified errors, generates pattern suggestions
    ↓
Pending (24 hours)
    │  New patterns wait before shadow evaluation
    ↓
Shadow (3-14 days)
    │  Patterns are tested against live errors, match evidence collected
    │  NO automatic promotion — marked "ready for review" when evidence sufficient
    ↓
Human Review
    │  Approve or reject via pattern-discovery API
    ↓
Approved → KV PATTERNS:DYNAMIC:APPROVED
    │  Loaded by error-collector at runtime (merged with static patterns)
    ↓
Active Classification
```

### KV Storage

Approved patterns are stored as a JSON array under the key `PATTERNS:DYNAMIC:APPROVED` in `PLATFORM_CACHE`. The SDK caches this in memory for 5 minutes.

### Cache Management

```typescript
import { clearDynamicPatternsCache } from '@littlebearapps/platform-consumer-sdk/dynamic-patterns';

// Force reload on next call to loadDynamicPatterns
clearDynamicPatternsCache();
```

### Multi-Account Sync

Export patterns from one account and import to another:

```typescript
import { exportDynamicPatterns, importDynamicPatterns } from '@littlebearapps/platform-consumer-sdk/dynamic-patterns';

// Export from source account
const json = await exportDynamicPatterns(sourceKv);

// Import to target account
const { imported, dropped } = await importDynamicPatterns(targetKv, json);
console.log(`Imported ${imported}, dropped ${dropped} invalid patterns`);
```

`importDynamicPatterns` validates the structure AND compiles each pattern as a safety gate before writing. Invalid patterns are silently dropped. The import writes with a 7-day TTL (604,800 seconds) and clears the in-memory cache.

## Using Both Together

The error-collector worker (Standard/Full tier) uses both pattern systems:

1. Check static patterns first (zero I/O, faster)
2. If no match, check dynamic patterns (KV read, cached)
3. If transient, apply deduplication (one issue per category per day)
4. If not transient, create a GitHub issue

In your own code, you can combine them:

```typescript
import { classifyErrorAsTransient } from '@littlebearapps/platform-consumer-sdk/patterns';
import { loadDynamicPatterns, classifyWithDynamicPatterns } from '@littlebearapps/platform-consumer-sdk/dynamic-patterns';

async function isTransient(message: string, kv: KVNamespace): Promise<boolean> {
  // Static patterns first (no I/O)
  const staticResult = classifyErrorAsTransient(message);
  if (staticResult.isTransient) return true;

  // Dynamic patterns (KV read, 5-min cache)
  const dynamicPatterns = await loadDynamicPatterns(kv);
  const dynamicResult = classifyWithDynamicPatterns(message, dynamicPatterns);
  return dynamicResult !== null;
}
```
