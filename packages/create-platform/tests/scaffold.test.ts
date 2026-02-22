import { describe, it, expect } from 'vitest';
import { getFilesForTier } from '../src/templates.js';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(__dirname, '../templates');

describe('getFilesForTier', () => {
  it('returns shared files for minimal tier', () => {
    const files = getFilesForTier('minimal');
    const dests = files.map((f) => f.dest);

    expect(dests).toContain('platform/config/services.yaml');
    expect(dests).toContain('platform/config/budgets.yaml');
    expect(dests).toContain('scripts/sync-config.ts');
    expect(dests).toContain('package.json');
    expect(dests).toContain('tsconfig.json');
    expect(dests).toContain('README.md');

    // Should have usage wrangler config
    expect(dests.some((d) => d.includes('usage.jsonc'))).toBe(true);

    // Should have platform-usage worker and libs
    expect(dests).toContain('workers/platform-usage.ts');
    expect(dests).toContain('workers/lib/billing.ts');
    expect(dests).toContain('workers/lib/usage/collectors/index.ts');

    // Should NOT have standard/full files
    expect(dests.some((d) => d.includes('error-collector'))).toBe(false);
    expect(dests.some((d) => d.includes('sentinel'))).toBe(false);
    expect(dests.some((d) => d.includes('pattern-discovery'))).toBe(false);
  });

  it('returns shared + standard files for standard tier', () => {
    const files = getFilesForTier('standard');
    const dests = files.map((f) => f.dest);

    // Shared files present
    expect(dests).toContain('platform/config/services.yaml');
    expect(dests).toContain('workers/platform-usage.ts');

    // Standard worker files present
    expect(dests).toContain('workers/error-collector.ts');
    expect(dests).toContain('workers/platform-sentinel.ts');
    expect(dests).toContain('workers/lib/error-collector/fingerprint.ts');
    expect(dests).toContain('workers/lib/error-collector/github.ts');
    expect(dests).toContain('workers/lib/sentinel/gap-detection.ts');
    expect(dests).toContain('workers/lib/shared/slack-alerts.ts');
    expect(dests.some((d) => d.includes('005_error_collection'))).toBe(true);

    // Full files NOT present
    expect(dests.some((d) => d.includes('pattern-discovery'))).toBe(false);
    expect(dests.some((d) => d.includes('alert-router'))).toBe(false);
  });

  it('returns all files for full tier', () => {
    const files = getFilesForTier('full');
    const dests = files.map((f) => f.dest);

    // Shared
    expect(dests).toContain('platform/config/services.yaml');
    expect(dests).toContain('workers/platform-usage.ts');
    // Standard
    expect(dests).toContain('workers/error-collector.ts');
    expect(dests).toContain('workers/platform-sentinel.ts');
    // Full workers
    expect(dests).toContain('workers/pattern-discovery.ts');
    expect(dests).toContain('workers/platform-alert-router.ts');
    expect(dests).toContain('workers/platform-notifications.ts');
    expect(dests).toContain('workers/platform-search.ts');
    expect(dests).toContain('workers/platform-settings.ts');
    // Full libs
    expect(dests).toContain('workers/lib/pattern-discovery/types.ts');
    expect(dests).toContain('workers/lib/pattern-discovery/clustering.ts');
    expect(dests).toContain('workers/lib/pattern-discovery/shadow-evaluation.ts');
    // Migrations
    expect(dests.some((d) => d.includes('006_pattern_discovery'))).toBe(true);
    expect(dests.some((d) => d.includes('007_notifications_search'))).toBe(true);
  });

  it('includes migrations for each tier', () => {
    const minimal = getFilesForTier('minimal');
    const standard = getFilesForTier('standard');
    const full = getFilesForTier('full');

    const minMigrations = minimal.filter((f) => f.dest.includes('migrations/')).length;
    const stdMigrations = standard.filter((f) => f.dest.includes('migrations/')).length;
    const fullMigrations = full.filter((f) => f.dest.includes('migrations/')).length;

    // Minimal: 4 core + seed = 5
    expect(minMigrations).toBe(5);
    // Standard: 4 core + seed + 1 error = 6
    expect(stdMigrations).toBe(6);
    // Full: 4 core + seed + 1 error + 2 full = 8
    expect(fullMigrations).toBe(8);
  });

  it('marks template files correctly', () => {
    const files = getFilesForTier('minimal');

    const hbsFiles = files.filter((f) => f.src.endsWith('.hbs'));
    expect(hbsFiles.every((f) => f.template)).toBe(true);

    const nonHbsFiles = files.filter((f) => !f.src.endsWith('.hbs'));
    expect(nonHbsFiles.every((f) => !f.template)).toBe(true);
  });

  it('includes correct worker file counts per tier', () => {
    const minimal = getFilesForTier('minimal');
    const standard = getFilesForTier('standard');
    const full = getFilesForTier('full');

    const minWorkers = minimal.filter((f) => f.dest.startsWith('workers/')).length;
    const stdWorkers = standard.filter((f) => f.dest.startsWith('workers/')).length;
    const fullWorkers = full.filter((f) => f.dest.startsWith('workers/')).length;

    // Minimal: 1 worker + 8 root libs + 3 shared libs + 4 usage/shared + 11 handlers + 6 queue + 5 scheduled + 2 collectors = 40
    expect(minWorkers).toBe(40);
    // Standard adds: 2 workers + 7 error-collector libs + 1 sentinel lib + 1 shared lib = 11
    expect(stdWorkers).toBe(51);
    // Full adds: 5 workers + 6 pattern-discovery libs = 11
    expect(fullWorkers).toBe(62);
  });

  it('all template source files exist on disk', () => {
    const files = getFilesForTier('full');
    const missing: string[] = [];

    for (const file of files) {
      const fullPath = resolve(TEMPLATES_DIR, file.src);
      if (!existsSync(fullPath)) {
        missing.push(file.src);
      }
    }

    expect(missing).toEqual([]);
  });
});
