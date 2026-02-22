/// <reference types="@cloudflare/workers-types" />

/**
 * Platform SDK - Durable Object Heartbeat Mixin
 *
 * Provides alarm-based health monitoring for Durable Objects.
 * Uses the Alarms API to send periodic heartbeats to the platform telemetry queue.
 *
 * @example
 * ```typescript
 * import { withHeartbeat } from '../lib/platform-sdk';
 *
 * export class MyDurableObject extends withHeartbeat(DurableObject, {
 *   featureKey: 'scout:do:triage-workflow',
 *   intervalMs: 5 * 60 * 1000, // 5 minutes
 * }) {
 *   // Existing implementation unchanged
 * }
 * ```
 */

import type { TelemetryMessage } from './types';
import { createLogger, type Logger } from './logging';

// =============================================================================
// MODULE LOGGER (lazy-initialized to avoid global scope crypto calls)
// =============================================================================

let _log: Logger | null = null;
function getLog(): Logger {
  if (!_log) {
    _log = createLogger({
      worker: 'platform-sdk',
      featureId: 'platform:sdk:do-heartbeat',
    });
  }
  return _log;
}

// =============================================================================
// TYPES
// =============================================================================

/**
 * Configuration for the heartbeat mixin.
 */
export interface HeartbeatConfig {
  /** Feature key in format 'project:category:feature' */
  featureKey: string;
  /** Heartbeat interval in milliseconds. Default: 5 minutes */
  intervalMs?: number;
  /** Whether heartbeats are enabled. Default: true */
  enabled?: boolean;
}

/**
 * Required environment bindings for heartbeat functionality.
 */
export interface HeartbeatEnv {
  /** Queue for telemetry messages */
  PLATFORM_TELEMETRY: Queue<TelemetryMessage>;
}

/**
 * Base class type for Durable Objects.
 * Uses rest parameters for TypeScript mixin compatibility.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DOClass = new (...args: any[]) => DurableObject;

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default heartbeat interval: 5 minutes */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

// =============================================================================
// MIXIN
// =============================================================================

/**
 * Parse a feature key into its component parts.
 */
function parseFeatureKey(featureKey: string): {
  project: string;
  category: string;
  feature: string;
} {
  const parts = featureKey.split(':');
  if (parts.length !== 3) {
    throw new Error(
      `Invalid featureKey format: "${featureKey}". Expected "project:category:feature"`
    );
  }
  return {
    project: parts[0],
    category: parts[1],
    feature: parts[2],
  };
}

/**
 * Mixin that adds heartbeat functionality to a Durable Object.
 *
 * Uses the Cloudflare Alarms API to schedule periodic heartbeats.
 * Heartbeats are sent to the PLATFORM_TELEMETRY queue with `is_heartbeat: true`.
 *
 * The mixin:
 * 1. Schedules the first heartbeat on construction
 * 2. Sends a heartbeat message when the alarm fires
 * 3. Reschedules the next heartbeat
 * 4. Calls the parent's alarm() method if it exists
 *
 * @param Base - The base Durable Object class to extend
 * @param config - Heartbeat configuration
 * @returns Extended class with heartbeat functionality
 *
 * @example
 * ```typescript
 * export class ScoutTriageWorkflow extends withHeartbeat(DurableObject, {
 *   featureKey: 'scout:do:triage-workflow',
 *   intervalMs: 5 * 60 * 1000,
 * }) {
 *   async fetch(request: Request): Promise<Response> {
 *     // Your existing implementation
 *   }
 * }
 * ```
 */
export function withHeartbeat<TBase extends DOClass>(Base: TBase, config: HeartbeatConfig): TBase {
  const { featureKey, intervalMs = DEFAULT_INTERVAL_MS, enabled = true } = config;

  // Validate feature key format early
  const { project, category, feature } = parseFeatureKey(featureKey);

  return class extends Base {
    // Store parsed config for use in methods
    protected readonly _heartbeatConfig = {
      featureKey,
      project,
      category,
      feature,
      intervalMs,
      enabled,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(...args: any[]) {
      super(...args);

      // Schedule first heartbeat if enabled
      // args[0] is the DurableObjectState
      if (this._heartbeatConfig.enabled) {
        void this._scheduleNextHeartbeat(args[0] as DurableObjectState);
      }
    }

    /**
     * Handle alarm events.
     * Sends heartbeat, reschedules next alarm, and calls parent alarm if present.
     */
    async alarm(): Promise<void> {
      const state = (this as unknown as { state: DurableObjectState }).state;
      const env = (this as unknown as { env: HeartbeatEnv }).env;

      if (this._heartbeatConfig.enabled) {
        // Send heartbeat to telemetry queue
        await this._sendHeartbeat(env);

        // Schedule next heartbeat
        await this._scheduleNextHeartbeat(state);
      }

      // Call parent alarm() if it exists
      // Note: In TypeScript, we need to check if the parent class has an alarm method
      const parentAlarm = Object.getPrototypeOf(Object.getPrototypeOf(this)).alarm;
      if (typeof parentAlarm === 'function' && parentAlarm !== this.alarm) {
        await parentAlarm.call(this);
      }
    }

    /**
     * Schedule the next heartbeat alarm.
     */
    protected async _scheduleNextHeartbeat(state: DurableObjectState): Promise<void> {
      try {
        const nextAlarmTime = Date.now() + this._heartbeatConfig.intervalMs;
        await state.storage.setAlarm(nextAlarmTime);
        getLog().debug('Heartbeat scheduled', {
          featureKey: this._heartbeatConfig.featureKey,
          scheduledAt: new Date(nextAlarmTime).toISOString(),
        });
      } catch (error) {
        getLog().error('Failed to schedule heartbeat', error, {
          featureKey: this._heartbeatConfig.featureKey,
        });
      }
    }

    /**
     * Send a heartbeat message to the telemetry queue.
     */
    protected async _sendHeartbeat(env: HeartbeatEnv): Promise<void> {
      if (!env.PLATFORM_TELEMETRY) {
        getLog().warn('No PLATFORM_TELEMETRY queue binding, heartbeat not sent', undefined, {
          featureKey: this._heartbeatConfig.featureKey,
        });
        return;
      }

      const heartbeatMessage: TelemetryMessage = {
        feature_key: this._heartbeatConfig.featureKey,
        project: this._heartbeatConfig.project,
        category: this._heartbeatConfig.category,
        feature: this._heartbeatConfig.feature,
        metrics: {},
        timestamp: Date.now(),
        is_heartbeat: true,
      };

      try {
        await env.PLATFORM_TELEMETRY.send(heartbeatMessage);
        getLog().debug('Heartbeat sent', { featureKey: this._heartbeatConfig.featureKey });
      } catch (error) {
        // Fail open - log error but don't throw
        getLog().error('Failed to send heartbeat', error, {
          featureKey: this._heartbeatConfig.featureKey,
        });
      }
    }

    /**
     * Manually trigger a heartbeat (for testing or on-demand health checks).
     */
    async sendHeartbeatNow(): Promise<void> {
      const env = (this as unknown as { env: HeartbeatEnv }).env;
      await this._sendHeartbeat(env);
    }

    /**
     * Manually reschedule the next heartbeat (for testing or recovery).
     */
    async rescheduleHeartbeat(): Promise<void> {
      const state = (this as unknown as { state: DurableObjectState }).state;
      await this._scheduleNextHeartbeat(state);
    }
  } as TBase;
}
