import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  hashContent,
  buildManifest,
  readManifest,
  writeManifest,
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
} from '../src/manifest.js';

describe('manifest', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'admin-sdk-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('hashContent', () => {
    it('returns consistent SHA-256 for same input', () => {
      const hash1 = hashContent('hello world');
      const hash2 = hashContent('hello world');
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex
    });

    it('returns different hashes for different input', () => {
      expect(hashContent('a')).not.toBe(hashContent('b'));
    });
  });

  describe('buildManifest', () => {
    it('includes all required fields', () => {
      const manifest = buildManifest('1.1.0', 'standard', {
        projectName: 'My Project',
        projectSlug: 'my-project',
        githubOrg: 'myorg',
        gatusUrl: '',
        defaultAssignee: '',
      }, { 'workers/platform-usage.ts': 'abc123' }, 5);

      expect(manifest.manifestVersion).toBe(MANIFEST_VERSION);
      expect(manifest.sdkVersion).toBe('1.1.0');
      expect(manifest.tier).toBe('standard');
      expect(manifest.context.projectSlug).toBe('my-project');
      expect(manifest.files['workers/platform-usage.ts']).toBe('abc123');
      expect(manifest.highestScaffoldMigration).toBe(5);
      expect(manifest.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('readManifest', () => {
    it('returns null when file does not exist', () => {
      expect(readManifest(tmpDir)).toBeNull();
    });

    it('throws on unsupported manifest version', () => {
      const manifest = { manifestVersion: 999, sdkVersion: '1.0.0' };
      writeFileSync(join(tmpDir, MANIFEST_FILENAME), JSON.stringify(manifest));
      expect(() => readManifest(tmpDir)).toThrow('not supported');
    });
  });

  describe('writeManifest + readManifest roundtrip', () => {
    it('preserves all fields', () => {
      const original = buildManifest('1.1.0', 'full', {
        projectName: 'Test',
        projectSlug: 'test',
        githubOrg: 'org',
        gatusUrl: 'https://status.example.com',
        defaultAssignee: 'alice',
      }, {
        'workers/platform-usage.ts': hashContent('file content'),
        'platform/config/services.yaml': hashContent('yaml content'),
      }, 7);

      writeManifest(tmpDir, original);
      const loaded = readManifest(tmpDir);

      expect(loaded).not.toBeNull();
      expect(loaded!.sdkVersion).toBe('1.1.0');
      expect(loaded!.tier).toBe('full');
      expect(loaded!.context.projectSlug).toBe('test');
      expect(loaded!.context.gatusUrl).toBe('https://status.example.com');
      expect(Object.keys(loaded!.files)).toHaveLength(2);
      expect(loaded!.highestScaffoldMigration).toBe(7);
    });

    it('writes valid JSON with trailing newline', () => {
      const manifest = buildManifest('1.0.0', 'minimal', {
        projectName: 'Test', projectSlug: 'test',
        githubOrg: '', gatusUrl: '', defaultAssignee: '',
      }, {}, 4);

      writeManifest(tmpDir, manifest);
      const raw = readFileSync(join(tmpDir, MANIFEST_FILENAME), 'utf-8');
      expect(raw.endsWith('\n')).toBe(true);
      expect(() => JSON.parse(raw)).not.toThrow();
    });
  });
});
