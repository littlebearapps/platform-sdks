# Contributing to Platform SDKs

Thanks for your interest in contributing. This document covers development setup, code style, and how to submit changes.

## Development Setup

**Prerequisites**: Node.js 20+ and npm.

```bash
git clone https://github.com/littlebearapps/platform-sdks.git
cd platform-sdks
npm install
```

This is an npm workspaces monorepo. `npm install` at the root installs dependencies for both packages.

## Monorepo Structure

```
platform-sdks/
├── packages/
│   ├── consumer-sdk/   # Runtime library (ships raw .ts, no build step)
│   └── admin-sdk/      # CLI scaffolder (requires build: npm run build)
├── docs/               # Documentation
├── .github/workflows/  # CI, auto-publish, consumer check
└── tsconfig.json       # Root project references
```

**Consumer SDK** ships raw TypeScript source files — wrangler bundles them at deploy time. There is no build step.

**Admin SDK** compiles with `tsc` before publishing. Run `npm run build` in `packages/admin-sdk/` after making changes.

## Running Tests

```bash
# All packages from root
npm test

# Consumer SDK only
cd packages/consumer-sdk && npx vitest run

# Consumer SDK with coverage (mirrors CI)
cd packages/consumer-sdk && npx vitest run tests/ \
  --coverage --coverage.include='src/**' \
  --coverage.thresholds.lines=85

# Admin SDK only
cd packages/admin-sdk && npx vitest run
```

**Coverage thresholds**: Consumer SDK enforces 85% line coverage in CI. Admin SDK has 59 tests across 5 files.

## Type Checking

```bash
# All packages
npm run typecheck

# Individual package
cd packages/consumer-sdk && npx tsc --noEmit
cd packages/admin-sdk && npx tsc --noEmit
```

## Code Style

- **TypeScript strict mode** — no `any` (use `unknown`), explicit return types on exported functions
- **Import order**: external packages, then types, then internal (`./`)
- **Naming**: `camelCase` for variables and functions, `PascalCase` for types and classes, `SCREAMING_SNAKE_CASE` for constants
- **Australian English** in user-facing strings and documentation: initialise, realise, colour, licence (noun), recognised, organised
- **No emoji** in code or documentation body text

## Branching and Commits

- **Feature branches**: `feature/*` (e.g. `feature/add-workflow-proxy`)
- **Fix branches**: `fix/*` (e.g. `fix/circuit-breaker-cache`)
- **Docs branches**: `docs/*` (e.g. `docs/upgrade-guide`)
- **Conventional commits**: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `perf:`, `test:`

Conventional commit prefixes drive automatic version bumping:

| Prefix | Version Bump |
|--------|-------------|
| `feat:` | Minor (0.1.0 → 0.2.0) |
| `fix:`, `perf:`, `refactor:` | Patch (0.1.0 → 0.1.1) |
| `feat!:` or `BREAKING CHANGE` | Major (0.1.0 → 1.0.0) |
| `chore:`, `docs:`, `test:`, `ci:` | No bump |

## Publishing

Both packages are **automatically published** by CI on push to `main` when the local version differs from npm. Do not manually bump versions — the `version-bump.yml` workflow handles this from conventional commit prefixes.

If you need to publish the Admin SDK, ensure it builds first (`npm run build` in `packages/admin-sdk/`).

## Adding Transient Error Patterns (Consumer SDK)

Patterns in `src/patterns.ts` are static — zero I/O, pure regex matching. To add a new pattern:

1. Add to the `TRANSIENT_ERROR_PATTERNS` array in `packages/consumer-sdk/src/patterns.ts`
2. Place more specific patterns before broader ones (first match wins)
3. Add test cases in `packages/consumer-sdk/tests/patterns.test.ts`
4. Run `cd packages/consumer-sdk && npx vitest run tests/patterns.test.ts`

Dynamic patterns (AI-discovered, loaded from KV at runtime) are managed through the pattern-discovery worker, not this repo.

## Adding Templates (Admin SDK)

Templates live in `packages/admin-sdk/templates/`:

- `shared/` — All tiers (services.yaml, budgets.yaml, platform-usage worker, core migrations)
- `standard/` — Standard tier additions (error-collector, sentinel)
- `full/` — Full tier additions (pattern-discovery, alert-router, notifications, search, settings)

To add a new template:

1. Create the file in the appropriate tier directory
2. Use `.hbs` extension for Handlebars templates, plain extension for verbatim copies
3. Register in `packages/admin-sdk/src/templates.ts` under the relevant tier constant
4. Update test assertions in `packages/admin-sdk/tests/scaffold.test.ts` for new file counts
5. Update the Admin SDK CHANGELOG

## Submitting Changes

1. Fork the repo and create a feature branch
2. Make your changes with tests
3. Run `npm test` and `npm run typecheck` from the root
4. Commit with a conventional commit message
5. Open a PR — the CI workflow runs automatically

Please mention which package your change affects in the PR description (consumer-sdk, admin-sdk, or both).

## Questions?

Open a [GitHub issue](https://github.com/littlebearapps/platform-sdks/issues) or check the [documentation](docs/).
