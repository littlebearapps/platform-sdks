/**
 * Interactive CLI prompts for project scaffolding configuration.
 *
 * When flags are provided via CLI, those values are used without prompting.
 * Falls back to interactive prompts for missing values, or sensible defaults
 * when running non-interactively.
 */

import * as readline from 'node:readline';

export type Tier = 'minimal' | 'standard' | 'full';

export interface ScaffoldOptions {
  projectName: string;
  projectSlug: string;
  githubOrg: string;
  tier: Tier;
  gatusUrl: string;
  defaultAssignee: string;
}

/** Pre-filled values from CLI flags. */
export interface CLIFlags {
  projectName?: string;
  tier?: Tier;
  githubOrg?: string;
  gatusUrl?: string;
  defaultAssignee?: string;
  skipPrompts?: boolean;
}

const VALID_TIERS: Tier[] = ['minimal', 'standard', 'full'];

export function isValidTier(value: string): value is Tier {
  return VALID_TIERS.includes(value as Tier);
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function prompt(question: string, defaultValue: string): Promise<string> {
  // Non-interactive: use defaults
  if (!process.stdin.isTTY) {
    return defaultValue;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<string>((resolve) => {
    const display = defaultValue ? `${question} (${defaultValue}): ` : `${question}: `;
    rl.question(`  ${display}`, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}

async function promptSelect(question: string, options: string[], defaultIndex = 0): Promise<string> {
  if (!process.stdin.isTTY) {
    return options[defaultIndex];
  }

  console.log(`  ${question}`);
  options.forEach((opt, i) => {
    const marker = i === defaultIndex ? '>' : ' ';
    console.log(`    ${marker} ${i + 1}. ${opt}`);
  });

  const answer = await prompt('Choose', String(defaultIndex + 1));
  const idx = parseInt(answer, 10) - 1;
  return options[idx] ?? options[defaultIndex];
}

export async function collectOptions(flags: CLIFlags = {}): Promise<ScaffoldOptions> {
  if (flags.skipPrompts) {
    if (!flags.projectName) {
      throw new Error('--skip-prompts requires a project name argument');
    }
    if (!flags.tier) {
      throw new Error('--skip-prompts requires --tier');
    }
    return {
      projectName: flags.projectName,
      projectSlug: slugify(flags.projectName),
      githubOrg: flags.githubOrg ?? '',
      tier: flags.tier,
      gatusUrl: flags.gatusUrl ?? '',
      defaultAssignee: flags.defaultAssignee ?? '',
    };
  }

  const projectName = flags.projectName || await prompt('Project name', 'my-platform');
  const projectSlug = await prompt('Project slug (for resource names)', slugify(projectName));
  const tier = flags.tier || await promptSelect('Setup tier:', VALID_TIERS, 1) as Tier;
  const githubOrg = flags.githubOrg ?? await prompt('GitHub org (for error issue creation)', '');
  const gatusUrl = flags.gatusUrl ?? await prompt('Gatus status page URL (optional)', '');
  const defaultAssignee = flags.defaultAssignee ?? await prompt('Default GitHub assignee (optional)', '');

  return {
    projectName,
    projectSlug,
    githubOrg,
    tier,
    gatusUrl,
    defaultAssignee,
  };
}
