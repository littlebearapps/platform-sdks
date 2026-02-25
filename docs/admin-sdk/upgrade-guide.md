# Upgrade Guide

How to update your Platform backend to the latest Admin SDK version, upgrade tiers, and adopt existing projects.

## Upgrading (v1.1.0+)

If your project has a `.platform-scaffold.json` manifest file:

```bash
cd my-platform
npx @littlebearapps/platform-admin-sdk upgrade
```

### What Happens

The upgrade command performs a **three-way merge** for each SDK-managed file:

1. **Reads the manifest** — gets the SHA-256 hash of each file as originally generated
2. **Hashes your current file** — computes SHA-256 of what's on disk now
3. **Compares**:
   - **Hashes match** → File is unmodified. Safe to update with the new version.
   - **Hashes differ** → You've customised this file. The upgrade **skips it** with a warning.
   - **File doesn't exist on disk** → File was deleted. The upgrade recreates it.
   - **New file in SDK** → File didn't exist before. Created fresh.

### Preview Changes

Always preview before applying:

```bash
npx @littlebearapps/platform-admin-sdk upgrade --dry-run
```

This shows exactly which files would be created, updated, or skipped — without writing anything.

### Handling Skipped Files

When a file is skipped (you've customised it), the upgrade prints:

```
SKIP workers/platform-usage.ts (modified — compare manually)
```

To manually update a skipped file:

1. Check the SDK's latest version of the file (in the upgrade output or the SDK source)
2. Diff against your version
3. Apply the relevant changes manually
4. After updating, the next `upgrade` will recognise your file as matching the new version

### Migration Renumbering

If you've created your own D1 migrations (e.g. `008_my_custom.sql`), the SDK detects the highest migration number and renumbers new SDK migrations above it:

```
Existing: 001-007 (SDK) + 008 (yours)
New SDK migrations: 009_pattern_discovery.sql (renumbered from 006)
```

This prevents migration number conflicts.

## Tier Upgrade

Upgrade to a higher tier in the same command:

```bash
# Upgrade from minimal to standard
npx @littlebearapps/platform-admin-sdk upgrade --tier standard

# Upgrade from standard to full
npx @littlebearapps/platform-admin-sdk upgrade --tier full
```

This adds the new tier's files (workers, migrations, wrangler configs) without re-generating shared files. Existing shared files follow the normal three-way merge.

After a tier upgrade:

1. Create the additional Cloudflare resources (KV namespaces, etc.)
2. Update resource IDs in the new wrangler config files
3. Configure secrets for new workers
4. Apply new D1 migrations: `npx wrangler d1 migrations apply my-platform-metrics --remote`
5. Run `npm run sync:config`
6. Deploy new workers

## Adopting Pre-v1.1.0 Projects

Projects scaffolded before v1.1.0 don't have a `.platform-scaffold.json` manifest. The `adopt` command creates one:

```bash
npx @littlebearapps/platform-admin-sdk adopt . --tier minimal --project-name my-platform --skip-prompts
```

### What Adopt Does

1. **Scans your project** for files that match known SDK-generated patterns
2. **Hashes each recognised file** — stores the SHA-256 as the "original" state
3. **Writes `.platform-scaffold.json`** — the manifest with your current files as the baseline
4. **Does not modify any files** — adopt is read-only (except for writing the manifest)

After adopting, you can run `upgrade` normally:

```bash
npx @littlebearapps/platform-admin-sdk upgrade
```

### Adopt Options

| Flag | Description |
|------|------------|
| `--tier <tier>` | Your current infrastructure tier |
| `--project-name <name>` | Project name (for manifest metadata) |
| `--project-slug <slug>` | Project slug (auto-derived from name if omitted) |
| `--github-org <org>` | GitHub organisation |
| `--skip-prompts` | Non-interactive mode |

## The Manifest File

`.platform-scaffold.json` is the source of truth for the upgrade system. It looks like:

```json
{
  "sdkVersion": "1.2.0",
  "tier": "standard",
  "context": {
    "projectName": "My Platform",
    "projectSlug": "my-platform",
    "githubOrg": "myorg",
    "defaultAssignee": "myuser",
    "gatusUrl": "https://status.example.com"
  },
  "files": {
    "platform/config/services.yaml": "a1b2c3d4...",
    "platform/config/budgets.yaml": "e5f6a7b8...",
    "workers/platform-usage.ts": "c9d0e1f2...",
    "workers/error-collector.ts": "3a4b5c6d..."
  },
  "highestScaffoldMigration": 7
}
```

**Important**: Commit this file to git. Without it, `upgrade` cannot determine which files you've modified.

## Workflow Summary

### New project

```bash
npx @littlebearapps/platform-admin-sdk my-platform --tier standard
# → Creates project + manifest
# → Deploy (see quickstart)
```

### Update to latest SDK

```bash
npx @littlebearapps/platform-admin-sdk upgrade --dry-run
# → Review changes
npx @littlebearapps/platform-admin-sdk upgrade
# → Apply changes
npx wrangler d1 migrations apply my-platform-metrics --remote
# → Apply any new migrations
npx wrangler deploy -c wrangler.my-platform-usage.jsonc
# → Redeploy updated workers
```

### Upgrade tier

```bash
npx @littlebearapps/platform-admin-sdk upgrade --tier full --dry-run
# → Review what will be added
npx @littlebearapps/platform-admin-sdk upgrade --tier full
# → Create new tier's resources in Cloudflare
# → Update resource IDs in new wrangler configs
# → Configure secrets
# → Apply new migrations
# → Deploy new workers
```

### Adopt existing project

```bash
npx @littlebearapps/platform-admin-sdk adopt . --tier standard
# → Creates manifest from existing files
npx @littlebearapps/platform-admin-sdk upgrade
# → Now upgrade works normally
```
