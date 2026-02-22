import type { D1Database } from '@cloudflare/workers-types';

export async function insertRevenueMetric(
  db: D1Database,
  metricType: string,
  value: number,
  metadata?: Record<string, unknown>
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO revenue_metrics (id, metric_type, value, timestamp, metadata)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      metricType,
      value,
      Math.floor(Date.now() / 1000),
      metadata ? JSON.stringify(metadata) : null
    )
    .run();
}

export async function insertProductMetric(
  db: D1Database,
  source: string,
  metricType: string,
  value: number,
  metadata?: Record<string, unknown>
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO product_metrics (id, source, metric_type, value, timestamp, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      source,
      metricType,
      value,
      Math.floor(Date.now() / 1000),
      metadata ? JSON.stringify(metadata) : null
    )
    .run();
}

export async function createAlert(
  db: D1Database,
  category: 'revenue' | 'product',
  severity: 'critical' | 'high' | 'medium' | 'low',
  title: string,
  description: string,
  source: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO alerts (id, category, severity, title, description, source, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      category,
      severity,
      title,
      description,
      source,
      Math.floor(Date.now() / 1000)
    )
    .run();
}

export async function getPreviousMetric(
  db: D1Database,
  table: 'revenue_metrics' | 'product_metrics',
  metricType: string,
  sinceSeconds: number,
  source?: string
): Promise<number | null> {
  const clauses = ['metric_type = ?', 'timestamp > ?'];
  const params: Array<string | number> = [metricType, Math.floor(Date.now() / 1000) - sinceSeconds];

  if (table === 'product_metrics' && source) {
    clauses.unshift('source = ?');
    params.unshift(source);
  }

  const result = await db
    .prepare(
      `SELECT value FROM ${table}
       WHERE ${clauses.join(' AND ')}
       ORDER BY timestamp ASC
       LIMIT 1`
    )
    .bind(...params)
    .first<{ value: number }>();

  if (!result) {
    return null;
  }

  const value = result.value;
  return typeof value === 'number' ? value : Number(value ?? NaN);
}
