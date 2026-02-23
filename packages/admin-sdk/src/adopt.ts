/**
 * Adopt an existing scaffold that was created before the manifest system.
 *
 * Hashes all files on disk as a baseline and writes `.platform-scaffold.json`
 * so the project can be upgraded in future.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import pc from 'picocolors';
import type { Tier } from './prompts.js';
import { getFilesForTier, SDK_VERSION } from './templates.js';
import { hashContent, writeManifest, buildManifest, readManifest, MANIFEST_FILENAME } from './manifest.js';
import { findHighestMigration } from './migrations.js';

export interface AdoptOptions {
  projectName: string;
  projectSlug: string;
  githubOrg: string;
  tier: Tier;
  gatusUrl: string;
  defaultAssignee: string;
  /** SDK version that originally generated the scaffold (defaults to current). */
  fromVersion?: string;
}

export function adopt(projectDir: string, options: AdoptOptions): void {
  if (!existsSync(projectDir)) {
    throw new Error(`Directory does not exist: ${projectDir}`);
  }

  if (readManifest(projectDir) !== null) {
    throw new Error(
      `${projectDir} already has a ${MANIFEST_FILENAME}. ` +
      `Use \`platform-admin-sdk upgrade\` instead.`,
    );
  }

  const files = getFilesForTier(options.tier);

  // Build context for path rendering
  const context: Record<string, string> = {
    projectName: options.projectName,
    projectSlug: options.projectSlug,
  };

  // Hash all files that exist on disk
  const fileHashes: Record<string, string> = {};
  let matched = 0;

  for (const file of files) {
    let destRelative = file.dest;
    for (const [key, value] of Object.entries(context)) {
      destRelative = destRelative.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
    }

    const destPath = join(projectDir, destRelative);
    if (existsSync(destPath)) {
      const content = readFileSync(destPath, 'utf-8');
      fileHashes[destRelative] = hashContent(content);
      matched++;
    }
  }

  const migrationsDir = join(projectDir, 'storage/d1/migrations');
  const highestMigration = findHighestMigration(migrationsDir);

  const sdkVersion = options.fromVersion ?? SDK_VERSION;

  const manifest = buildManifest(
    sdkVersion,
    options.tier,
    {
      projectName: options.projectName,
      projectSlug: options.projectSlug,
      githubOrg: options.githubOrg,
      gatusUrl: options.gatusUrl,
      defaultAssignee: options.defaultAssignee,
    },
    fileHashes,
    highestMigration,
  );

  writeManifest(projectDir, manifest);

  console.log(`  ${pc.green('create')} ${MANIFEST_FILENAME}`);
  console.log(`  ${pc.dim(`Matched ${matched} of ${files.length} expected files.`)}`);
  console.log(`  ${pc.dim(`Highest migration: ${highestMigration || 'none'}`)}`);
  console.log(`  ${pc.dim(`Tier: ${options.tier}, SDK: ${sdkVersion}`)}`);
}
