/**
 * Migration numbering utilities for safe upgrades.
 *
 * Handles renumbering scaffold-owned migrations so they don't conflict
 * with user-created migrations.
 */

import { readdirSync } from 'node:fs';

/** Parse the highest NNN_ migration number from a directory. Returns 0 if empty. */
export function findHighestMigration(migrationsDir: string): number {
  let files: string[];
  try {
    files = readdirSync(migrationsDir);
  } catch {
    return 0;
  }

  let highest = 0;
  for (const file of files) {
    const match = file.match(/^(\d{3})_/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > highest) highest = num;
    }
  }
  return highest;
}

/** Extract the NNN migration number from a path like `storage/d1/migrations/005_error.sql`. */
export function getMigrationNumber(destPath: string): number | null {
  const match = destPath.match(/(\d{3})_[^/]+\.sql$/);
  return match ? parseInt(match[1], 10) : null;
}

/** Renumber a migration filename: `005_error.sql` with nextNumber=12 → `012_error.sql`. */
export function renumberMigration(filename: string, nextNumber: number): string {
  return filename.replace(/^\d{3}_/, `${String(nextNumber).padStart(3, '0')}_`);
}

export interface PlannedMigration {
  /** New destination path (renumbered). */
  dest: string;
  /** File content (unchanged). */
  content: string;
  /** Original scaffold destination path (before renumbering). */
  originalDest: string;
}

/**
 * Plan which migrations are new and what numbers they should get.
 *
 * Filters to migrations with numbers > lastAppliedScaffoldMigration,
 * then renumbers sequentially starting after the user's highest migration.
 */
export function planMigrations(
  scaffoldMigrations: Array<{ originalDest: string; content: string }>,
  lastAppliedScaffoldMigration: number,
  userHighestMigration: number,
): PlannedMigration[] {
  // Filter to only new scaffold migrations
  const newMigrations = scaffoldMigrations.filter((m) => {
    const num = getMigrationNumber(m.originalDest);
    return num !== null && num > lastAppliedScaffoldMigration;
  });

  // Sort by original number
  newMigrations.sort((a, b) => {
    const aNum = getMigrationNumber(a.originalDest) ?? 0;
    const bNum = getMigrationNumber(b.originalDest) ?? 0;
    return aNum - bNum;
  });

  // Renumber sequentially after user's highest
  let nextNum = userHighestMigration + 1;
  return newMigrations.map((m) => {
    const originalFilename = m.originalDest.split('/').pop()!;
    const newFilename = renumberMigration(originalFilename, nextNum++);
    const dir = m.originalDest.substring(0, m.originalDest.lastIndexOf('/'));
    return {
      dest: `${dir}/${newFilename}`,
      content: m.content,
      originalDest: m.originalDest,
    };
  });
}
