/**
 * Upgrade an existing scaffolded project to a newer SDK version.
 *
 * For each file:
 *   - New file (not on disk) → create it
 *   - Unchanged by user (disk hash == manifest hash) → overwrite with new version
 *   - Modified by user (disk hash != manifest hash) → skip with warning
 *   - Removed from SDK (in manifest, not in new template list) → warn, don't delete
 *
 * Migrations are renumbered to avoid conflicts with user-created migrations.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';
import pc from 'picocolors';
import type { Tier } from './prompts.js';
import { getFilesForTier, SDK_VERSION, isMigrationFile, isTierUpgradeOrSame } from './templates.js';
import {
  readManifest,
  writeManifest,
  buildManifest,
  hashContent,
  MANIFEST_FILENAME,
  type ScaffoldManifest,
  type ManifestContext,
} from './manifest.js';
import { findHighestMigration, getMigrationNumber, planMigrations } from './migrations.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getTemplatesDir(): string {
  const devPath = resolve(__dirname, '..', 'templates');
  if (existsSync(devPath)) return devPath;
  return resolve(__dirname, '..', '..', 'templates');
}

function renderString(template: string, context: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(context)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return result;
}

export interface UpgradeOptions {
  tier?: Tier;
  dryRun?: boolean;
}

export interface UpgradeResult {
  created: string[];
  updated: string[];
  skipped: string[];
  removed: string[];
  migrations: string[];
}

export async function upgrade(projectDir: string, options: UpgradeOptions = {}): Promise<UpgradeResult> {
  const manifest = readManifest(projectDir);
  if (!manifest) {
    throw new Error(
      `No ${MANIFEST_FILENAME} found in ${projectDir}.\n` +
      `If this project was scaffolded before v1.1.0, run:\n` +
      `  platform-admin-sdk adopt ${projectDir}`,
    );
  }

  const targetTier = options.tier ?? manifest.tier;

  if (!isTierUpgradeOrSame(manifest.tier, targetTier)) {
    throw new Error(
      `Cannot downgrade from "${manifest.tier}" to "${targetTier}". ` +
      `Tier changes must be upgrades (minimal → standard → full).`,
    );
  }

  if (manifest.sdkVersion === SDK_VERSION && manifest.tier === targetTier) {
    console.log(pc.green(`  Already up to date (SDK ${SDK_VERSION}, tier ${targetTier}).`));
    return { created: [], updated: [], skipped: [], removed: [], migrations: [] };
  }

  const templatesDir = getTemplatesDir();
  const files = getFilesForTier(targetTier);

  const context: Record<string, string> = {
    projectName: manifest.context.projectName,
    projectSlug: manifest.context.projectSlug,
    githubOrg: manifest.context.githubOrg,
    tier: targetTier,
    gatusUrl: manifest.context.gatusUrl,
    defaultAssignee: manifest.context.defaultAssignee,
    sdkVersion: SDK_VERSION,
  };

  const result: UpgradeResult = {
    created: [],
    updated: [],
    skipped: [],
    removed: [],
    migrations: [],
  };

  // Separate regular files from migrations
  const regularFiles = files.filter((f) => !isMigrationFile(f));
  const migrationFiles = files.filter((f) => isMigrationFile(f));

  const newFileHashes: Record<string, string> = {};

  // --- Process regular files ---
  for (const file of regularFiles) {
    const srcPath = join(templatesDir, file.src);
    const destRelative = renderString(file.dest, context);
    const destPath = join(projectDir, destRelative);

    if (!existsSync(srcPath)) continue;

    const raw = readFileSync(srcPath, 'utf-8');
    let content: string;
    if (file.template) {
      const compiled = Handlebars.compile(raw, { noEscape: true });
      content = compiled(context);
    } else {
      content = raw;
    }

    const newHash = hashContent(content);
    newFileHashes[destRelative] = newHash;

    if (!existsSync(destPath)) {
      // New file — create it
      if (!options.dryRun) {
        mkdirSync(dirname(destPath), { recursive: true });
        writeFileSync(destPath, content);
      }
      console.log(`  ${pc.green('create')} ${destRelative}`);
      result.created.push(destRelative);
    } else {
      const diskContent = readFileSync(destPath, 'utf-8');
      const diskHash = hashContent(diskContent);
      const manifestHash = manifest.files[destRelative];

      if (diskHash === manifestHash) {
        // Unmodified by user — safe to overwrite
        if (newHash !== diskHash) {
          if (!options.dryRun) {
            writeFileSync(destPath, content);
          }
          console.log(`  ${pc.cyan('update')} ${destRelative}`);
          result.updated.push(destRelative);
        }
        // else: identical content, nothing to do
      } else {
        // User has modified this file — skip
        console.log(`  ${pc.yellow('skip')}   ${destRelative} ${pc.dim('(user modified)')}`);
        result.skipped.push(destRelative);
        // Preserve the user's version in the new manifest
        newFileHashes[destRelative] = diskHash;
      }
    }
  }

  // --- Process migrations ---
  const scaffoldMigrations: Array<{ originalDest: string; content: string }> = [];

  for (const file of migrationFiles) {
    const srcPath = join(templatesDir, file.src);
    if (!existsSync(srcPath)) continue;

    const content = readFileSync(srcPath, 'utf-8');
    scaffoldMigrations.push({ originalDest: file.dest, content });
  }

  const migrationsDir = join(projectDir, 'storage/d1/migrations');
  const userHighest = findHighestMigration(migrationsDir);

  const planned = planMigrations(
    scaffoldMigrations,
    manifest.highestScaffoldMigration,
    userHighest,
  );

  for (const migration of planned) {
    const destPath = join(projectDir, migration.dest);
    if (!options.dryRun) {
      mkdirSync(dirname(destPath), { recursive: true });
      writeFileSync(destPath, migration.content);
    }
    console.log(`  ${pc.green('create')} ${migration.dest} ${pc.dim(`(from ${migration.originalDest.split('/').pop()})`)}`);
    result.migrations.push(migration.dest);
    newFileHashes[migration.dest] = hashContent(migration.content);
  }

  // Carry forward hashes for existing migrations that weren't re-planned
  for (const [path, hash] of Object.entries(manifest.files)) {
    if (path.includes('migrations/') && !newFileHashes[path]) {
      newFileHashes[path] = hash;
    }
  }

  // --- Check for removed files ---
  const newDestSet = new Set([
    ...regularFiles.map((f) => renderString(f.dest, context)),
    ...migrationFiles.map((f) => f.dest),
  ]);

  for (const oldPath of Object.keys(manifest.files)) {
    // Skip migrations from the removed check (they get renumbered)
    if (oldPath.includes('migrations/')) continue;

    if (!newDestSet.has(oldPath)) {
      console.log(`  ${pc.yellow('warn')}   ${oldPath} ${pc.dim('(removed from SDK, keeping on disk)')}`);
      result.removed.push(oldPath);
    }
  }

  // --- Compute new highestScaffoldMigration ---
  let highestScaffoldMig = manifest.highestScaffoldMigration;
  for (const file of migrationFiles) {
    const num = getMigrationNumber(file.dest);
    if (num !== null && num > highestScaffoldMig) {
      highestScaffoldMig = num;
    }
  }

  // --- Write updated manifest ---
  if (!options.dryRun) {
    const newManifest = buildManifest(
      SDK_VERSION,
      targetTier,
      manifest.context,
      newFileHashes,
      highestScaffoldMig,
    );
    writeManifest(projectDir, newManifest);
  }

  return result;
}
