/**
 * Scaffold manifest — tracks what was generated so upgrades can detect changes.
 *
 * Written to `.platform-scaffold.json` in the project root.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Tier } from './prompts.js';

export const MANIFEST_FILENAME = '.platform-scaffold.json';
export const MANIFEST_VERSION = 1;

export interface ManifestContext {
  projectName: string;
  projectSlug: string;
  githubOrg: string;
  gatusUrl: string;
  defaultAssignee: string;
}

export interface ScaffoldManifest {
  /** Manifest format version (for future-proofing). */
  manifestVersion: number;
  /** Admin SDK version that generated this scaffold. */
  sdkVersion: string;
  /** ISO 8601 timestamp of scaffold or last upgrade. */
  generatedAt: string;
  /** Infrastructure tier. */
  tier: Tier;
  /** Persisted context variables for re-rendering templates. */
  context: ManifestContext;
  /** Map of relative output path to SHA-256 hash of the content as-generated. */
  files: Record<string, string>;
  /** Highest migration number owned by the scaffolder (user migrations are higher). */
  highestScaffoldMigration: number;
}

/** SHA-256 hash of file content. */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/** Read manifest from a project directory. Returns null if not found. */
export function readManifest(projectDir: string): ScaffoldManifest | null {
  const manifestPath = join(projectDir, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) return null;

  const raw = readFileSync(manifestPath, 'utf-8');
  const parsed = JSON.parse(raw) as ScaffoldManifest;

  if (parsed.manifestVersion !== MANIFEST_VERSION) {
    throw new Error(
      `Manifest version ${parsed.manifestVersion} is not supported ` +
      `(expected ${MANIFEST_VERSION}). Please upgrade the Admin SDK.`,
    );
  }

  return parsed;
}

/** Write manifest to a project directory. */
export function writeManifest(projectDir: string, manifest: ScaffoldManifest): void {
  const manifestPath = join(projectDir, MANIFEST_FILENAME);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

/** Build a new manifest from components. */
export function buildManifest(
  sdkVersion: string,
  tier: Tier,
  context: ManifestContext,
  fileHashes: Record<string, string>,
  highestScaffoldMigration: number,
): ScaffoldManifest {
  return {
    manifestVersion: MANIFEST_VERSION,
    sdkVersion,
    generatedAt: new Date().toISOString(),
    tier,
    context,
    files: fileHashes,
    highestScaffoldMigration,
  };
}
