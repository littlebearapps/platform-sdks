# Changelog

## [1.0.0] - 2026-02-23

### Changed
- **BREAKING**: Package renamed from `@littlebearapps/platform-sdk` to `@littlebearapps/platform-consumer-sdk`
- **BREAKING**: All sub-path exports renamed accordingly:
  - `@littlebearapps/platform-sdk/middleware` → `@littlebearapps/platform-consumer-sdk/middleware`
  - `@littlebearapps/platform-sdk/patterns` → `@littlebearapps/platform-consumer-sdk/patterns`
  - `@littlebearapps/platform-sdk/dynamic-patterns` → `@littlebearapps/platform-consumer-sdk/dynamic-patterns`
  - `@littlebearapps/platform-sdk/heartbeat` → `@littlebearapps/platform-consumer-sdk/heartbeat`
  - `@littlebearapps/platform-sdk/retry` → `@littlebearapps/platform-consumer-sdk/retry`
  - `@littlebearapps/platform-sdk/costs` → `@littlebearapps/platform-consumer-sdk/costs`
- Repository renamed from `platform-sdk` to `platform-sdks`
- Directory renamed from `packages/sdk` to `packages/consumer-sdk`

### Migration
```bash
npm uninstall @littlebearapps/platform-sdk
npm install @littlebearapps/platform-consumer-sdk
# Then find-replace all imports
```

## [0.3.0] - 2026-02-23

### Added
- **Rebranding**: Display name updated to "Platform Consumer SDK" (npm package name unchanged)
- Comprehensive README with full API documentation

### Changed
- Version bump from 0.2.0 to 0.3.0

## [0.2.0] - 2026-02-22

### Added
- **`./middleware` export**: Project-level circuit breaker middleware (Hono-compatible)
  - `createCircuitBreakerMiddleware()` factory with `skipPaths` support
  - `checkProjectCircuitBreaker()` / `checkProjectCircuitBreakerDetailed()`
  - `getCircuitBreakerStates()` for multi-project queries
  - `setProjectStatus()` / `getProjectStatus()` for state management
  - `isGlobalStopActive()` / `setGlobalStop()` global kill switch
  - `CB_PROJECT_KEYS` pre-defined keys for Scout, Brand Copilot, etc.

- **`./patterns` export**: 125 static transient error patterns (zero I/O)
  - `classifyErrorAsTransient()` for quota, rate-limit, timeout, DO, YouTube errors
  - `TRANSIENT_ERROR_PATTERNS` array with regex + category

- **`./dynamic-patterns` export**: AI-discovered pattern loading from KV
  - `loadDynamicPatterns()` with 5-minute in-memory cache
  - `compileDynamicPatterns()` with ReDoS-safe validation (200-char limit)
  - `classifyWithDynamicPatterns()` for runtime classification
  - `exportDynamicPatterns()` / `importDynamicPatterns()` for multi-account sync
  - Constrained DSL: `contains`, `startsWith`, `statusCode`, `regex`

## [0.1.0] - 2026-01-15

### Added
- **Core wrappers**: `withFeatureBudget()`, `withCronBudget()`, `withQueueBudget()`
- **Circuit breaker**: 3-tier hierarchy (global > project > feature), `CircuitBreakerError`
- **Telemetry**: Automatic metrics collection, queue-based reporting, `completeTracking()`
- **Binding proxies**: D1, KV, R2, AI, Vectorize, Queue, Durable Object, Workflow
- **Distributed tracing**: W3C traceparent support, span management
- **Logging**: Structured logger with correlation IDs
- **Error tracking**: `categoriseError()`, `reportError()`, `withErrorTracking()`
- **Timeout utilities**: `withTimeout()`, `withTrackedTimeout()`, `withRequestTimeout()`
- **Service client**: Cross-worker correlation propagation
- **AI Gateway**: Fetch wrapper with provider/model extraction and usage reporting
- **DO heartbeat**: `withHeartbeat()` Durable Object class wrapper
- **Cost calculations**: Cloudflare pricing tiers, hourly/daily cost helpers
- **Retry**: `withExponentialBackoff()` (3 attempts, exponential delay)
- **Heartbeat**: `pingHeartbeat()` for Gatus/uptime monitoring
- **Health check**: Dual-plane validation (KV + queue)
