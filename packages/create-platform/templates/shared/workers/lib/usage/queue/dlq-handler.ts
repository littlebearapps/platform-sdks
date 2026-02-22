/**
 * Dead Letter Queue Handler
 *
 * Consumes messages from the platform-telemetry-dlq queue and persists them
 * to D1 for admin visibility, debugging, and replay.
 *
 * Messages land here after max_retries (5) failures in the main queue consumer.
 */

import type { MessageBatch } from '@cloudflare/workers-types';
import type { Env, TelemetryMessage } from '../shared';
import { createLoggerFromEnv } from '@littlebearapps/platform-sdk';
import { categoriseError } from '@littlebearapps/platform-sdk';

// =============================================================================
// DLQ CONSTANTS
// =============================================================================

const MAX_ERROR_MESSAGE_LENGTH = 1000;
const MAX_PAYLOAD_LENGTH = 10000;

// =============================================================================
// DLQ MESSAGE PERSISTENCE
// =============================================================================

/**
 * Persist a DLQ message to D1 for admin visibility.
 */
async function persistDLQMessage(
  telemetry: TelemetryMessage,
  errorMessage: string | null,
  errorCategory: string,
  errorFingerprint: string,
  retryCount: number,
  env: Env
): Promise<void> {
  const payload = JSON.stringify(telemetry);
  const truncatedPayload =
    payload.length > MAX_PAYLOAD_LENGTH ? payload.slice(0, MAX_PAYLOAD_LENGTH) + '...' : payload;
  const truncatedError = errorMessage?.slice(0, MAX_ERROR_MESSAGE_LENGTH) || null;

  await env.PLATFORM_DB.prepare(
    `INSERT INTO dead_letter_queue (
      id, message_payload, feature_key, project, category, feature,
      error_message, error_category, error_fingerprint, retry_count,
      correlation_id, original_timestamp, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', unixepoch(), unixepoch())`
  )
    .bind(
      crypto.randomUUID(),
      truncatedPayload,
      telemetry.feature_key,
      telemetry.project,
      telemetry.category,
      telemetry.feature,
      truncatedError,
      errorCategory,
      errorFingerprint,
      retryCount,
      telemetry.correlation_id || null,
      telemetry.timestamp
    )
    .run();
}

// =============================================================================
// DLQ QUEUE HANDLER
// =============================================================================

/**
 * Handle messages from the Dead Letter Queue.
 *
 * Messages arrive here after exhausting retries in the main queue.
 * We persist them to D1 for visibility and always ack to prevent re-delivery.
 */
async function handleDLQ(batch: MessageBatch<TelemetryMessage>, env: Env): Promise<void> {
  const log = createLoggerFromEnv(env, 'platform-usage', 'platform:usage:dlq');
  log.warn('Processing DLQ batch', { messages: batch.messages.length });

  let successCount = 0;
  let errorCount = 0;

  for (const message of batch.messages) {
    try {
      const telemetry = message.body;

      // Extract error info from the message metadata if available
      // Cloudflare doesn't expose retry count directly, so we use max_retries setting
      const retryCount = 5; // Matches max_retries in wrangler config

      // Since we don't have the original error, categorise based on telemetry content
      const errorCategory = telemetry.error_category || 'INTERNAL';
      const errorFingerprint = `dlq:${telemetry.feature_key}:${errorCategory}`;

      // Persist to D1
      await persistDLQMessage(
        telemetry,
        'Message exhausted retries in telemetry queue',
        errorCategory,
        errorFingerprint,
        retryCount,
        env
      );

      log.info('DLQ message persisted', {
        feature_key: telemetry.feature_key,
        project: telemetry.project,
        error_category: errorCategory,
        correlation_id: telemetry.correlation_id,
      });

      message.ack();
      successCount++;
    } catch (error) {
      // Even if D1 write fails, ack the message to prevent infinite loop
      // Log the error for investigation
      const errorCategory = categoriseError(error);
      log.error('Failed to persist DLQ message, acknowledging anyway', error, {
        feature_key: message.body.feature_key,
        error_category: errorCategory,
      });

      message.ack();
      errorCount++;
    }
  }

  log.info('DLQ batch complete', {
    persisted: successCount,
    failed: errorCount,
    total: batch.messages.length,
  });

  // Send alert if DLQ is receiving messages (indicates systemic issue)
  if (batch.messages.length > 0 && env.ALERT_ROUTER) {
    try {
      await env.ALERT_ROUTER.fetch('https://alert-router/errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'p1_digest',
          feature_key: 'platform:usage:dlq',
          project: 'platform',
          category: 'usage',
          feature: 'dlq',
          total_errors: batch.messages.length,
          distinct_types: new Set(batch.messages.map((m) => m.body.error_category || 'INTERNAL'))
            .size,
        }),
      });
    } catch (alertError) {
      log.error('Failed to send DLQ alert', alertError);
    }
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

export { handleDLQ, persistDLQMessage };
