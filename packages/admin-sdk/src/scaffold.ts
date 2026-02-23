/**
 * Scaffolding orchestrator — copies and renders templates into the output directory.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';
import pc from 'picocolors';
import type { ScaffoldOptions } from './prompts.js';
import { getFilesForTier } from './templates.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getTemplatesDir(): string {
  // In development: ../templates/
  // In published package: ../templates/ (relative to dist/)
  const devPath = resolve(__dirname, '..', 'templates');
  if (existsSync(devPath)) return devPath;
  return resolve(__dirname, '..', '..', 'templates');
}

function renderString(template: string, context: Record<string, string>): string {
  // Simple {{var}} replacement for file paths (not Handlebars — just string replace)
  let result = template;
  for (const [key, value] of Object.entries(context)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return result;
}

export async function scaffold(options: ScaffoldOptions, outputDir: string): Promise<void> {
  if (existsSync(outputDir)) {
    throw new Error(`Directory already exists: ${outputDir}`);
  }

  const templatesDir = getTemplatesDir();
  const files = getFilesForTier(options.tier);

  const context: Record<string, string> = {
    projectName: options.projectName,
    projectSlug: options.projectSlug,
    githubOrg: options.githubOrg,
    tier: options.tier,
    gatusUrl: options.gatusUrl,
    defaultAssignee: options.defaultAssignee,
    sdkVersion: '0.2.0',
  };

  mkdirSync(outputDir, { recursive: true });

  for (const file of files) {
    const srcPath = join(templatesDir, file.src);
    const destPath = join(outputDir, renderString(file.dest, context));

    // Ensure destination directory exists
    mkdirSync(dirname(destPath), { recursive: true });

    if (!existsSync(srcPath)) {
      console.log(`  ${pc.yellow('skip')} ${file.src} ${pc.dim('(template not found)')}`);
      continue;
    }

    const raw = readFileSync(srcPath, 'utf-8');

    if (file.template) {
      const compiled = Handlebars.compile(raw, { noEscape: true });
      const rendered = compiled(context);
      writeFileSync(destPath, rendered);
    } else {
      writeFileSync(destPath, raw);
    }

    const relDest = destPath.replace(outputDir + '/', '');
    console.log(`  ${pc.green('create')} ${relDest}`);
  }
}
