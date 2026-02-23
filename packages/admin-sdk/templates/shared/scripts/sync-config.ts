#!/usr/bin/env npx tsx
/**
 * Sync Service Registry Configuration
 *
 * Reads services.yaml and budgets.yaml from platform/config/ and syncs to:
 * - D1: project_registry + feature_registry tables
 * - KV: CONFIG:FEATURE:{feature_key}:BUDGET keys
 *
 * Usage:
 *   npx tsx scripts/sync-config.ts [--dry-run] [--verbose]
 *
 * YAML files in git are the Source of Truth.
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parse as parseYAML } from 'yaml';

// =============================================================================
// CONFIGURATION — Update these after creating your Cloudflare resources
// =============================================================================

const CONFIG_DIR = join(process.cwd(), 'platform', 'config');
const SERVICES_FILE = join(CONFIG_DIR, 'services.yaml');
const BUDGETS_FILE = join(CONFIG_DIR, 'budgets.yaml');

// TODO: Replace with your actual KV namespace ID and D1 database name
const KV_NAMESPACE_ID = 'YOUR_KV_NAMESPACE_ID';
const D1_DATABASE_NAME = 'YOUR_D1_DATABASE_NAME';

// =============================================================================
// TYPES
// =============================================================================

interface FeatureDefinition {
  display_name: string;
  feature_id?: string;
  circuit_breaker: boolean;
  description?: string;
  cost_tier: string;
}

interface FeatureCategory {
  [feature: string]: FeatureDefinition;
}

interface Project {
  display_name: string;
  status: string;
  tier: string;
  repository?: string;
  features?: Record<string, FeatureCategory>;
}

interface Services {
  metadata: { version: string };
  projects: Record<string, Project>;
}

interface BudgetLimit {
  d1_writes?: number;
  d1_reads?: number;
  kv_reads?: number;
  kv_writes?: number;
  queue_messages?: number;
  requests?: number;
  cpu_ms?: number;
}

interface Budgets {
  defaults: {
    daily: BudgetLimit;
    circuit_breaker: {
      auto_reset_seconds: number;
      cooldown_seconds: number;
    };
    thresholds: { warning: number; critical: number };
  };
  feature_overrides: Record<string, BudgetLimit>;
}

// =============================================================================
// YAML 1.2 UNDERSCORE FIX
// =============================================================================

/**
 * YAML 1.2 parses numbers with underscores (e.g. 1_000_000) as strings.
 * This normalises them back to numbers.
 */
function normaliseBudgetLimits(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string' && /^\d[\d_]*$/.test(obj)) {
    return Number(obj.replace(/_/g, ''));
  }
  if (Array.isArray(obj)) return obj.map(normaliseBudgetLimits);
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = normaliseBudgetLimits(value);
    }
    return result;
  }
  return obj;
}

// =============================================================================
// HELPERS
// =============================================================================

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

function log(msg: string): void {
  console.log(`[sync-config] ${msg}`);
}

function verbose(msg: string): void {
  if (VERBOSE) console.log(`  ${msg}`);
}

function sanitise(value: string): string {
  return value.replace(/'/g, "''");
}

function runD1(sql: string): void {
  if (DRY_RUN) {
    verbose(`[dry-run] D1: ${sql.substring(0, 100)}...`);
    return;
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'sync-config-'));
  const sqlFile = join(tmpDir, 'query.sql');
  writeFileSync(sqlFile, sql);

  try {
    execSync(
      `wrangler d1 execute ${D1_DATABASE_NAME} --remote --file="${sqlFile}"`,
      { stdio: VERBOSE ? 'inherit' : 'pipe' }
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runKVPut(key: string, value: string): void {
  if (DRY_RUN) {
    verbose(`[dry-run] KV PUT: ${key} = ${value.substring(0, 60)}...`);
    return;
  }

  execSync(
    `wrangler kv key put --namespace-id="${KV_NAMESPACE_ID}" "${key}" '${sanitise(value)}'`,
    { stdio: VERBOSE ? 'inherit' : 'pipe' }
  );
}

// =============================================================================
// MAIN
// =============================================================================

function main(): void {
  log('Starting config sync...');

  if (!existsSync(SERVICES_FILE)) {
    console.error(`Missing: ${SERVICES_FILE}`);
    process.exit(1);
  }
  if (!existsSync(BUDGETS_FILE)) {
    console.error(`Missing: ${BUDGETS_FILE}`);
    process.exit(1);
  }

  const services = normaliseBudgetLimits(
    parseYAML(readFileSync(SERVICES_FILE, 'utf-8'))
  ) as Services;
  const budgets = normaliseBudgetLimits(
    parseYAML(readFileSync(BUDGETS_FILE, 'utf-8'))
  ) as Budgets;

  // Sync projects to D1 project_registry
  const projectSql: string[] = [];
  for (const [projectId, project] of Object.entries(services.projects)) {
    projectSql.push(
      `INSERT INTO project_registry (project_id, display_name, status, tier, repository)
       VALUES ('${sanitise(projectId)}', '${sanitise(project.display_name)}', '${sanitise(project.status)}', '${sanitise(String(project.tier))}', '${sanitise(project.repository ?? '')}')
       ON CONFLICT (project_id) DO UPDATE SET
         display_name = excluded.display_name,
         status = excluded.status,
         tier = excluded.tier,
         repository = excluded.repository;`
    );
  }

  if (projectSql.length > 0) {
    log(`Syncing ${projectSql.length} project(s) to D1...`);
    runD1(projectSql.join('\n'));
  }

  // Sync features to D1 feature_registry + KV budgets
  let featureCount = 0;
  const featureSql: string[] = [];

  for (const [projectId, project] of Object.entries(services.projects)) {
    if (!project.features) continue;

    for (const [category, features] of Object.entries(project.features)) {
      for (const [featureName, feature] of Object.entries(features)) {
        const featureKey = feature.feature_id ?? `${projectId}:${category}:${featureName}`;
        const cbEnabled = feature.circuit_breaker ? 1 : 0;

        featureSql.push(
          `INSERT INTO feature_registry (feature_key, project, category, feature, display_name, circuit_breaker_enabled, cost_tier)
           VALUES ('${sanitise(featureKey)}', '${sanitise(projectId)}', '${sanitise(category)}', '${sanitise(featureName)}', '${sanitise(feature.display_name)}', ${cbEnabled}, '${sanitise(feature.cost_tier)}')
           ON CONFLICT (feature_key) DO UPDATE SET
             display_name = excluded.display_name,
             circuit_breaker_enabled = excluded.circuit_breaker_enabled,
             cost_tier = excluded.cost_tier;`
        );

        // Sync budget to KV
        const override = budgets.feature_overrides?.[featureKey];
        const budget = override ?? budgets.defaults.daily;
        const kvKey = `CONFIG:FEATURE:${featureKey}:BUDGET`;
        runKVPut(kvKey, JSON.stringify(budget));

        featureCount++;
      }
    }
  }

  if (featureSql.length > 0) {
    log(`Syncing ${featureCount} feature(s) to D1...`);
    runD1(featureSql.join('\n'));
  }

  log(`Done! ${projectSql.length} projects, ${featureCount} features synced.`);
  if (DRY_RUN) log('(dry run — no changes made)');
}

main();
