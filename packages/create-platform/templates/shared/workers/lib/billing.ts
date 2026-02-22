/**
 * Billing Period Utilities
 *
 * Provides billing-cycle-aware calculations for accurate allowance proration.
 * Supports both calendar-month and mid-month billing cycles.
 *
 * @see https://developers.cloudflare.com/workers/platform/pricing/
 */

/**
 * Billing period information
 */
export interface BillingPeriod {
  /** Start date of the current billing period */
  startDate: Date;
  /** End date of the current billing period */
  endDate: Date;
  /** Total days in this billing period */
  daysInPeriod: number;
  /** Days elapsed since billing period started */
  daysElapsed: number;
  /** Days remaining until billing period ends */
  daysRemaining: number;
  /** Progress through billing period (0-1) */
  progress: number;
}

/**
 * Plan types supported by Cloudflare
 */
export type PlanType = 'free' | 'paid' | 'enterprise';

/**
 * Billing settings from D1
 */
export interface BillingSettings {
  accountId: string;
  planType: PlanType;
  billingCycleDay: number; // 1-28 or 0 for calendar month
  billingCurrency: string;
  baseCostMonthly: number;
  notes?: string;
}

/**
 * Calculate the billing period boundaries for a given reference date.
 *
 * @param billingCycleDay - Day of month billing starts (1-28) or 0 for calendar month
 * @param refDate - Reference date (defaults to now)
 * @returns Billing period information
 *
 * @example
 * // Calendar month billing (billing_cycle_day = 0 or 1)
 * calculateBillingPeriod(1, new Date('2026-01-15'))
 * // Returns: startDate: Jan 1, endDate: Jan 31, daysInPeriod: 31
 *
 * @example
 * // Mid-month billing (billing_cycle_day = 15)
 * calculateBillingPeriod(15, new Date('2026-01-20'))
 * // Returns: startDate: Jan 15, endDate: Feb 14, daysInPeriod: 31
 */
export function calculateBillingPeriod(
  billingCycleDay: number,
  refDate = new Date()
): BillingPeriod {
  // Normalise to calendar month if 0 or 1
  const cycleDay = billingCycleDay <= 1 ? 1 : Math.min(billingCycleDay, 28);

  const year = refDate.getFullYear();
  const month = refDate.getMonth();
  const day = refDate.getDate();

  let startDate: Date;
  let endDate: Date;

  if (cycleDay === 1) {
    // Calendar month billing
    startDate = new Date(year, month, 1);
    endDate = new Date(year, month + 1, 0); // Last day of current month
  } else {
    // Mid-month billing
    if (day >= cycleDay) {
      // We're in the period that started this month
      startDate = new Date(year, month, cycleDay);
      endDate = new Date(year, month + 1, cycleDay - 1);
    } else {
      // We're in the period that started last month
      startDate = new Date(year, month - 1, cycleDay);
      endDate = new Date(year, month, cycleDay - 1);
    }
  }

  // Calculate days
  const daysInPeriod =
    Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  const daysElapsed =
    Math.round((refDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  const daysRemaining = Math.max(0, daysInPeriod - daysElapsed);
  const progress = Math.min(1, daysElapsed / daysInPeriod);

  return {
    startDate,
    endDate,
    daysInPeriod,
    daysElapsed,
    daysRemaining,
    progress,
  };
}

/**
 * Prorate a monthly allowance based on query period vs billing period.
 *
 * @param monthlyAllowance - Full monthly allowance (e.g., 10M Workers requests)
 * @param periodDays - Number of days in the query period (e.g., 1 for 24h, 7 for 7d)
 * @param billingDays - Total days in the billing period (default 30)
 * @returns Prorated allowance for the query period
 *
 * @example
 * // 24h query against 10M monthly allowance
 * prorateAllowance(10_000_000, 1, 30)
 * // Returns: 333,333 (1/30th of monthly)
 *
 * @example
 * // 7d query against 50M monthly allowance
 * prorateAllowance(50_000_000, 7, 31)
 * // Returns: 11,290,323 (7/31ths of monthly)
 */
export function prorateAllowance(
  monthlyAllowance: number,
  periodDays: number,
  billingDays = 30
): number {
  if (billingDays <= 0) return monthlyAllowance;
  if (periodDays >= billingDays) return monthlyAllowance;
  return Math.round(monthlyAllowance * (periodDays / billingDays));
}

/**
 * Calculate billable usage after subtracting prorated allowance.
 *
 * @param usage - Raw usage for the period
 * @param monthlyAllowance - Full monthly allowance
 * @param periodDays - Number of days in the query period
 * @param billingDays - Total days in the billing period (default 30)
 * @returns Object with raw, prorated allowance, billable usage, and percentage
 *
 * @example
 * // 500K requests in 24h against 10M monthly allowance
 * calculateBillableUsage(500_000, 10_000_000, 1, 30)
 * // Returns: { raw: 500000, proratedAllowance: 333333, billable: 166667, pctOfAllowance: 150 }
 */
export function calculateBillableUsage(
  usage: number,
  monthlyAllowance: number,
  periodDays: number,
  billingDays = 30
): {
  raw: number;
  proratedAllowance: number;
  billable: number;
  pctOfAllowance: number;
} {
  const proratedAllowance = prorateAllowance(monthlyAllowance, periodDays, billingDays);
  const billable = Math.max(0, usage - proratedAllowance);
  const pctOfAllowance = proratedAllowance > 0 ? (usage / proratedAllowance) * 100 : 0;

  return {
    raw: usage,
    proratedAllowance,
    billable,
    pctOfAllowance,
  };
}

/**
 * Get the default billing settings.
 * Used as fallback when D1 data is unavailable.
 */
export function getDefaultBillingSettings(): BillingSettings {
  return {
    accountId: 'default',
    planType: 'paid',
    billingCycleDay: 1, // Calendar month
    billingCurrency: 'USD',
    baseCostMonthly: 5.0, // Workers Paid Plan
    notes: 'Default billing settings',
  };
}

/**
 * Calculate fair share allowance allocation for a project.
 *
 * Uses proportional fair share: each project gets a share of the total
 * allowance proportional to their share of total usage.
 *
 * @param projectUsage - Usage for this project
 * @param totalAccountUsage - Total usage across all projects
 * @param monthlyAllowance - Total monthly allowance for the account
 * @returns Object with allowance share and billable usage
 */
export function calculateProjectAllowanceShare(
  projectUsage: number,
  totalAccountUsage: number,
  monthlyAllowance: number
): {
  share: number;
  billable: number;
  proportion: number;
} {
  if (totalAccountUsage <= 0) {
    return { share: 0, billable: 0, proportion: 0 };
  }

  const proportion = projectUsage / totalAccountUsage;
  const share = monthlyAllowance * proportion;
  const billable = Math.max(0, projectUsage - share);

  return {
    share: Math.round(share),
    billable: Math.round(billable),
    proportion,
  };
}

/**
 * Billing window with ISO date strings for SQL queries.
 */
export interface BillingWindow {
  /** Start date as YYYY-MM-DD string */
  startDate: string;
  /** End date as YYYY-MM-DD string */
  endDate: string;
  /** Days elapsed in current period */
  daysElapsed: number;
  /** Total days in billing period */
  daysInPeriod: number;
  /** Progress through period (0-1) */
  progress: number;
}

/**
 * Get billing window dates for SQL queries.
 *
 * Convenience wrapper around calculateBillingPeriod that returns
 * ISO date strings ready for D1 queries.
 *
 * @param anchorDay - Day of month billing resets (1-28) or 0/1 for calendar month
 * @param refDate - Reference date (defaults to now)
 * @returns Billing window with date strings
 */
export function getBillingWindow(anchorDay: number, refDate = new Date()): BillingWindow {
  const period = calculateBillingPeriod(anchorDay, refDate);

  // Format as YYYY-MM-DD in local time (not UTC) to match D1 date storage
  const formatLocalDate = (date: Date): string => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };

  return {
    startDate: formatLocalDate(period.startDate),
    endDate: formatLocalDate(period.endDate),
    daysElapsed: period.daysElapsed,
    daysInPeriod: period.daysInPeriod,
    progress: period.progress,
  };
}

/**
 * Format billing period for display.
 *
 * @param period - Billing period from calculateBillingPeriod
 * @returns Formatted string like "Jan 1 - Jan 31"
 */
export function formatBillingPeriod(period: BillingPeriod): string {
  const formatter = new Intl.DateTimeFormat('en-AU', { month: 'short', day: 'numeric' });
  return `${formatter.format(period.startDate)} - ${formatter.format(period.endDate)}`;
}

/**
 * Get billing countdown text.
 *
 * @param daysRemaining - Days remaining in billing period
 * @returns Human-readable countdown string
 */
export function getBillingCountdownText(daysRemaining: number): string {
  if (daysRemaining <= 0) return 'Billing reset today';
  if (daysRemaining === 1) return '1 day until billing reset';
  return `${daysRemaining} days until billing reset`;
}
