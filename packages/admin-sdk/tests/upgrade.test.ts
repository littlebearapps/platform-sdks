import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scaffold } from '../src/scaffold.js';
import { upgrade } from '../src/upgrade.js';
import { adopt } from '../src/adopt.js';
import { readManifest, hashContent, MANIFEST_FILENAME } from '../src/manifest.js';
import { SDK_VERSION } from '../src/templates.js';
import type { ScaffoldOptions } from '../src/prompts.js';

const BASE_OPTIONS: ScaffoldOptions = {
  projectName: 'test-project',
  projectSlug: 'test-project',
  githubOrg: 'testorg',
  tier: 'minimal',
  gatusUrl: 'https://status.example.com',
  defaultAssignee: 'nathan',
};

describe('upgrade', () => {
  let tmpDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'admin-sdk-upgrade-'));
    projectDir = join(tmpDir, 'test-project');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('errors when no manifest exists', async () => {
    mkdirSync(projectDir);
    await expect(upgrade(projectDir)).rejects.toThrow('No .platform-scaffold.json');
  });

  it('reports up-to-date when version and tier match', async () => {
    await scaffold(BASE_OPTIONS, projectDir);
    const result = await upgrade(projectDir);

    expect(result.created).toHaveLength(0);
    expect(result.updated).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.migrations).toHaveLength(0);
  });

  it('updates unmodified files when SDK version changes', async () => {
    await scaffold(BASE_OPTIONS, projectDir);

    // Simulate a version change by editing the manifest
    const manifest = readManifest(projectDir)!;
    manifest.sdkVersion = '0.9.0';
    writeFileSync(
      join(projectDir, MANIFEST_FILENAME),
      JSON.stringify(manifest, null, 2) + '\n',
    );

    const result = await upgrade(projectDir);
    // Files whose content hasn't changed won't appear in updated
    // but the manifest should be rewritten with new version
    const newManifest = readManifest(projectDir)!;
    expect(newManifest.sdkVersion).toBe(SDK_VERSION);
  });

  it('skips user-modified files', async () => {
    await scaffold(BASE_OPTIONS, projectDir);

    // Simulate version change
    const manifest = readManifest(projectDir)!;
    manifest.sdkVersion = '0.9.0';
    writeFileSync(
      join(projectDir, MANIFEST_FILENAME),
      JSON.stringify(manifest, null, 2) + '\n',
    );

    // Modify a scaffolded file
    const readmePath = join(projectDir, 'README.md');
    writeFileSync(readmePath, '# My Custom README\n\nI changed this.\n');

    const result = await upgrade(projectDir);
    expect(result.skipped).toContain('README.md');

    // File should NOT be overwritten
    const content = readFileSync(readmePath, 'utf-8');
    expect(content).toContain('My Custom README');
  });

  it('creates new files added in upgrade', async () => {
    await scaffold(BASE_OPTIONS, projectDir);

    // Remove a file that exists in the template manifest to simulate
    // it being "new" on next upgrade — by removing it from disk AND manifest
    const manifest = readManifest(projectDir)!;
    const tsconfig = join(projectDir, 'tsconfig.json');
    rmSync(tsconfig);
    delete manifest.files['tsconfig.json'];
    manifest.sdkVersion = '0.9.0';
    writeFileSync(
      join(projectDir, MANIFEST_FILENAME),
      JSON.stringify(manifest, null, 2) + '\n',
    );

    const result = await upgrade(projectDir);
    expect(result.created).toContain('tsconfig.json');
    expect(existsSync(tsconfig)).toBe(true);
  });

  it('dry-run does not write files', async () => {
    await scaffold(BASE_OPTIONS, projectDir);

    const manifest = readManifest(projectDir)!;
    const tsconfig = join(projectDir, 'tsconfig.json');
    rmSync(tsconfig);
    delete manifest.files['tsconfig.json'];
    manifest.sdkVersion = '0.9.0';
    writeFileSync(
      join(projectDir, MANIFEST_FILENAME),
      JSON.stringify(manifest, null, 2) + '\n',
    );

    const result = await upgrade(projectDir, { dryRun: true });
    expect(result.created).toContain('tsconfig.json');
    // File should NOT actually be created
    expect(existsSync(tsconfig)).toBe(false);
  });

  it('blocks tier downgrades', async () => {
    await scaffold({ ...BASE_OPTIONS, tier: 'standard' }, projectDir);

    await expect(upgrade(projectDir, { tier: 'minimal' })).rejects.toThrow(
      'Cannot downgrade',
    );
  });

  it('tier upgrade adds new files', async () => {
    await scaffold(BASE_OPTIONS, projectDir);

    // Simulate version bump so upgrade actually runs
    const manifest = readManifest(projectDir)!;
    manifest.sdkVersion = '0.9.0';
    writeFileSync(
      join(projectDir, MANIFEST_FILENAME),
      JSON.stringify(manifest, null, 2) + '\n',
    );

    const result = await upgrade(projectDir, { tier: 'standard' });

    // Should have created standard-tier files (error-collector, sentinel, etc.)
    const hasErrorCollector = result.created.some((f) => f.includes('error-collector'));
    expect(hasErrorCollector).toBe(true);

    // Manifest tier should be updated
    const newManifest = readManifest(projectDir)!;
    expect(newManifest.tier).toBe('standard');
  });

  it('renumbers new migrations after user migrations', async () => {
    await scaffold({ ...BASE_OPTIONS, tier: 'minimal' }, projectDir);

    // User adds their own migrations
    const migrationsDir = join(projectDir, 'storage/d1/migrations');
    writeFileSync(join(migrationsDir, '005_user_custom.sql'), 'CREATE TABLE custom;');
    writeFileSync(join(migrationsDir, '006_user_another.sql'), 'CREATE TABLE another;');

    // Simulate old SDK version so upgrade runs, and tier upgrade to standard
    // which adds migration 005_error_collection.sql
    const manifest = readManifest(projectDir)!;
    manifest.sdkVersion = '0.9.0';
    writeFileSync(
      join(projectDir, MANIFEST_FILENAME),
      JSON.stringify(manifest, null, 2) + '\n',
    );

    const result = await upgrade(projectDir, { tier: 'standard' });

    // The 005_error_collection.sql should be renumbered to 007
    const newMigration = result.migrations.find((m) => m.includes('error_collection'));
    expect(newMigration).toBeDefined();
    expect(newMigration).toContain('007_error_collection');
  });
});

describe('adopt', () => {
  let tmpDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'admin-sdk-adopt-'));
    projectDir = join(tmpDir, 'test-project');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('errors when directory does not exist', () => {
    expect(() => adopt(join(tmpDir, 'nope'), {
      projectName: 'test',
      projectSlug: 'test',
      githubOrg: '',
      tier: 'minimal',
      gatusUrl: '',
      defaultAssignee: '',
    })).toThrow('Directory does not exist');
  });

  it('errors when manifest already exists', async () => {
    await scaffold(BASE_OPTIONS, projectDir);

    expect(() => adopt(projectDir, {
      projectName: 'test-project',
      projectSlug: 'test-project',
      githubOrg: '',
      tier: 'minimal',
      gatusUrl: '',
      defaultAssignee: '',
    })).toThrow('already has a .platform-scaffold.json');
  });

  it('creates manifest for pre-manifest project', async () => {
    // Scaffold then remove the manifest to simulate a pre-manifest project
    await scaffold(BASE_OPTIONS, projectDir);
    rmSync(join(projectDir, MANIFEST_FILENAME));

    adopt(projectDir, {
      projectName: 'test-project',
      projectSlug: 'test-project',
      githubOrg: 'testorg',
      tier: 'minimal',
      gatusUrl: 'https://status.example.com',
      defaultAssignee: 'nathan',
    });

    const manifest = readManifest(projectDir);
    expect(manifest).not.toBeNull();
    expect(manifest!.tier).toBe('minimal');
    expect(manifest!.context.projectName).toBe('test-project');
    expect(manifest!.context.githubOrg).toBe('testorg');
    expect(Object.keys(manifest!.files).length).toBeGreaterThan(0);
  });

  it('hashes existing files correctly', async () => {
    await scaffold(BASE_OPTIONS, projectDir);
    rmSync(join(projectDir, MANIFEST_FILENAME));

    // Modify a file before adopting
    const readmePath = join(projectDir, 'README.md');
    const modifiedContent = '# Modified README\n';
    writeFileSync(readmePath, modifiedContent);

    adopt(projectDir, {
      projectName: 'test-project',
      projectSlug: 'test-project',
      githubOrg: '',
      tier: 'minimal',
      gatusUrl: '',
      defaultAssignee: '',
    });

    const manifest = readManifest(projectDir)!;
    // The hash should match the modified content
    expect(manifest.files['README.md']).toBe(hashContent(modifiedContent));
  });

  it('allows fromVersion override', async () => {
    await scaffold(BASE_OPTIONS, projectDir);
    rmSync(join(projectDir, MANIFEST_FILENAME));

    adopt(projectDir, {
      projectName: 'test-project',
      projectSlug: 'test-project',
      githubOrg: '',
      tier: 'minimal',
      gatusUrl: '',
      defaultAssignee: '',
      fromVersion: '1.0.0',
    });

    const manifest = readManifest(projectDir)!;
    expect(manifest.sdkVersion).toBe('1.0.0');
  });

  it('adopt sets highestScaffoldMigration from SDK templates, not disk', async () => {
    await scaffold(BASE_OPTIONS, projectDir);
    rmSync(join(projectDir, MANIFEST_FILENAME));

    // Add user migrations beyond the SDK's range
    const migrationsDir = join(projectDir, 'storage/d1/migrations');
    writeFileSync(join(migrationsDir, '010_user_custom.sql'), 'CREATE TABLE custom;');
    writeFileSync(join(migrationsDir, '011_user_another.sql'), 'CREATE TABLE another;');

    adopt(projectDir, {
      projectName: 'test-project',
      projectSlug: 'test-project',
      githubOrg: '',
      tier: 'minimal',
      gatusUrl: '',
      defaultAssignee: '',
    });

    const manifest = readManifest(projectDir)!;
    // Should be 4 (highest SDK migration for minimal tier), NOT 11 (highest on disk)
    expect(manifest.highestScaffoldMigration).toBe(4);
  });

  it('adopt then upgrade works end-to-end', async () => {
    // Scaffold minimal, remove manifest, adopt, then upgrade to standard
    await scaffold(BASE_OPTIONS, projectDir);
    rmSync(join(projectDir, MANIFEST_FILENAME));

    adopt(projectDir, {
      projectName: 'test-project',
      projectSlug: 'test-project',
      githubOrg: 'testorg',
      tier: 'minimal',
      gatusUrl: '',
      defaultAssignee: '',
      fromVersion: '1.0.0',
    });

    const result = await upgrade(projectDir, { tier: 'standard' });

    // Should have created standard-tier files
    const hasErrorCollector = result.created.some((f) => f.includes('error-collector'));
    expect(hasErrorCollector).toBe(true);

    const manifest = readManifest(projectDir)!;
    expect(manifest.tier).toBe('standard');
    expect(manifest.sdkVersion).toBe(SDK_VERSION);
  });
});
