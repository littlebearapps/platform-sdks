# Changelog

## [1.0.0] - 2026-02-23

### Changed
- **BREAKING**: Package renamed from `@littlebearapps/create-platform` to `@littlebearapps/platform-admin-sdk`
- **BREAKING**: Binary renamed from `create-platform` to `platform-admin-sdk`
- All template references updated to use `@littlebearapps/platform-consumer-sdk`
- Repository renamed from `platform-sdk` to `platform-sdks`
- Directory renamed from `packages/create-platform` to `packages/admin-sdk`

### Added
- **CLI flags**: Non-interactive scaffolding via `--tier`, `--github-org`, `--gatus-url`, `--default-assignee`, `--skip-prompts`
- Commander-based flag parsing (replaces raw `process.argv`)
- 14 CLI flag tests (21 total)

### Migration
```bash
# Old:
npx @littlebearapps/create-platform my-project
# New:
npx @littlebearapps/platform-admin-sdk my-project
```

## [0.1.0] - 2026-02-23

### Added
- **Rebranding**: Display name updated to "Platform Admin SDK"
- **Worker extraction**: 62 worker `.ts` files extracted into scaffolder templates
- **Three-tier architecture**:
  - Minimal (97 files): platform-usage worker + 8 root libs + 3 cross-boundary shims + usage framework
  - Standard (+14 files): error-collector + sentinel + error-collector libs + slack-alerts
  - Full (+18 files): pattern-discovery + alert-router + notifications + search + settings + pattern-discovery libs
- Templates manifest (`templates.ts`) with all entries
- 8 unit tests including worker file counts per tier and template file existence validation
- Interactive CLI with project name, slug, GitHub org, tier selection, Gatus URL, assignee prompts
- Handlebars templating for wrangler configs and YAML files
- D1 migrations (5 shared + 1 standard + 2 full = 8 total)
- Post-scaffold steps documentation

## [0.1.0] - 2026-02-20

### Added
- Initial scaffolder with basic template generation
- Minimal tier only
- CLI prompts for project configuration
