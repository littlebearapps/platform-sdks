# Migrating from v0

This guide covers migrating from the old package names to the current ones.

## Package Renames

| Old Package | New Package | Type |
|-------------|-------------|------|
| `@littlebearapps/platform-sdk` | `@littlebearapps/platform-consumer-sdk` | Runtime library |
| `@littlebearapps/create-platform` | `@littlebearapps/platform-admin-sdk` | CLI scaffolder |

The old packages are deprecated on npm with migration messages pointing to the new names. They still resolve but show deprecation warnings on install.

## Consumer SDK Migration

### 1. Update the dependency

```bash
npm uninstall @littlebearapps/platform-sdk
npm install @littlebearapps/platform-consumer-sdk
```

### 2. Update imports

Find and replace across your source files:

```
@littlebearapps/platform-sdk → @littlebearapps/platform-consumer-sdk
```

All exports are identical — no API changes were made in the rename.

### Sub-path imports

If you use sub-path exports, update those too:

```
@littlebearapps/platform-sdk/middleware → @littlebearapps/platform-consumer-sdk/middleware
@littlebearapps/platform-sdk/patterns → @littlebearapps/platform-consumer-sdk/patterns
@littlebearapps/platform-sdk/dynamic-patterns → @littlebearapps/platform-consumer-sdk/dynamic-patterns
@littlebearapps/platform-sdk/heartbeat → @littlebearapps/platform-consumer-sdk/heartbeat
@littlebearapps/platform-sdk/retry → @littlebearapps/platform-consumer-sdk/retry
@littlebearapps/platform-sdk/costs → @littlebearapps/platform-consumer-sdk/costs
```

### 3. Verify

```bash
npx tsc --noEmit  # Type check
npm test          # Run tests
```

## Admin SDK Migration

### 1. Update the command

```bash
# Old
npx @littlebearapps/create-platform my-project

# New
npx @littlebearapps/platform-admin-sdk my-project
```

### 2. Upgrade and adopt

If you have an existing project scaffolded with the old CLI:

```bash
# Create a manifest for the existing project
npx @littlebearapps/platform-admin-sdk adopt . --tier minimal

# Then upgrade to get the latest changes
npx @littlebearapps/platform-admin-sdk upgrade
```

## GitHub Repository

The repository was also renamed:

```
github.com/littlebearapps/platform-sdk → github.com/littlebearapps/platform-sdks
```

GitHub auto-redirects the old URL, so existing links and CI references continue to work. However, it's good practice to update references:

```yaml
# Old
uses: littlebearapps/platform-sdk/.github/workflows/consumer-check.yml@main

# New
uses: littlebearapps/platform-sdks/.github/workflows/consumer-check.yml@main
```

## No Breaking Changes

The rename was purely organisational — the same code, same API surface, same behaviour. The version numbers continued from where the old packages left off.

If you encounter any issues during migration, check the [Troubleshooting Guide](../consumer-sdk/troubleshooting.md).
