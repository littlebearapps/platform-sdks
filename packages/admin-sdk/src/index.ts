#!/usr/bin/env node

/**
 * @littlebearapps/platform-admin-sdk
 *
 * Scaffolds a Cloudflare Workers platform with SDK integration,
 * circuit breakers, and cost protection.
 *
 * Usage:
 *   npx @littlebearapps/platform-admin-sdk [project-name] [options]
 *
 * Examples:
 *   npx @littlebearapps/platform-admin-sdk my-project
 *   npx @littlebearapps/platform-admin-sdk my-project --tier full --github-org myorg
 *   npx @littlebearapps/platform-admin-sdk my-project --tier minimal --skip-prompts
 */

import { resolve } from 'node:path';
import { Command } from 'commander';
import pc from 'picocolors';
import { collectOptions, isValidTier } from './prompts.js';
import { scaffold } from './scaffold.js';

const BANNER = `
  ${pc.bold(pc.cyan('Platform Admin SDK'))} — Cloudflare Cost Protection
  ${pc.dim('Scaffold backend infrastructure: circuit breakers, budget enforcement, error collection')}
`;

const program = new Command()
  .name('platform-admin-sdk')
  .description('Scaffold a Cloudflare Workers platform with SDK integration')
  .version('1.0.0')
  .argument('[project-name]', 'Name of the project to create')
  .option('--tier <tier>', 'Infrastructure tier (minimal, standard, full)')
  .option('--github-org <org>', 'GitHub organisation for error issue creation')
  .option('--gatus-url <url>', 'Gatus status page URL for heartbeat monitoring')
  .option('--default-assignee <user>', 'Default GitHub assignee for error issues')
  .option('--skip-prompts', 'Non-interactive mode — fail if required flags are missing');

async function main(): Promise<void> {
  console.log(BANNER);

  program.parse();
  const opts = program.opts<{
    tier?: string;
    githubOrg?: string;
    gatusUrl?: string;
    defaultAssignee?: string;
    skipPrompts?: boolean;
  }>();
  const [projectNameArg] = program.args;

  // Validate tier if provided
  if (opts.tier && !isValidTier(opts.tier)) {
    console.error(pc.red(`  Error: Invalid tier "${opts.tier}". Must be one of: minimal, standard, full`));
    process.exit(1);
  }

  const options = await collectOptions({
    projectName: projectNameArg,
    tier: opts.tier as 'minimal' | 'standard' | 'full' | undefined,
    githubOrg: opts.githubOrg,
    gatusUrl: opts.gatusUrl,
    defaultAssignee: opts.defaultAssignee,
    skipPrompts: opts.skipPrompts,
  });

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
  console.log(`  ${pc.cyan('npm install @littlebearapps/platform-consumer-sdk')}`);
  console.log();
}

main().catch((error: unknown) => {
  console.error(pc.red('Error:'), error instanceof Error ? error.message : String(error));
  process.exit(1);
});
