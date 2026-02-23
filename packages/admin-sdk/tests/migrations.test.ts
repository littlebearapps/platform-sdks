import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findHighestMigration,
  getMigrationNumber,
  renumberMigration,
  planMigrations,
} from '../src/migrations.js';

describe('migrations', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'admin-sdk-migrations-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('findHighestMigration', () => {
    it('returns 0 for non-existent directory', () => {
      expect(findHighestMigration(join(tmpDir, 'nope'))).toBe(0);
    });

    it('returns 0 for empty directory', () => {
      const dir = join(tmpDir, 'migrations');
      mkdirSync(dir);
      expect(findHighestMigration(dir)).toBe(0);
    });

    it('returns highest numbered migration', () => {
      const dir = join(tmpDir, 'migrations');
      mkdirSync(dir);
      writeFileSync(join(dir, '001_core.sql'), '');
      writeFileSync(join(dir, '005_errors.sql'), '');
      writeFileSync(join(dir, '003_features.sql'), '');
      expect(findHighestMigration(dir)).toBe(5);
    });

    it('ignores non-migration files', () => {
      const dir = join(tmpDir, 'migrations');
      mkdirSync(dir);
      writeFileSync(join(dir, '003_features.sql'), '');
      writeFileSync(join(dir, 'seed.sql'), '');
      writeFileSync(join(dir, '.DS_Store'), '');
      writeFileSync(join(dir, 'README.md'), '');
      expect(findHighestMigration(dir)).toBe(3);
    });
  });

  describe('getMigrationNumber', () => {
    it('extracts number from migration path', () => {
      expect(getMigrationNumber('storage/d1/migrations/005_error.sql')).toBe(5);
    });

    it('returns null for seed.sql', () => {
      expect(getMigrationNumber('storage/d1/migrations/seed.sql')).toBeNull();
    });

    it('returns null for non-migration paths', () => {
      expect(getMigrationNumber('workers/platform-usage.ts')).toBeNull();
    });
  });

  describe('renumberMigration', () => {
    it('replaces NNN_ prefix', () => {
      expect(renumberMigration('005_error_collection.sql', 12)).toBe('012_error_collection.sql');
    });

    it('pads to 3 digits', () => {
      expect(renumberMigration('001_core.sql', 8)).toBe('008_core.sql');
    });
  });

  describe('planMigrations', () => {
    const baseMigrations = [
      { originalDest: 'storage/d1/migrations/005_error.sql', content: 'CREATE TABLE errors;' },
      { originalDest: 'storage/d1/migrations/006_patterns.sql', content: 'CREATE TABLE patterns;' },
      { originalDest: 'storage/d1/migrations/007_search.sql', content: 'CREATE TABLE search;' },
    ];

    it('returns empty when no new migrations', () => {
      const result = planMigrations(baseMigrations, 7, 7);
      expect(result).toHaveLength(0);
    });

    it('returns all migrations when none previously applied', () => {
      const result = planMigrations(baseMigrations, 4, 4);
      expect(result).toHaveLength(3);
    });

    it('renumbers after user highest migration', () => {
      const result = planMigrations(baseMigrations, 4, 10);
      expect(result).toHaveLength(3);
      expect(result[0].dest).toBe('storage/d1/migrations/011_error.sql');
      expect(result[1].dest).toBe('storage/d1/migrations/012_patterns.sql');
      expect(result[2].dest).toBe('storage/d1/migrations/013_search.sql');
    });

    it('preserves content unchanged', () => {
      const result = planMigrations(baseMigrations, 4, 10);
      expect(result[0].content).toBe('CREATE TABLE errors;');
    });

    it('preserves original dest for tracking', () => {
      const result = planMigrations(baseMigrations, 4, 10);
      expect(result[0].originalDest).toBe('storage/d1/migrations/005_error.sql');
    });

    it('sorts by original number before renumbering', () => {
      const unordered = [
        { originalDest: 'storage/d1/migrations/007_search.sql', content: 'search' },
        { originalDest: 'storage/d1/migrations/005_error.sql', content: 'error' },
      ];
      const result = planMigrations(unordered, 4, 4);
      expect(result[0].dest).toContain('005_error');
      expect(result[1].dest).toContain('006_search');
    });

    it('filters based on lastAppliedScaffoldMigration', () => {
      const result = planMigrations(baseMigrations, 5, 5);
      expect(result).toHaveLength(2);
      expect(result[0].originalDest).toContain('006_patterns');
      expect(result[1].originalDest).toContain('007_search');
    });
  });
});
