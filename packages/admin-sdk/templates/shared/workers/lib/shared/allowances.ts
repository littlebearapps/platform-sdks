/**
 * Cloudflare Allowance & Licensing Configuration
 *
 * Defines monthly limits for Cloudflare services to track "Usage vs. Included Thresholds".
 * These values represent the Workers Paid plan allowances and free tier limits.
 *
 * @see https://developers.cloudflare.com/workers/platform/pricing/
 */

/**
 * Service type identifiers
 */
export type ServiceType =
  | 'workers'
  | 'd1'
  | 'kv'
  | 'r2'
  | 'durableObjects'
  | 'vectorize'
  | 'aiGateway'
  | 'workersAI'
  | 'pages'
  | 'queues';

/**
 * Utilization status based on percentage thresholds
 */
export type UtilizationStatus = 'green' | 'yellow' | 'red';

/**
 * Service allowance definition
 */
export interface ServiceAllowance {
  /** Human-readable service name */
  name: string;
  /** Monthly allowance value (in native units) */
  monthlyLimit: number;
  /** Unit of measurement */
  unit: string;
  /** Whether this is a paid plan limit (vs free tier) */
  isPaidPlan: boolean;
  /** Description of the allowance */
  description: string;
}

/**
 * Project-specific allowance overrides
 */
export interface ProjectAllowance {
  projectId: string;
  projectName: string;
  /** Primary resource type for this project (e.g., D1 writes for data-heavy projects) */
  primaryResource: ServiceType;
  /** Custom limits that override account-level defaults */
  overrides?: Partial<Record<ServiceType, number>>;
}

/**
 * Account-level Cloudflare service allowances (Workers Paid Plan)
 *
 * Based on Cloudflare pricing as of January 2026:
 * - Workers Paid: $5/month includes 10M requests
 * - D1: 50M writes/month for paid accounts
 * - R2: 10 GB Class A operations included
 */
export const CF_ALLOWANCES: Record<ServiceType, ServiceAllowance> = {
  workers: {
    name: 'Workers Requests',
    monthlyLimit: 10_000_000,
    unit: 'requests',
    isPaidPlan: true,
    description: '10M requests included with Workers Paid ($5/mo)',
  },
  d1: {
    name: 'D1 Writes',
    monthlyLimit: 50_000_000,
    unit: 'rows written',
    isPaidPlan: true,
    description: '25B rows read + 50M rows written per month included',
  },
  kv: {
    name: 'KV Writes',
    monthlyLimit: 1_000_000,
    unit: 'writes',
    isPaidPlan: true,
    description: '10M reads + 1M writes/deletes/lists per month included',
  },
  r2: {
    name: 'R2 Storage',
    monthlyLimit: 10_000_000_000,
    unit: 'bytes',
    isPaidPlan: true,
    description: '10GB storage + 1M Class A + 10M Class B ops per month included',
  },
  durableObjects: {
    name: 'Durable Objects Requests',
    monthlyLimit: 1_000_000,
    unit: 'requests',
    isPaidPlan: true,
    description: '1M requests included in Workers Paid Plan',
  },
  vectorize: {
    name: 'Vectorize Stored Dimensions',
    monthlyLimit: 10_000_000,
    unit: 'dimensions',
    isPaidPlan: true,
    description:
      '10M stored dimensions + 50M queried dimensions per month included in Workers Paid Plan',
  },
  aiGateway: {
    name: 'AI Gateway Requests',
    monthlyLimit: Infinity,
    unit: 'requests',
    isPaidPlan: false,
    description: 'AI Gateway is free (cost is from underlying AI provider)',
  },
  workersAI: {
    name: 'Workers AI Neurons',
    monthlyLimit: 0,
    unit: 'neurons',
    isPaidPlan: true,
    description:
      'Pay-as-you-go: $0.011/1K neurons. No paid plan inclusion (free tier may apply but not tracked).',
  },
  pages: {
    name: 'Pages Builds',
    monthlyLimit: 500,
    unit: 'builds',
    isPaidPlan: false,
    description: '500 builds per month in free tier',
  },
  queues: {
    name: 'Queues Messages',
    monthlyLimit: 1_000_000,
    unit: 'messages',
    isPaidPlan: false,
    description: '1M messages per month in free tier',
  },
};

/**
 * Daily limits (derived from monthly for rate limiting purposes)
 */
export const CF_DAILY_LIMITS: Record<ServiceType, number> = {
  workers: Math.floor(CF_ALLOWANCES.workers.monthlyLimit / 30),
  d1: Math.floor(CF_ALLOWANCES.d1.monthlyLimit / 30),
  kv: Math.floor(CF_ALLOWANCES.kv.monthlyLimit / 30),
  r2: Math.floor(CF_ALLOWANCES.r2.monthlyLimit / 30),
  durableObjects: Math.floor(CF_ALLOWANCES.durableObjects.monthlyLimit / 30),
  vectorize: 0,
  aiGateway: Infinity,
  workersAI: 0,
  pages: Math.floor(CF_ALLOWANCES.pages.monthlyLimit / 30),
  queues: Math.floor(CF_ALLOWANCES.queues.monthlyLimit / 30),
};

/**
 * Project-specific configurations with primary resource assignments.
 *
 * TODO: Customise these for your projects. Each project should declare
 * which Cloudflare resource type is its "primary" resource for utilization tracking.
 */
export const PROJECT_ALLOWANCES: ProjectAllowance[] = [
  // Example: a data-heavy project using D1 as primary resource
  // {
  //   projectId: 'my-project',
  //   projectName: 'My Project',
  //   primaryResource: 'd1',
  // },
];

/**
 * Utilization threshold percentages for traffic light status
 */
export const UTILIZATION_THRESHOLDS = {
  /** Green zone: < 70% utilization */
  green: 70,
  /** Yellow zone: 70-90% utilization */
  yellow: 90,
  /** Red zone: > 90% utilization (or overage) */
  red: 100,
} as const;

/**
 * Simplified allowances for worker usage (limit + unit only).
 * Used by platform-usage worker for utilization calculations.
 */
export type SimpleAllowanceType =
  | 'workers'
  | 'd1'
  | 'kv'
  | 'r2'
  | 'vectorize'
  | 'workersAI'
  | 'durableObjects'
  | 'queues';

export const CF_SIMPLE_ALLOWANCES: Record<SimpleAllowanceType, { limit: number; unit: string }> = {
  workers: { limit: CF_ALLOWANCES.workers.monthlyLimit, unit: CF_ALLOWANCES.workers.unit },
  d1: { limit: CF_ALLOWANCES.d1.monthlyLimit, unit: CF_ALLOWANCES.d1.unit },
  kv: { limit: CF_ALLOWANCES.kv.monthlyLimit, unit: CF_ALLOWANCES.kv.unit },
  r2: { limit: CF_ALLOWANCES.r2.monthlyLimit, unit: CF_ALLOWANCES.r2.unit },
  vectorize: { limit: CF_ALLOWANCES.vectorize.monthlyLimit, unit: CF_ALLOWANCES.vectorize.unit },
  workersAI: { limit: CF_ALLOWANCES.workersAI.monthlyLimit, unit: CF_ALLOWANCES.workersAI.unit },
  durableObjects: {
    limit: CF_ALLOWANCES.durableObjects.monthlyLimit,
    unit: CF_ALLOWANCES.durableObjects.unit,
  },
  queues: {
    limit: CF_ALLOWANCES.queues.monthlyLimit,
    unit: CF_ALLOWANCES.queues.unit,
  },
};

// =============================================================================
// GITHUB ALLOWANCES & PRICING
// =============================================================================

/**
 * GitHub plan allowances
 *
 * @see https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions
 */
export const GITHUB_ALLOWANCES = {
  free: {
    actionsMinutes: 2000,
    actionsStorageGb: 0.5,
    packagesStorageGb: 0.5,
    packagesBandwidthGb: 1,
    lfsStorageGb: 1,
    lfsBandwidthGb: 1,
  },
  pro: {
    actionsMinutes: 3000,
    actionsStorageGb: 2,
    packagesStorageGb: 2,
    packagesBandwidthGb: 10,
    lfsStorageGb: 1,
    lfsBandwidthGb: 1,
  },
  team: {
    actionsMinutes: 3000,
    actionsStorageGb: 2,
    packagesStorageGb: 2,
    packagesBandwidthGb: 10,
    lfsStorageGb: 1,
    lfsBandwidthGb: 1,
  },
  enterprise: {
    actionsMinutes: 50000,
    actionsStorageGb: 50,
    packagesStorageGb: 50,
    packagesBandwidthGb: 100,
    lfsStorageGb: 250,
    lfsBandwidthGb: 250,
  },
} as const;

/**
 * GitHub pricing for overages and paid features (USD per unit)
 */
export const GITHUB_PRICING = {
  actions: {
    linux: 0.006,
    macos: 0.062,
    windows: 0.01,
    linuxLarge: 0.012,
    linuxXLarge: 0.024,
    gpuLinux: 0.07,
  },
  actionsStorageGb: 0.25,
  packagesStorageGb: 0.25,
  packagesBandwidthGb: 0.50,
  lfsStorageGb: 0.07,
  lfsBandwidthGb: 0.007,
  ghecPerUser: 21,
  ghasCodeSecurity: 49,
  ghasSecretProtection: 31,
  copilotBusiness: 19,
  copilotEnterprise: 39,
} as const;

/**
 * Get GitHub plan allowances by plan name
 */
export function getGitHubPlanAllowances(
  planName: string
): (typeof GITHUB_ALLOWANCES)[keyof typeof GITHUB_ALLOWANCES] {
  const lowerPlan = planName.toLowerCase();
  if (lowerPlan.includes('enterprise')) return GITHUB_ALLOWANCES.enterprise;
  if (lowerPlan.includes('team')) return GITHUB_ALLOWANCES.team;
  if (lowerPlan.includes('pro')) return GITHUB_ALLOWANCES.pro;
  return GITHUB_ALLOWANCES.free;
}

/**
 * Calculate utilization percentage
 */
export function calculateUtilizationPct(current: number, limit: number): number {
  if (limit === Infinity || limit === 0) return 0;
  return Math.min((current / limit) * 100, 999);
}

/**
 * Get utilization status (traffic light) based on percentage
 */
export function getUtilizationStatus(percentage: number): UtilizationStatus {
  if (percentage < UTILIZATION_THRESHOLDS.green) return 'green';
  if (percentage < UTILIZATION_THRESHOLDS.yellow) return 'yellow';
  return 'red';
}

/**
 * Get the effective limit for a project/service combination
 */
export function getEffectiveLimit(_projectId: string, serviceType: ServiceType): number {
  return CF_ALLOWANCES[serviceType].monthlyLimit;
}

/**
 * Get the list of tracked project IDs
 */
export function getTrackedProjectIds(): string[] {
  return PROJECT_ALLOWANCES.map((p) => p.projectId);
}

/**
 * Get project display name by ID
 */
export function getProjectDisplayName(projectId: string): string {
  const project = PROJECT_ALLOWANCES.find((p) => p.projectId === projectId);
  return project?.projectName ?? projectId;
}
