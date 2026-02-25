# CI Workflow Reference

The `consumer-check.yml` reusable workflow validates Platform SDK integration in consumer repos. It runs automatically on push and pull request.

## Quick Setup

Add to your consumer repo:

```yaml
# .github/workflows/sdk-check.yml
name: SDK Check
on: [push, pull_request]
jobs:
  sdk-check:
    uses: littlebearapps/platform-sdks/.github/workflows/consumer-check.yml@main
    with:
      project-name: my-project
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `project-name` | Yes | — | Project slug for feature ID validation (e.g. `scout`, `brand-copilot`) |
| `node-version` | No | `20` | Node.js version |
| `wrangler-config-pattern` | No | `wrangler*.jsonc` | Glob for wrangler config files |
| `source-pattern` | No | `workers/**/*.ts,src/**/*.ts` | Comma-separated source file globs |
| `check-middleware` | No | `true` | Whether to check circuit breaker middleware |
| `strict-mode` | No | `false` | Fail on warnings (not just errors) |

## Checks

The workflow runs 5 check categories. Each produces PASS, WARN, or FAIL.

### 1. SDK Installation

Verifies `@littlebearapps/platform-consumer-sdk` is installed in `node_modules`. Reports the installed version.

- **PASS**: SDK found, reports version
- **FAIL**: SDK package not found

### 2. Wrangler Config

Scans all files matching `wrangler-config-pattern` for required bindings:

| Check | What It Looks For |
|-------|------------------|
| `PLATFORM_CACHE` | KV binding named `PLATFORM_CACHE` |
| Telemetry queue | Queue named `platform-telemetry` or binding `TELEMETRY_QUEUE` |
| Observability | `"observability": { "enabled": true }` |
| Tail consumers | `"tail_consumers"` configuration |

- **PASS**: All configs have the binding
- **WARN**: Some configs missing (reports count)

### 3. SDK Usage

Scans source files for SDK integration patterns:

| Check | What It Looks For |
|-------|------------------|
| Budget wrappers | `withFeatureBudget`, `withCronBudget`, or `withQueueBudget` calls |
| Feature IDs | String literals matching `'{project-name}:*:*'` format |
| CB error handling | `CircuitBreakerError` catch blocks |

- **PASS**: Pattern found
- **FAIL**: No budget wrappers found (critical — SDK not being used)
- **WARN**: Feature IDs don't match project name, or no CB error handling

### 4. Cost Safety

Static analysis for common cost traps:

| Check | What It Detects | Severity |
|-------|----------------|----------|
| Loop inserts | `.run()` calls within 10 lines of `for`/`while` loops | WARN |
| ON CONFLICT | `INSERT INTO` without `ON CONFLICT` clause | WARN |
| SELECT LIMIT | `SELECT` without `LIMIT` (>5 instances) | WARN |
| SQL injection | Template literals containing SQL keywords (`${...}SELECT`) | WARN |

These are heuristic checks — they may produce false positives. Use `strict-mode: true` to make warnings fail the build.

### 5. Middleware Check

Verifies circuit breaker middleware comes from the SDK:

| Check | What It Detects |
|-------|----------------|
| Local CB file | Files named `*circuit-breaker*` outside `node_modules` |
| SDK import | Import from `@littlebearapps/platform-consumer-sdk/middleware` |
| Re-export | Local file that re-exports from SDK (acceptable) |

- **PASS**: Using SDK middleware directly, or local file is a thin re-export
- **WARN**: Local circuit breaker implementation found — should migrate to SDK

## Output

### GitHub Actions Summary

The workflow produces a markdown table in the GitHub Actions step summary:

| Check | Status | Details |
|-------|--------|---------|
| SDK installed | PASS | v1.1.0 |
| KV: PLATFORM_CACHE | PASS | All 3 configs have PLATFORM_CACHE |
| Queue: telemetry | WARN | 1/3 configs missing platform-telemetry queue |
| Budget wrappers | PASS | Found in 5 file(s) |
| Feature IDs | PASS | 8 unique IDs matching myapp:*:* |
| D1 loop inserts | PASS | No .run() inside loop constructs |

### Exit Codes

| Condition | Exit Code |
|-----------|-----------|
| All checks pass | 0 |
| Any FAIL | 1 |
| Warnings + `strict-mode: true` | 1 |
| Warnings + `strict-mode: false` | 0 |

## Examples

### Minimal

```yaml
jobs:
  sdk-check:
    uses: littlebearapps/platform-sdks/.github/workflows/consumer-check.yml@main
    with:
      project-name: my-project
```

### Strict Mode

Fail the build on any warning:

```yaml
jobs:
  sdk-check:
    uses: littlebearapps/platform-sdks/.github/workflows/consumer-check.yml@main
    with:
      project-name: my-project
      strict-mode: true
```

### Custom Source Paths

For projects with non-standard directory structure:

```yaml
jobs:
  sdk-check:
    uses: littlebearapps/platform-sdks/.github/workflows/consumer-check.yml@main
    with:
      project-name: my-project
      source-pattern: 'src/**/*.ts,lib/**/*.ts,handlers/**/*.ts'
      wrangler-config-pattern: 'wrangler.jsonc'
```

### Skip Middleware Check

For projects that don't use project-level circuit breakers:

```yaml
jobs:
  sdk-check:
    uses: littlebearapps/platform-sdks/.github/workflows/consumer-check.yml@main
    with:
      project-name: my-project
      check-middleware: false
```

### Combined with Other CI

```yaml
name: CI
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with: { node-version: '20' }
      - run: npm ci
      - run: npm test

  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with: { node-version: '20' }
      - run: npm ci
      - run: npx tsc --noEmit

  sdk-check:
    uses: littlebearapps/platform-sdks/.github/workflows/consumer-check.yml@main
    with:
      project-name: my-project
      strict-mode: true
```
