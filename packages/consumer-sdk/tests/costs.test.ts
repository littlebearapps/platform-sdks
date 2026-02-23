import { describe, it, expect } from 'vitest';
import {
  HOURS_PER_MONTH,
  DAYS_PER_MONTH,
  PRICING_TIERS,
  PAID_ALLOWANCES,
  calculateHourlyCosts,
  prorateBaseCost,
  prorateBaseCostByDays,
  calculateDailyBillableCosts,
  type HourlyUsageMetrics,
  type AccountDailyUsage,
} from '../src/costs';

// =============================================================================
// HELPERS
// =============================================================================

function zeroHourlyUsage(): HourlyUsageMetrics {
  return {
    workersRequests: 0,
    workersCpuMs: 0,
    d1Reads: 0,
    d1Writes: 0,
    kvReads: 0,
    kvWrites: 0,
    r2ClassA: 0,
    r2ClassB: 0,
    vectorizeQueries: 0,
    aiGatewayRequests: 0,
    durableObjectsRequests: 0,
  };
}

function zeroDailyUsage(): AccountDailyUsage {
  return {
    workersRequests: 0,
    workersCpuMs: 0,
    d1RowsRead: 0,
    d1RowsWritten: 0,
    d1StorageBytes: 0,
    kvReads: 0,
    kvWrites: 0,
    kvDeletes: 0,
    kvLists: 0,
    kvStorageBytes: 0,
    r2ClassA: 0,
    r2ClassB: 0,
    r2StorageBytes: 0,
    doRequests: 0,
    doGbSeconds: 0,
    doStorageReads: 0,
    doStorageWrites: 0,
    doStorageDeletes: 0,
    vectorizeQueries: 0,
    vectorizeStoredDimensions: 0,
    aiGatewayRequests: 0,
    workersAINeurons: 0,
    queuesMessagesProduced: 0,
    queuesMessagesConsumed: 0,
    pagesDeployments: 0,
    pagesBandwidthBytes: 0,
    workflowsExecutions: 0,
    workflowsCpuMs: 0,
  };
}

// =============================================================================
// CONSTANTS
// =============================================================================

describe('Proration constants', () => {
  it('HOURS_PER_MONTH is approximately 730', () => {
    expect(HOURS_PER_MONTH).toBeCloseTo(730, 0);
    expect(HOURS_PER_MONTH).toBe((365 * 24) / 12);
  });

  it('DAYS_PER_MONTH is approximately 30.42', () => {
    expect(DAYS_PER_MONTH).toBeCloseTo(30.42, 1);
    expect(DAYS_PER_MONTH).toBe(365 / 12);
  });
});

describe('PRICING_TIERS', () => {
  it('has workers base cost of $5/month', () => {
    expect(PRICING_TIERS.workers.baseCostMonthly).toBe(5.0);
    expect(PRICING_TIERS.workers.includedRequests).toBe(10_000_000);
  });

  it('has D1 pricing', () => {
    expect(PRICING_TIERS.d1.rowsReadPerBillion).toBe(0.001);
    expect(PRICING_TIERS.d1.rowsWrittenPerMillion).toBe(1.0);
  });

  it('has AI Gateway marked as free', () => {
    expect(PRICING_TIERS.aiGateway.free).toBe(true);
  });

  it('has Workflows marked as free', () => {
    expect(PRICING_TIERS.workflows.free).toBe(true);
  });
});

describe('PAID_ALLOWANCES', () => {
  it('has D1 allowances', () => {
    expect(PAID_ALLOWANCES.d1.rowsRead).toBe(25_000_000_000);
    expect(PAID_ALLOWANCES.d1.rowsWritten).toBe(50_000_000);
  });

  it('has KV allowances', () => {
    expect(PAID_ALLOWANCES.kv.reads).toBe(10_000_000);
    expect(PAID_ALLOWANCES.kv.writes).toBe(1_000_000);
  });
});

// =============================================================================
// prorateBaseCost
// =============================================================================

describe('prorateBaseCost', () => {
  it('prorates $5/month to correct hourly rate', () => {
    const hourly = prorateBaseCost(1);
    expect(hourly).toBeCloseTo(5.0 / HOURS_PER_MONTH, 6);
  });

  it('full month returns $5', () => {
    const full = prorateBaseCost(HOURS_PER_MONTH);
    expect(full).toBeCloseTo(5.0, 6);
  });

  it('zero hours returns 0', () => {
    expect(prorateBaseCost(0)).toBe(0);
  });

  it('24 hours returns one day of cost', () => {
    const daily = prorateBaseCost(24);
    expect(daily).toBeCloseTo((5.0 / HOURS_PER_MONTH) * 24, 6);
  });
});

describe('prorateBaseCostByDays', () => {
  it('prorates $5/month to correct daily rate', () => {
    const daily = prorateBaseCostByDays(1);
    expect(daily).toBeCloseTo(5.0 / DAYS_PER_MONTH, 6);
  });

  it('full month returns $5', () => {
    const full = prorateBaseCostByDays(DAYS_PER_MONTH);
    expect(full).toBeCloseTo(5.0, 6);
  });

  it('zero days returns 0', () => {
    expect(prorateBaseCostByDays(0)).toBe(0);
  });
});

// =============================================================================
// calculateHourlyCosts
// =============================================================================

describe('calculateHourlyCosts', () => {
  it('zero usage still has prorated base cost', () => {
    const result = calculateHourlyCosts(zeroHourlyUsage());
    expect(result.workers).toBeCloseTo(5.0 / HOURS_PER_MONTH, 6);
    expect(result.d1).toBe(0);
    expect(result.kv).toBe(0);
    expect(result.r2).toBe(0);
    expect(result.durableObjects).toBe(0);
    expect(result.vectorize).toBe(0);
    expect(result.aiGateway).toBe(0);
    expect(result.workersAI).toBe(0);
    expect(result.pages).toBe(0);
    expect(result.queues).toBe(0);
    expect(result.workflows).toBe(0);
    expect(result.total).toBeCloseTo(5.0 / HOURS_PER_MONTH, 6);
  });

  it('returns all expected fields', () => {
    const result = calculateHourlyCosts(zeroHourlyUsage());
    const keys = Object.keys(result);
    expect(keys).toContain('workers');
    expect(keys).toContain('d1');
    expect(keys).toContain('kv');
    expect(keys).toContain('r2');
    expect(keys).toContain('durableObjects');
    expect(keys).toContain('vectorize');
    expect(keys).toContain('aiGateway');
    expect(keys).toContain('workersAI');
    expect(keys).toContain('pages');
    expect(keys).toContain('queues');
    expect(keys).toContain('workflows');
    expect(keys).toContain('total');
  });

  it('workers requests below hourly allowance produce no overage', () => {
    const usage = zeroHourlyUsage();
    usage.workersRequests = 1000; // Well below hourly allowance (~13,699)
    const result = calculateHourlyCosts(usage);
    // Only base cost
    expect(result.workers).toBeCloseTo(5.0 / HOURS_PER_MONTH, 6);
  });

  it('workers requests above hourly allowance produce overage cost', () => {
    const usage = zeroHourlyUsage();
    const hourlyAllowance = PRICING_TIERS.workers.includedRequests / HOURS_PER_MONTH;
    usage.workersRequests = hourlyAllowance + 1_000_000; // 1M over
    const result = calculateHourlyCosts(usage);
    const expectedOverage = (1_000_000 / 1_000_000) * PRICING_TIERS.workers.requestsPerMillion;
    expect(result.workers).toBeGreaterThan(5.0 / HOURS_PER_MONTH + expectedOverage - 0.001);
  });

  it('D1 reads within hourly allowance produce zero cost', () => {
    const usage = zeroHourlyUsage();
    usage.d1Reads = 1000; // Well below hourly allowance
    const result = calculateHourlyCosts(usage);
    expect(result.d1).toBe(0);
  });

  it('D1 writes above hourly allowance produce cost', () => {
    const usage = zeroHourlyUsage();
    const hourlyAllowance = PAID_ALLOWANCES.d1.rowsWritten / HOURS_PER_MONTH;
    usage.d1Writes = hourlyAllowance + 1_000_000; // 1M over
    const result = calculateHourlyCosts(usage);
    expect(result.d1).toBeGreaterThan(0);
  });

  it('KV reads within hourly allowance produce zero cost', () => {
    const usage = zeroHourlyUsage();
    usage.kvReads = 100;
    const result = calculateHourlyCosts(usage);
    expect(result.kv).toBe(0);
  });

  it('optional kvDeletes and kvLists default to 0', () => {
    const usage = zeroHourlyUsage();
    // No kvDeletes or kvLists set
    const result = calculateHourlyCosts(usage);
    expect(result.kv).toBe(0);
  });

  it('optional kvDeletes counted when provided', () => {
    const usage = zeroHourlyUsage();
    const hourlyAllowance = PAID_ALLOWANCES.kv.deletes / HOURS_PER_MONTH;
    usage.kvDeletes = hourlyAllowance + 500_000;
    const result = calculateHourlyCosts(usage);
    expect(result.kv).toBeGreaterThan(0);
  });

  it('R2 Class A above hourly allowance produces cost', () => {
    const usage = zeroHourlyUsage();
    const hourlyAllowance = PAID_ALLOWANCES.r2.classA / HOURS_PER_MONTH;
    usage.r2ClassA = hourlyAllowance + 500_000;
    const result = calculateHourlyCosts(usage);
    expect(result.r2).toBeGreaterThan(0);
  });

  it('Vectorize queries within hourly allowance produce zero cost', () => {
    const usage = zeroHourlyUsage();
    usage.vectorizeQueries = 100;
    const result = calculateHourlyCosts(usage);
    expect(result.vectorize).toBe(0);
  });

  it('Durable Objects requests above hourly allowance produce cost', () => {
    const usage = zeroHourlyUsage();
    const hourlyAllowance = PAID_ALLOWANCES.durableObjects.requests / HOURS_PER_MONTH;
    usage.durableObjectsRequests = hourlyAllowance + 100_000;
    const result = calculateHourlyCosts(usage);
    expect(result.durableObjects).toBeGreaterThan(0);
  });

  it('optional durableObjectsGbSeconds defaults to 0', () => {
    const usage = zeroHourlyUsage();
    usage.durableObjectsRequests = 0;
    const result = calculateHourlyCosts(usage);
    expect(result.durableObjects).toBe(0);
  });

  it('Workers AI neurons produce cost', () => {
    const usage = zeroHourlyUsage();
    usage.workersAINeurons = 100_000;
    const result = calculateHourlyCosts(usage);
    const neuronsPerUsd = PRICING_TIERS.workersAI.neuronsPerThousand / 1000;
    expect(result.workersAI).toBeCloseTo(100_000 * neuronsPerUsd, 6);
  });

  it('optional workersAINeurons defaults to 0', () => {
    const usage = zeroHourlyUsage();
    const result = calculateHourlyCosts(usage);
    expect(result.workersAI).toBe(0);
  });

  it('Queues messages produce cost', () => {
    const usage = zeroHourlyUsage();
    usage.queuesMessages = 2_000_000;
    const result = calculateHourlyCosts(usage);
    expect(result.queues).toBeCloseTo(
      (2_000_000 / 1_000_000) * PRICING_TIERS.queues.messagesPerMillion,
      6
    );
  });

  it('total is sum of all components', () => {
    const usage = zeroHourlyUsage();
    usage.workersAINeurons = 50_000;
    usage.queuesMessages = 1_000_000;
    const result = calculateHourlyCosts(usage);
    const summed =
      result.workers +
      result.d1 +
      result.kv +
      result.r2 +
      result.durableObjects +
      result.vectorize +
      result.aiGateway +
      result.workersAI +
      result.pages +
      result.queues +
      result.workflows;
    expect(result.total).toBeCloseTo(summed, 10);
  });

  it('AI Gateway is always free (0)', () => {
    const usage = zeroHourlyUsage();
    usage.aiGatewayRequests = 999_999;
    const result = calculateHourlyCosts(usage);
    expect(result.aiGateway).toBe(0);
  });

  it('Pages and Workflows are always 0 at hourly granularity', () => {
    const result = calculateHourlyCosts(zeroHourlyUsage());
    expect(result.pages).toBe(0);
    expect(result.workflows).toBe(0);
  });

  it('CPU ms cost has no allowance', () => {
    const usage = zeroHourlyUsage();
    usage.workersCpuMs = 10_000_000; // 10M CPU ms
    const result = calculateHourlyCosts(usage);
    const cpuCost = (10_000_000 / 1_000_000) * PRICING_TIERS.workers.cpuMsPerMillion;
    const baseCost = 5.0 / HOURS_PER_MONTH;
    expect(result.workers).toBeCloseTo(baseCost + cpuCost, 4);
  });
});

// =============================================================================
// calculateDailyBillableCosts
// =============================================================================

describe('calculateDailyBillableCosts', () => {
  it('zero usage returns only prorated base cost', () => {
    const result = calculateDailyBillableCosts(zeroDailyUsage(), 15, 30);
    expect(result.workers).toBeCloseTo((5.0 / 30) * 15, 6);
    expect(result.d1).toBe(0);
    expect(result.kv).toBe(0);
    expect(result.total).toBeCloseTo((5.0 / 30) * 15, 6);
  });

  it('returns all expected fields', () => {
    const result = calculateDailyBillableCosts(zeroDailyUsage(), 1, 30);
    const keys = Object.keys(result);
    expect(keys).toEqual(
      expect.arrayContaining([
        'workers',
        'd1',
        'kv',
        'r2',
        'durableObjects',
        'vectorize',
        'aiGateway',
        'workersAI',
        'pages',
        'queues',
        'workflows',
        'total',
      ])
    );
  });

  it('prorates monthly allowances by daysElapsed/daysInPeriod', () => {
    const usage = zeroDailyUsage();
    // 2M D1 writes in 15 days of a 30-day month
    // Prorated allowance: 50M * (15/30) = 25M
    // 2M < 25M → $0 billable
    usage.d1RowsWritten = 2_000_000;
    const result = calculateDailyBillableCosts(usage, 15, 30);
    expect(result.d1).toBe(0);
  });

  it('D1 writes above prorated allowance produce cost', () => {
    const usage = zeroDailyUsage();
    // 60M writes in 30 days of a 30-day month
    // Full allowance: 50M, prorated: 50M * (30/30) = 50M
    // Billable: 60M - 50M = 10M * $1/M = $10
    usage.d1RowsWritten = 60_000_000;
    const result = calculateDailyBillableCosts(usage, 30, 30);
    expect(result.d1).toBeCloseTo(10.0, 4);
  });

  it('D1 storage costs are not allowance-adjusted', () => {
    const usage = zeroDailyUsage();
    usage.d1StorageBytes = 2_000_000_000; // 2GB
    const result = calculateDailyBillableCosts(usage, 30, 30);
    expect(result.d1).toBeCloseTo(2 * PRICING_TIERS.d1.storagePerGb, 4);
  });

  it('KV operations respect prorated allowances', () => {
    const usage = zeroDailyUsage();
    // 5M KV writes, full month. Allowance: 1M. Billable: 4M
    usage.kvWrites = 5_000_000;
    const result = calculateDailyBillableCosts(usage, 30, 30);
    const expected = (4_000_000 / 1_000_000) * PRICING_TIERS.kv.writesPerMillion;
    expect(result.kv).toBeGreaterThanOrEqual(expected - 0.01);
  });

  it('Queues combines produced + consumed messages', () => {
    const usage = zeroDailyUsage();
    usage.queuesMessagesProduced = 500_000;
    usage.queuesMessagesConsumed = 500_000;
    // Total: 1M. Allowance: 1M. Billable: 0
    const result = calculateDailyBillableCosts(usage, 30, 30);
    expect(result.queues).toBe(0);
  });

  it('Queues above allowance produce cost', () => {
    const usage = zeroDailyUsage();
    usage.queuesMessagesProduced = 1_500_000;
    usage.queuesMessagesConsumed = 1_500_000;
    // Total: 3M. Full allowance: 1M. Billable: 2M
    const result = calculateDailyBillableCosts(usage, 30, 30);
    const expected = (2_000_000 / 1_000_000) * PRICING_TIERS.queues.messagesPerMillion;
    expect(result.queues).toBeCloseTo(expected, 4);
  });

  it('Workers AI has no allowance', () => {
    const usage = zeroDailyUsage();
    usage.workersAINeurons = 100_000;
    const result = calculateDailyBillableCosts(usage, 30, 30);
    const neuronsPerUsd = PRICING_TIERS.workersAI.neuronsPerThousand / 1000;
    expect(result.workersAI).toBeCloseTo(100_000 * neuronsPerUsd, 6);
  });

  it('daysInPeriod = 0 uses prorationFactor of 1', () => {
    const usage = zeroDailyUsage();
    usage.d1RowsWritten = 100_000_000; // 100M
    // prorationFactor = 1, full allowance = 50M, billable = 50M
    const result = calculateDailyBillableCosts(usage, 0, 0);
    expect(result.d1).toBeGreaterThan(0);
  });

  it('all costs clamped to >= 0 via Math.max', () => {
    const result = calculateDailyBillableCosts(zeroDailyUsage(), 30, 30);
    expect(result.workers).toBeGreaterThanOrEqual(0);
    expect(result.d1).toBeGreaterThanOrEqual(0);
    expect(result.kv).toBeGreaterThanOrEqual(0);
    expect(result.r2).toBeGreaterThanOrEqual(0);
    expect(result.durableObjects).toBeGreaterThanOrEqual(0);
    expect(result.vectorize).toBeGreaterThanOrEqual(0);
    expect(result.workersAI).toBeGreaterThanOrEqual(0);
    expect(result.queues).toBeGreaterThanOrEqual(0);
    expect(result.total).toBeGreaterThanOrEqual(0);
  });

  it('Pages cost is always 0 (TODO)', () => {
    const usage = zeroDailyUsage();
    usage.pagesDeployments = 1000;
    usage.pagesBandwidthBytes = 500_000_000_000;
    const result = calculateDailyBillableCosts(usage, 30, 30);
    expect(result.pages).toBe(0);
  });

  it('Workflows cost is always 0 (beta)', () => {
    const usage = zeroDailyUsage();
    usage.workflowsExecutions = 10_000;
    const result = calculateDailyBillableCosts(usage, 30, 30);
    expect(result.workflows).toBe(0);
  });

  it('total is sum of all components', () => {
    const usage = zeroDailyUsage();
    usage.d1RowsWritten = 100_000_000;
    usage.workersAINeurons = 50_000;
    const result = calculateDailyBillableCosts(usage, 30, 30);
    const summed =
      result.workers +
      result.d1 +
      result.kv +
      result.r2 +
      result.durableObjects +
      result.vectorize +
      result.aiGateway +
      result.workersAI +
      result.pages +
      result.queues +
      result.workflows;
    expect(result.total).toBeCloseTo(summed, 10);
  });

  it('DO storage reads/writes/deletes have no allowance', () => {
    const usage = zeroDailyUsage();
    usage.doStorageReads = 2_000_000;
    usage.doStorageWrites = 1_000_000;
    usage.doStorageDeletes = 500_000;
    const result = calculateDailyBillableCosts(usage, 30, 30);
    const expected =
      (2_000_000 / 1_000_000) * PRICING_TIERS.durableObjects.readsPerMillion +
      (1_000_000 / 1_000_000) * PRICING_TIERS.durableObjects.writesPerMillion +
      (500_000 / 1_000_000) * PRICING_TIERS.durableObjects.deletesPerMillion;
    expect(result.durableObjects).toBeCloseTo(expected, 4);
  });
});
