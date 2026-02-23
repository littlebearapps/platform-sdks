#!/usr/bin/env node

/**
 * @littlebearapps/platform-admin-sdk
 *
 * Scaffolds and upgrades a Cloudflare Workers platform with SDK integration,
 * circuit breakers, and cost protection.
 *
 * Usage:
 *   npx @littlebearapps/platform-admin-sdk [project-name] [options]
 *   npx @littlebearapps/platform-admin-sdk upgrade [project-dir] [options]
 *   npx @littlebearapps/platform-admin-sdk adopt [project-dir] [options]
 *
 * Examples:
 *   npx @littlebearapps/platform-admin-sdk my-project
 *   npx @littlebearapps/platform-admin-sdk my-project --tier full --github-org myorg
 *   npx @littlebearapps/platform-admin-sdk upgrade ./my-project
 *   npx @littlebearapps/platform-admin-sdk upgrade ./my-project --tier standard --dry-run
 *   npx @littlebearapps/platform-admin-sdk adopt ./my-project --tier minimal --skip-prompts
 */

import { resolve } from 'node:path';
import { Command } from 'commander';
import pc from 'picocolors';
import { collectOptions, isValidTier } from './prompts.js';
import { scaffold } from './scaffold.js';
import { upgrade } from './upgrade.js';
import { adopt } from './adopt.js';
import { SDK_VERSION } from './templates.js';

const BANNER = `
  ${pc.bold(pc.cyan('Platform Admin SDK'))} — Cloudflare Cost Protection
  ${pc.dim('Scaffold backend infrastructure: circuit breakers, budget enforcement, error collection')}
`;

// --- Scaffold command (default) ---
const scaffoldCmd = new Command('scaffold')
  .description('Scaffold a new platform project (default)')
  .argument('[project-name]', 'Name of the project to create')
  .option('--tier <tier>', 'Infrastructure tier (minimal, standard, full)')
  .option('--github-org <org>', 'GitHub organisation for error issue creation')
  .option('--gatus-url <url>', 'Gatus status page URL for heartbeat monitoring')
  .option('--default-assignee <user>', 'Default GitHub assignee for error issues')
  .option('--skip-prompts', 'Non-interactive mode — fail if required flags are missing')
  .action(async (projectNameArg: string | undefined, cmdOpts: Record<string, string | boolean | undefined>) => {
    if (cmdOpts.tier && !isValidTier(cmdOpts.tier as string)) {
      console.error(pc.red(`  Error: Invalid tier "${cmdOpts.tier}". Must be one of: minimal, standard, full`));
      process.exit(1);
    }

    const options = await collectOptions({
      projectName: projectNameArg,
      tier: cmdOpts.tier as 'minimal' | 'standard' | 'full' | undefined,
      githubOrg: cmdOpts.githubOrg as string | undefined,
      gatusUrl: cmdOpts.gatusUrl as string | undefined,
      defaultAssignee: cmdOpts.defaultAssignee as string | undefined,
      skipPrompts: cmdOpts.skipPrompts as boolean | undefined,
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
  });

// --- Upgrade command ---
const upgradeCmd = new Command('upgrade')
  .description('Upgrade an existing scaffolded project to the latest SDK version')
  .argument('[project-dir]', 'Path to the project directory', '.')
  .option('--tier <tier>', 'Upgrade to a higher tier (minimal → standard → full)')
  .option('--dry-run', 'Show what would change without writing files')
  .action(async (projectDirArg: string, cmdOpts: Record<string, string | boolean | undefined>) => {
    if (cmdOpts.tier && !isValidTier(cmdOpts.tier as string)) {
      console.error(pc.red(`  Error: Invalid tier "${cmdOpts.tier}". Must be one of: minimal, standard, full`));
      process.exit(1);
    }

    const projectDir = resolve(process.cwd(), projectDirArg);

    console.log();
    console.log(`  ${pc.bold('Upgrading')}: ${projectDir}`);
    if (cmdOpts.tier) console.log(`  ${pc.bold('Target tier')}: ${cmdOpts.tier}`);
    if (cmdOpts.dryRun) console.log(`  ${pc.yellow('DRY RUN')} — no files will be written`);
    console.log();

    const result = await upgrade(projectDir, {
      tier: cmdOpts.tier as 'minimal' | 'standard' | 'full' | undefined,
      dryRun: cmdOpts.dryRun as boolean | undefined,
    });

    console.log();
    const total = result.created.length + result.updated.length + result.migrations.length;
    if (total === 0 && result.skipped.length === 0) {
      console.log(pc.green('  Already up to date.'));
    } else {
      console.log(`  ${pc.green(`${result.created.length} created`)}, ${pc.cyan(`${result.updated.length} updated`)}, ${pc.yellow(`${result.skipped.length} skipped`)}, ${pc.green(`${result.migrations.length} migrations`)}`);
    }
    if (result.removed.length > 0) {
      console.log(`  ${pc.yellow(`${result.removed.length} files removed from SDK (kept on disk)`)}`);
    }
    console.log();

    if (result.migrations.length > 0 && !cmdOpts.dryRun) {
      console.log(`  ${pc.bold('Run migrations:')}`);
      console.log(`  ${pc.cyan('npx wrangler d1 migrations apply')} YOUR_DB --remote`);
      console.log();
    }
  });

// --- Adopt command ---
const adoptCmd = new Command('adopt')
  .description('Add upgrade support to a project scaffolded before v1.1.0')
  .argument('[project-dir]', 'Path to the project directory', '.')
  .option('--tier <tier>', 'Infrastructure tier (minimal, standard, full)')
  .option('--project-name <name>', 'Project name (as used during scaffold)')
  .option('--project-slug <slug>', 'Project slug (for resource naming)')
  .option('--github-org <org>', 'GitHub organisation')
  .option('--gatus-url <url>', 'Gatus status page URL')
  .option('--default-assignee <user>', 'Default GitHub assignee')
  .option('--from-version <version>', 'SDK version that originally generated the scaffold')
  .option('--skip-prompts', 'Non-interactive mode — fail if required flags are missing')
  .action(async (projectDirArg: string, cmdOpts: Record<string, string | boolean | undefined>) => {
    if (cmdOpts.tier && !isValidTier(cmdOpts.tier as string)) {
      console.error(pc.red(`  Error: Invalid tier "${cmdOpts.tier}". Must be one of: minimal, standard, full`));
      process.exit(1);
    }

    const projectDir = resolve(process.cwd(), projectDirArg);

    // Collect options — reuse the prompt system for adopt
    const options = await collectOptions({
      projectName: cmdOpts.projectName as string | undefined,
      tier: cmdOpts.tier as 'minimal' | 'standard' | 'full' | undefined,
      githubOrg: cmdOpts.githubOrg as string | undefined,
      gatusUrl: cmdOpts.gatusUrl as string | undefined,
      defaultAssignee: cmdOpts.defaultAssignee as string | undefined,
      skipPrompts: cmdOpts.skipPrompts as boolean | undefined,
    });

    console.log();
    console.log(`  ${pc.bold('Adopting')}: ${projectDir}`);
    console.log(`  ${pc.bold('Tier')}: ${options.tier}`);
    console.log();

    adopt(projectDir, {
      projectName: options.projectName,
      projectSlug: options.projectSlug,
      githubOrg: options.githubOrg,
      tier: options.tier,
      gatusUrl: options.gatusUrl,
      defaultAssignee: options.defaultAssignee,
      fromVersion: cmdOpts.fromVersion as string | undefined,
    });

    console.log();
    console.log(pc.green(pc.bold('  Done!')));
    console.log(`  ${pc.dim('You can now run:')} ${pc.cyan('platform-admin-sdk upgrade')}`);
    console.log();
  });

// --- Main program ---
const program = new Command()
  .name('platform-admin-sdk')
  .description('Scaffold and upgrade Cloudflare Workers platform infrastructure')
  .version(SDK_VERSION)
  .addCommand(scaffoldCmd)
  .addCommand(upgradeCmd)
  .addCommand(adoptCmd);

async function main(): Promise<void> {
  console.log(BANNER);

  // Backward compat: if first arg isn't a known subcommand, treat it as `scaffold <arg>`
  const args = process.argv.slice(2);
  const subcommands = ['scaffold', 'upgrade', 'adopt', 'help', '--help', '-h', '--version', '-V'];
  if (args.length > 0 && !subcommands.includes(args[0])) {
    // Inject 'scaffold' as the subcommand
    process.argv.splice(2, 0, 'scaffold');
  } else if (args.length === 0) {
    // No args at all — default to scaffold (which will prompt interactively)
    process.argv.splice(2, 0, 'scaffold');
  }

  await program.parseAsync();
}

main().catch((error: unknown) => {
  console.error(pc.red('Error:'), error instanceof Error ? error.message : String(error));
  process.exit(1);
});
