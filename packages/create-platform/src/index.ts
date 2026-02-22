#!/usr/bin/env node

/**
 * @littlebearapps/create-platform
 *
 * Scaffolds a Cloudflare Workers platform with SDK integration,
 * circuit breakers, and cost protection.
 *
 * Usage:
 *   npx @littlebearapps/create-platform [project-name]
 */

import { resolve } from 'node:path';
import pc from 'picocolors';
import { collectOptions } from './prompts.js';
import { scaffold } from './scaffold.js';

const BANNER = `
  ${pc.bold(pc.cyan('Platform Admin SDK'))} — Cloudflare Cost Protection
  ${pc.dim('Scaffold backend infrastructure: circuit breakers, budget enforcement, error collection')}
`;

async function main(): Promise<void> {
  console.log(BANNER);

  const projectName = process.argv[2];
  const options = await collectOptions(projectName);

  const outputDir = resolve(process.cwd(), options.projectName);

  console.log();
  console.log(`  ${pc.bold('Project')}: ${options.projectName}`);
  console.log(`  ${pc.bold('Tier')}: ${options.tier}`);
  console.log(`  ${pc.bold('Output')}: ${outputDir}`);
  console.log();

  await scaffold(options, outputDir);

  console.log();
  console.log(pc.green(pc.bold('  Done!')));
  console.log();
  console.log(`  ${pc.bold('Next steps:')}`);
  console.log();
  console.log(`  ${pc.cyan('cd')} ${options.projectName}`);
  console.log(`  ${pc.cyan('npm install')}`);
  console.log();
  console.log(`  ${pc.dim('# Create Cloudflare resources:')}`);
  console.log(`  ${pc.cyan('npx wrangler d1 create')} ${options.projectSlug}-metrics`);
  console.log(`  ${pc.cyan('npx wrangler kv namespace create')} PLATFORM_CACHE`);
  if (options.tier !== 'minimal') {
    console.log(`  ${pc.cyan('npx wrangler kv namespace create')} PLATFORM_ALERTS`);
  }
  console.log(`  ${pc.cyan('npx wrangler queues create')} ${options.projectSlug}-telemetry`);
  console.log(`  ${pc.cyan('npx wrangler queues create')} ${options.projectSlug}-telemetry-dlq`);
  console.log();
  console.log(`  ${pc.dim('# Update resource IDs in wrangler.*.jsonc, then:')}`);
  console.log(`  ${pc.cyan('npm run sync:config')}`);
  console.log(`  ${pc.cyan('npx wrangler d1 migrations apply')} ${options.projectSlug}-metrics --remote`);
  console.log(`  ${pc.cyan('npx wrangler deploy')} -c wrangler.${options.projectSlug}-usage.jsonc`);
  console.log();
  console.log(`  ${pc.dim('# In your consumer projects:')}`);
  console.log(`  ${pc.cyan('npm install @littlebearapps/platform-sdk')}`);
  console.log();
}

main().catch((error: unknown) => {
  console.error(pc.red('Error:'), error instanceof Error ? error.message : String(error));
  process.exit(1);
});
