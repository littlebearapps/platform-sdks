/**
 * DO Heartbeat Mixin Tests
 *
 * Tests for the withHeartbeat mixin that adds alarm-based health monitoring
 * to Durable Objects.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  withHeartbeat,
  type HeartbeatConfig,
  type HeartbeatEnv,
} from '@littlebearapps/platform-sdk';

// =============================================================================
// MOCK TYPES
// =============================================================================

interface MockDurableObjectState {
  storage: {
    setAlarm: ReturnType<typeof vi.fn>;
    getAlarm: ReturnType<typeof vi.fn>;
    deleteAlarm: ReturnType<typeof vi.fn>;
  };
  id: { toString: () => string };
}

interface MockQueue {
  send: ReturnType<typeof vi.fn>;
  sendBatch: ReturnType<typeof vi.fn>;
}

// =============================================================================
// BASE DURABLE OBJECT CLASS
// =============================================================================

/**
 * Mock DurableObject base class for testing.
 * Mimics the Cloudflare DurableObject class structure.
 */
class MockDurableObject {
  protected state: MockDurableObjectState;
  protected env: HeartbeatEnv;

  constructor(state: MockDurableObjectState, env: HeartbeatEnv) {
    this.state = state;
    this.env = env;
  }

  async fetch(_request: Request): Promise<Response> {
    return new Response('OK');
  }
}

/**
 * Mock DurableObject with its own alarm() method.
 */
class MockDurableObjectWithAlarm extends MockDurableObject {
  alarmCalled = false;

  async alarm(): Promise<void> {
    this.alarmCalled = true;
  }
}

// =============================================================================
// HELPERS
// =============================================================================

function createMockState(): MockDurableObjectState {
  return {
    storage: {
      setAlarm: vi.fn().mockResolvedValue(undefined),
      getAlarm: vi.fn().mockResolvedValue(null),
      deleteAlarm: vi.fn().mockResolvedValue(undefined),
    },
    id: { toString: () => 'test-do-id' },
  };
}

function createMockEnv(): HeartbeatEnv & { PLATFORM_TELEMETRY: MockQueue } {
  return {
    PLATFORM_TELEMETRY: {
      send: vi.fn().mockResolvedValue(undefined),
      sendBatch: vi.fn().mockResolvedValue(undefined),
    },
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('DO Heartbeat Mixin', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-24T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('withHeartbeat', () => {
    it('validates feature key format', () => {
      const invalidConfig: HeartbeatConfig = {
        featureKey: 'invalid-key', // Missing colons
      };

      expect(() => {
        withHeartbeat(
          MockDurableObject as unknown as new (
            state: DurableObjectState,
            env: unknown
          ) => DurableObject,
          invalidConfig
        );
      }).toThrow('Invalid featureKey format');
    });

    it('accepts valid feature key format', () => {
      const validConfig: HeartbeatConfig = {
        featureKey: 'scout:do:triage-workflow',
      };

      expect(() => {
        withHeartbeat(
          MockDurableObject as unknown as new (
            state: DurableObjectState,
            env: unknown
          ) => DurableObject,
          validConfig
        );
      }).not.toThrow();
    });
  });

  describe('alarm scheduling', () => {
    it('schedules first heartbeat on construction', () => {
      const config: HeartbeatConfig = {
        featureKey: 'scout:do:triage-workflow',
        intervalMs: 5 * 60 * 1000, // 5 minutes
      };

      const HeartbeatDO = withHeartbeat(
        MockDurableObject as unknown as new (
          state: DurableObjectState,
          env: unknown
        ) => DurableObject,
        config
      );

      const mockState = createMockState();
      const mockEnv = createMockEnv();

      new HeartbeatDO(mockState as unknown as DurableObjectState, mockEnv);

      // Allow microtask to complete
      expect(mockState.storage.setAlarm).toHaveBeenCalledTimes(1);

      // Check the alarm is scheduled for 5 minutes from now
      const expectedTime = Date.now() + 5 * 60 * 1000;
      expect(mockState.storage.setAlarm).toHaveBeenCalledWith(expectedTime);
    });

    it('uses default interval when not specified', () => {
      const config: HeartbeatConfig = {
        featureKey: 'scout:do:triage-workflow',
        // intervalMs not specified, should default to 5 minutes
      };

      const HeartbeatDO = withHeartbeat(
        MockDurableObject as unknown as new (
          state: DurableObjectState,
          env: unknown
        ) => DurableObject,
        config
      );

      const mockState = createMockState();
      const mockEnv = createMockEnv();

      new HeartbeatDO(mockState as unknown as DurableObjectState, mockEnv);

      const expectedTime = Date.now() + 5 * 60 * 1000;
      expect(mockState.storage.setAlarm).toHaveBeenCalledWith(expectedTime);
    });

    it('does not schedule heartbeat when disabled', () => {
      const config: HeartbeatConfig = {
        featureKey: 'scout:do:triage-workflow',
        enabled: false,
      };

      const HeartbeatDO = withHeartbeat(
        MockDurableObject as unknown as new (
          state: DurableObjectState,
          env: unknown
        ) => DurableObject,
        config
      );

      const mockState = createMockState();
      const mockEnv = createMockEnv();

      new HeartbeatDO(mockState as unknown as DurableObjectState, mockEnv);

      expect(mockState.storage.setAlarm).not.toHaveBeenCalled();
    });
  });

  describe('alarm() handler', () => {
    it('sends heartbeat message with is_heartbeat: true', async () => {
      const config: HeartbeatConfig = {
        featureKey: 'scout:do:triage-workflow',
        intervalMs: 5 * 60 * 1000,
      };

      const HeartbeatDO = withHeartbeat(
        MockDurableObject as unknown as new (
          state: DurableObjectState,
          env: unknown
        ) => DurableObject,
        config
      );

      const mockState = createMockState();
      const mockEnv = createMockEnv();

      const instance = new HeartbeatDO(mockState as unknown as DurableObjectState, mockEnv);

      // Reset the mock after construction (which triggers initial schedule)
      mockState.storage.setAlarm.mockClear();
      mockEnv.PLATFORM_TELEMETRY.send.mockClear();

      // Trigger alarm
      await (instance as unknown as { alarm: () => Promise<void> }).alarm();

      // Check heartbeat was sent
      expect(mockEnv.PLATFORM_TELEMETRY.send).toHaveBeenCalledTimes(1);
      const sentMessage = mockEnv.PLATFORM_TELEMETRY.send.mock.calls[0][0];
      expect(sentMessage).toMatchObject({
        feature_key: 'scout:do:triage-workflow',
        project: 'scout',
        category: 'do',
        feature: 'triage-workflow',
        is_heartbeat: true,
        metrics: {},
      });
      expect(sentMessage.timestamp).toBe(Date.now());

      // Check next alarm was scheduled
      expect(mockState.storage.setAlarm).toHaveBeenCalledTimes(1);
    });

    it('reschedules next heartbeat after alarm', async () => {
      const config: HeartbeatConfig = {
        featureKey: 'scout:do:triage-workflow',
        intervalMs: 10 * 60 * 1000, // 10 minutes
      };

      const HeartbeatDO = withHeartbeat(
        MockDurableObject as unknown as new (
          state: DurableObjectState,
          env: unknown
        ) => DurableObject,
        config
      );

      const mockState = createMockState();
      const mockEnv = createMockEnv();

      const instance = new HeartbeatDO(mockState as unknown as DurableObjectState, mockEnv);

      // Reset and advance time
      mockState.storage.setAlarm.mockClear();
      vi.advanceTimersByTime(10 * 60 * 1000); // Advance 10 minutes

      // Trigger alarm
      await (instance as unknown as { alarm: () => Promise<void> }).alarm();

      // Check next alarm is scheduled for 10 minutes from now
      const expectedTime = Date.now() + 10 * 60 * 1000;
      expect(mockState.storage.setAlarm).toHaveBeenCalledWith(expectedTime);
    });

    it('does not send heartbeat when disabled', async () => {
      const config: HeartbeatConfig = {
        featureKey: 'scout:do:triage-workflow',
        enabled: false,
      };

      const HeartbeatDO = withHeartbeat(
        MockDurableObject as unknown as new (
          state: DurableObjectState,
          env: unknown
        ) => DurableObject,
        config
      );

      const mockState = createMockState();
      const mockEnv = createMockEnv();

      const instance = new HeartbeatDO(mockState as unknown as DurableObjectState, mockEnv);

      // Trigger alarm
      await (instance as unknown as { alarm: () => Promise<void> }).alarm();

      // Check no heartbeat was sent and no alarm scheduled
      expect(mockEnv.PLATFORM_TELEMETRY.send).not.toHaveBeenCalled();
      expect(mockState.storage.setAlarm).not.toHaveBeenCalled();
    });

    it('calls parent alarm() method if it exists', async () => {
      const config: HeartbeatConfig = {
        featureKey: 'scout:do:triage-workflow',
      };

      const HeartbeatDO = withHeartbeat(
        MockDurableObjectWithAlarm as unknown as new (
          state: DurableObjectState,
          env: unknown
        ) => DurableObject,
        config
      );

      const mockState = createMockState();
      const mockEnv = createMockEnv();

      const instance = new HeartbeatDO(mockState as unknown as DurableObjectState, mockEnv);

      // Trigger alarm
      await (instance as unknown as { alarm: () => Promise<void> }).alarm();

      // Check parent alarm was called
      expect((instance as unknown as MockDurableObjectWithAlarm).alarmCalled).toBe(true);
    });
  });

  describe('error handling', () => {
    it('fails open when queue send fails', async () => {
      const config: HeartbeatConfig = {
        featureKey: 'scout:do:triage-workflow',
      };

      const HeartbeatDO = withHeartbeat(
        MockDurableObject as unknown as new (
          state: DurableObjectState,
          env: unknown
        ) => DurableObject,
        config
      );

      const mockState = createMockState();
      const mockEnv = createMockEnv();
      mockEnv.PLATFORM_TELEMETRY.send.mockRejectedValue(new Error('Queue unavailable'));

      const instance = new HeartbeatDO(mockState as unknown as DurableObjectState, mockEnv);

      // Reset after construction
      mockState.storage.setAlarm.mockClear();

      // Should not throw
      await expect(
        (instance as unknown as { alarm: () => Promise<void> }).alarm()
      ).resolves.not.toThrow();

      // Should still reschedule next alarm
      expect(mockState.storage.setAlarm).toHaveBeenCalledTimes(1);
    });

    it('logs warning when no queue binding', async () => {
      const config: HeartbeatConfig = {
        featureKey: 'scout:do:triage-workflow',
      };

      const HeartbeatDO = withHeartbeat(
        MockDurableObject as unknown as new (
          state: DurableObjectState,
          env: unknown
        ) => DurableObject,
        config
      );

      const mockState = createMockState();
      const mockEnv = { PLATFORM_TELEMETRY: undefined } as unknown as HeartbeatEnv;

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const instance = new HeartbeatDO(mockState as unknown as DurableObjectState, mockEnv);

      // Reset after construction
      mockState.storage.setAlarm.mockClear();

      // Should not throw
      await expect(
        (instance as unknown as { alarm: () => Promise<void> }).alarm()
      ).resolves.not.toThrow();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('No PLATFORM_TELEMETRY queue binding')
      );

      consoleSpy.mockRestore();
    });
  });

  describe('manual methods', () => {
    it('sendHeartbeatNow() sends heartbeat immediately', async () => {
      const config: HeartbeatConfig = {
        featureKey: 'scout:do:triage-workflow',
      };

      const HeartbeatDO = withHeartbeat(
        MockDurableObject as unknown as new (
          state: DurableObjectState,
          env: unknown
        ) => DurableObject,
        config
      );

      const mockState = createMockState();
      const mockEnv = createMockEnv();

      const instance = new HeartbeatDO(mockState as unknown as DurableObjectState, mockEnv);

      // Reset after construction
      mockEnv.PLATFORM_TELEMETRY.send.mockClear();

      // Call manual method
      await (instance as unknown as { sendHeartbeatNow: () => Promise<void> }).sendHeartbeatNow();

      expect(mockEnv.PLATFORM_TELEMETRY.send).toHaveBeenCalledTimes(1);
      const sentMessage = mockEnv.PLATFORM_TELEMETRY.send.mock.calls[0][0];
      expect(sentMessage.is_heartbeat).toBe(true);
    });

    it('rescheduleHeartbeat() schedules new alarm', async () => {
      const config: HeartbeatConfig = {
        featureKey: 'scout:do:triage-workflow',
        intervalMs: 5 * 60 * 1000,
      };

      const HeartbeatDO = withHeartbeat(
        MockDurableObject as unknown as new (
          state: DurableObjectState,
          env: unknown
        ) => DurableObject,
        config
      );

      const mockState = createMockState();
      const mockEnv = createMockEnv();

      const instance = new HeartbeatDO(mockState as unknown as DurableObjectState, mockEnv);

      // Reset and advance time
      mockState.storage.setAlarm.mockClear();
      vi.advanceTimersByTime(2 * 60 * 1000); // Advance 2 minutes

      // Call manual method
      await (
        instance as unknown as { rescheduleHeartbeat: () => Promise<void> }
      ).rescheduleHeartbeat();

      const expectedTime = Date.now() + 5 * 60 * 1000;
      expect(mockState.storage.setAlarm).toHaveBeenCalledWith(expectedTime);
    });
  });
});
