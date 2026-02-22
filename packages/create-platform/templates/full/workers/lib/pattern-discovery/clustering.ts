/**
 * Error Clustering for Pattern Discovery
 *
 * Groups similar unclassified errors to reduce AI API costs
 * and improve suggestion quality.
 *
 * @module workers/lib/pattern-discovery/clustering
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { UnclassifiedError, ErrorCluster } from './types';
import type { Logger } from '@littlebearapps/platform-sdk';

/** Minimum occurrences to consider for clustering */
const MIN_OCCURRENCE_COUNT = 3;

/** Maximum clusters to process per run */
const MAX_CLUSTERS_PER_RUN = 20;

/** Maximum samples per cluster to send to AI */
export const MAX_SAMPLES_PER_CLUSTER = 5;

/**
 * Query unclassified errors from D1
 * Returns errors without a category that have occurred multiple times
 *
 * Uses COALESCE to check both last_exception_message and normalized_message,
 * allowing pattern discovery to work for:
 * - Exceptions (have last_exception_message)
 * - Soft errors (have normalized_message from console.error logs)
 * - Workflow failures (have normalized_message from logs)
 */
export async function queryUnclassifiedErrors(
  db: D1Database,
  log: Logger
): Promise<UnclassifiedError[]> {
  try {
    // Query high-frequency errors that haven't been resolved
    // Uses COALESCE to get message from either exception or normalized logs
    // Errors with transient categories (tracked in fingerprint) are already handled
    const result = await db
      .prepare(
        `
      SELECT
        fingerprint,
        script_name as scriptName,
        COALESCE(last_exception_message, normalized_message, '') as normalizedMessage,
        occurrence_count as occurrenceCount,
        last_seen_at as lastSeenAt
      FROM error_occurrences
      WHERE status = 'open'
        AND occurrence_count >= ?
        AND error_category IS NULL
        AND (
          (last_exception_message IS NOT NULL AND last_exception_message != '')
          OR (normalized_message IS NOT NULL AND normalized_message != '')
        )
      ORDER BY occurrence_count DESC
      LIMIT 500
    `
      )
      .bind(MIN_OCCURRENCE_COUNT)
      .all<UnclassifiedError>();

    log.info('Queried unclassified errors', {
      count: result.results.length,
      minOccurrences: MIN_OCCURRENCE_COUNT,
    });

    return result.results;
  } catch (error) {
    log.error('Failed to query unclassified errors', error);
    return [];
  }
}

/**
 * Simple hash function for clustering
 * Normalizes message and creates a stable hash for grouping
 */
function hashMessage(message: string): string {
  // Further normalize: lowercase, collapse whitespace, remove numbers
  const normalized = message
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\d+/g, 'N')
    .replace(/[a-f0-9]{8,}/gi, 'HASH') // Remove hex strings
    .trim();

  // Simple string hash
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(16);
}

/**
 * Cluster errors by normalized message similarity
 * Uses exact match on further-normalized messages as first pass
 */
export function clusterErrors(errors: UnclassifiedError[]): Map<string, UnclassifiedError[]> {
  const clusters = new Map<string, UnclassifiedError[]>();

  for (const error of errors) {
    const hash = hashMessage(error.normalizedMessage);
    const existing = clusters.get(hash) || [];
    existing.push(error);
    clusters.set(hash, existing);
  }

  return clusters;
}

/**
 * Convert clustered errors to ErrorCluster objects
 * Filters to clusters with sufficient volume
 */
export function buildClusterObjects(
  clusteredErrors: Map<string, UnclassifiedError[]>
): ErrorCluster[] {
  const clusters: ErrorCluster[] = [];

  for (const [hash, errors] of clusteredErrors) {
    // Sum occurrences across all errors in cluster
    const totalOccurrences = errors.reduce((sum, e) => sum + e.occurrenceCount, 0);

    // Skip small clusters
    if (totalOccurrences < MIN_OCCURRENCE_COUNT * 2) {
      continue;
    }

    // Find representative message (most common or first)
    const representative = errors.reduce((best, e) =>
      e.occurrenceCount > best.occurrenceCount ? e : best
    );

    // Collect unique scripts
    const scripts = [...new Set(errors.map((e) => e.scriptName))];

    // Find time range
    const firstSeen = Math.min(...errors.map((e) => e.lastSeenAt));
    const lastSeen = Math.max(...errors.map((e) => e.lastSeenAt));

    clusters.push({
      id: `cluster-${hash}-${Date.now()}`,
      clusterHash: hash,
      representativeMessage: representative.normalizedMessage,
      occurrenceCount: totalOccurrences,
      uniqueFingerprints: errors.length,
      firstSeenAt: firstSeen,
      lastSeenAt: lastSeen,
      scripts,
      status: 'pending',
      suggestionId: null,
    });
  }

  // Sort by occurrence count descending
  clusters.sort((a, b) => b.occurrenceCount - a.occurrenceCount);

  // Limit to max clusters per run
  return clusters.slice(0, MAX_CLUSTERS_PER_RUN);
}

/**
 * Get sample messages for a cluster
 * Returns diverse samples for AI analysis
 */
export function getSampleMessages(
  errors: UnclassifiedError[],
  maxSamples: number = MAX_SAMPLES_PER_CLUSTER
): string[] {
  // Get unique messages (some may be duplicates with different fingerprints)
  const uniqueMessages = [...new Set(errors.map((e) => e.normalizedMessage))];

  // Return up to maxSamples
  return uniqueMessages.slice(0, maxSamples);
}

/**
 * Store clusters in D1 for tracking
 */
export async function storeClusters(
  db: D1Database,
  clusters: ErrorCluster[],
  log: Logger
): Promise<void> {
  for (const cluster of clusters) {
    try {
      await db
        .prepare(
          `
        INSERT INTO error_clusters (
          id, cluster_hash, representative_message,
          occurrence_count, unique_fingerprints,
          first_seen_at, last_seen_at, scripts, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (cluster_hash) DO UPDATE SET
          occurrence_count = excluded.occurrence_count,
          unique_fingerprints = excluded.unique_fingerprints,
          last_seen_at = excluded.last_seen_at,
          scripts = excluded.scripts,
          updated_at = unixepoch()
      `
        )
        .bind(
          cluster.id,
          cluster.clusterHash,
          cluster.representativeMessage.slice(0, 500),
          cluster.occurrenceCount,
          cluster.uniqueFingerprints,
          cluster.firstSeenAt,
          cluster.lastSeenAt,
          JSON.stringify(cluster.scripts),
          cluster.status
        )
        .run();
    } catch (error) {
      log.warn('Failed to store cluster', error, { clusterId: cluster.id });
    }
  }

  log.info('Stored clusters', { count: clusters.length });
}

/**
 * Get pending clusters for AI analysis
 */
export async function getPendingClusters(
  db: D1Database,
  limit: number = 10
): Promise<ErrorCluster[]> {
  const result = await db
    .prepare(
      `
    SELECT
      id, cluster_hash as clusterHash, representative_message as representativeMessage,
      occurrence_count as occurrenceCount, unique_fingerprints as uniqueFingerprints,
      first_seen_at as firstSeenAt, last_seen_at as lastSeenAt,
      scripts, status, suggestion_id as suggestionId
    FROM error_clusters
    WHERE status = 'pending'
    ORDER BY occurrence_count DESC
    LIMIT ?
  `
    )
    .bind(limit)
    .all<ErrorCluster & { scripts: string }>();

  return result.results.map((r) => ({
    ...r,
    scripts: JSON.parse(r.scripts || '[]'),
  }));
}

/**
 * Update cluster status
 */
export async function updateClusterStatus(
  db: D1Database,
  clusterId: string,
  status: ErrorCluster['status'],
  suggestionId?: string
): Promise<void> {
  await db
    .prepare(
      `
    UPDATE error_clusters
    SET status = ?, suggestion_id = ?, updated_at = unixepoch()
    WHERE id = ?
  `
    )
    .bind(status, suggestionId || null, clusterId)
    .run();
}
