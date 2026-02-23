import { describe, it, expect } from 'vitest';
import { collectOptions, isValidTier } from '../src/prompts.js';
import type { CLIFlags, Tier } from '../src/prompts.js';

describe('isValidTier', () => {
  it('accepts "minimal"', () => {
    expect(isValidTier('minimal')).toBe(true);
  });

  it('accepts "standard"', () => {
    expect(isValidTier('standard')).toBe(true);
  });

  it('accepts "full"', () => {
    expect(isValidTier('full')).toBe(true);
  });

  it('rejects invalid tier names', () => {
    expect(isValidTier('mega')).toBe(false);
    expect(isValidTier('')).toBe(false);
    expect(isValidTier('MINIMAL')).toBe(false);
  });
});

describe('collectOptions with --skip-prompts', () => {
  it('returns options when all required flags provided', async () => {
    const flags: CLIFlags = {
      projectName: 'my-project',
      tier: 'standard',
      skipPrompts: true,
    };

    const result = await collectOptions(flags);

    expect(result.projectName).toBe('my-project');
    expect(result.projectSlug).toBe('my-project');
    expect(result.tier).toBe('standard');
    expect(result.githubOrg).toBe('');
    expect(result.gatusUrl).toBe('');
    expect(result.defaultAssignee).toBe('');
  });

  it('uses provided optional flags', async () => {
    const flags: CLIFlags = {
      projectName: 'test-app',
      tier: 'full',
      githubOrg: 'myorg',
      gatusUrl: 'https://status.example.com',
      defaultAssignee: 'nathan',
      skipPrompts: true,
    };

    const result = await collectOptions(flags);

    expect(result.githubOrg).toBe('myorg');
    expect(result.gatusUrl).toBe('https://status.example.com');
    expect(result.defaultAssignee).toBe('nathan');
  });

  it('throws when project name missing with --skip-prompts', async () => {
    const flags: CLIFlags = {
      tier: 'minimal',
      skipPrompts: true,
    };

    await expect(collectOptions(flags)).rejects.toThrow('--skip-prompts requires a project name argument');
  });

  it('throws when tier missing with --skip-prompts', async () => {
    const flags: CLIFlags = {
      projectName: 'test-app',
      skipPrompts: true,
    };

    await expect(collectOptions(flags)).rejects.toThrow('--skip-prompts requires --tier');
  });

  it('generates slug from project name', async () => {
    const flags: CLIFlags = {
      projectName: 'My Cool Project',
      tier: 'minimal',
      skipPrompts: true,
    };

    const result = await collectOptions(flags);
    expect(result.projectSlug).toBe('my-cool-project');
  });

  it('handles special characters in project name for slug', async () => {
    const flags: CLIFlags = {
      projectName: '@org/my_app!v2',
      tier: 'standard',
      skipPrompts: true,
    };

    const result = await collectOptions(flags);
    expect(result.projectSlug).toBe('org-my-app-v2');
  });
});

describe('collectOptions without --skip-prompts (non-interactive)', () => {
  // When stdin is not a TTY (like in tests/CI), prompts return defaults

  it('uses provided projectName flag without prompting', async () => {
    const flags: CLIFlags = {
      projectName: 'flagged-project',
      tier: 'minimal',
    };

    const result = await collectOptions(flags);
    expect(result.projectName).toBe('flagged-project');
    expect(result.tier).toBe('minimal');
  });

  it('uses provided githubOrg flag without prompting', async () => {
    const flags: CLIFlags = {
      projectName: 'test',
      tier: 'standard',
      githubOrg: 'my-org',
    };

    const result = await collectOptions(flags);
    expect(result.githubOrg).toBe('my-org');
  });

  it('uses provided gatusUrl flag without prompting', async () => {
    const flags: CLIFlags = {
      projectName: 'test',
      tier: 'full',
      gatusUrl: 'https://status.example.com',
    };

    const result = await collectOptions(flags);
    expect(result.gatusUrl).toBe('https://status.example.com');
  });

  it('defaults to "my-platform" when no projectName', async () => {
    // Non-interactive mode (no TTY) uses defaults
    const result = await collectOptions({});
    expect(result.projectName).toBe('my-platform');
  });
});
