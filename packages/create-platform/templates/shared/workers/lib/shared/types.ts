/**
 * Shared Types
 *
 * Type definitions for project registry and resource mapping.
 * These types are used by the platform-usage worker for project identification
 * and resource attribution.
 */

/**
 * Project record from the D1 project_registry table.
 */
export interface Project {
  projectId: string;
  displayName: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  owner: string | null;
  repoPath: string | null;
  status: 'active' | 'archived' | 'development';
  /** Primary resource type for utilization tracking (e.g., 'd1', 'workers', 'vectorize') */
  primaryResource: ResourceType | null;
  /** Custom limit for the primary resource (overrides global CF_ALLOWANCES) */
  customLimit: number | null;
  /** Full GitHub repository URL */
  repoUrl: string | null;
  /** GitHub repository identifier (e.g., 'org/repo') */
  githubRepoId: string | null;
}

/**
 * Resource mapping record from D1.
 */
export interface ResourceMapping {
  resourceType: ResourceType;
  resourceId: string;
  resourceName: string;
  projectId: string;
  environment: 'production' | 'staging' | 'preview' | 'development';
  notes: string | null;
}

/**
 * Cloudflare resource types for project mapping.
 */
export type ResourceType =
  | 'worker'
  | 'd1'
  | 'kv'
  | 'r2'
  | 'vectorize'
  | 'queue'
  | 'workflow'
  | 'ai_gateway'
  | 'workers_ai'
  | 'durable_object'
  | 'pages'
  | 'analytics_engine';
