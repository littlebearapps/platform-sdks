/**
 * Tests for Platform SDK Structured Logging
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateCorrelationId,
  getCorrelationId,
  setCorrelationId,
  categoriseError,
  extractErrorCode,
  createLogger,
  createLoggerFromEnv,
  extractCorrelationIdFromRequest,
  createLoggerFromRequest,
  type LogLevel,
  type ErrorCategory,
} from '@littlebearapps/platform-sdk';
import { CircuitBreakerError } from '@littlebearapps/platform-sdk';

describe('Platform SDK Logging', () => {
  // Capture console output
  let consoleLogs: { method: string; args: unknown[] }[] = [];

  beforeEach(() => {
    consoleLogs = [];
    vi.spyOn(console, 'debug').mockImplementation((...args) => {
      consoleLogs.push({ method: 'debug', args });
    });
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      consoleLogs.push({ method: 'log', args });
    });
    vi.spyOn(console, 'warn').mockImplementation((...args) => {
      consoleLogs.push({ method: 'warn', args });
    });
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      consoleLogs.push({ method: 'error', args });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('generateCorrelationId', () => {
    it('returns a valid UUID', () => {
      const id = generateCorrelationId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it('returns unique IDs on each call', () => {
      const ids = new Set([
        generateCorrelationId(),
        generateCorrelationId(),
        generateCorrelationId(),
      ]);
      expect(ids.size).toBe(3);
    });
  });

  describe('getCorrelationId / setCorrelationId', () => {
    it('creates a new ID for a fresh environment', () => {
      const env = { test: true };
      const id = getCorrelationId(env);
      expect(id).toMatch(/^[0-9a-f]{8}-/i);
    });

    it('returns the same ID for the same environment', () => {
      const env = { test: true };
      const id1 = getCorrelationId(env);
      const id2 = getCorrelationId(env);
      expect(id1).toBe(id2);
    });

    it('returns different IDs for different environments', () => {
      const env1 = { test: 1 };
      const env2 = { test: 2 };
      const id1 = getCorrelationId(env1);
      const id2 = getCorrelationId(env2);
      expect(id1).not.toBe(id2);
    });

    it('allows setting a specific correlation ID', () => {
      const env = { test: true };
      const customId = 'custom-correlation-id-123';
      setCorrelationId(env, customId);
      expect(getCorrelationId(env)).toBe(customId);
    });
  });

  describe('categoriseError', () => {
    it('categorises CircuitBreakerError as CIRCUIT_BREAKER', () => {
      const error = new CircuitBreakerError('test:category:feature', 'feature', 'budget_exceeded');
      expect(categoriseError(error)).toBe('CIRCUIT_BREAKER');
    });

    it('categorises auth errors', () => {
      expect(categoriseError(new Error('Unauthorized access'))).toBe('AUTH');
      expect(categoriseError(new Error('Request returned 401'))).toBe('AUTH');
      expect(categoriseError(new Error('403 Forbidden'))).toBe('AUTH');
    });

    it('categorises rate limit errors', () => {
      expect(categoriseError(new Error('Rate limit exceeded'))).toBe('RATE_LIMIT');
      expect(categoriseError(new Error('Too many requests'))).toBe('RATE_LIMIT');
      expect(categoriseError(new Error('API returned 429'))).toBe('RATE_LIMIT');
    });

    it('categorises network errors', () => {
      expect(categoriseError(new Error('Request timeout'))).toBe('NETWORK');
      expect(categoriseError(new Error('Network error'))).toBe('NETWORK');
      expect(categoriseError(new Error('ECONNREFUSED'))).toBe('NETWORK');
      expect(categoriseError(new Error('Socket hang up'))).toBe('NETWORK');
    });

    it('categorises validation errors', () => {
      expect(categoriseError(new Error('invalid input data'))).toBe('VALIDATION');
      expect(categoriseError(new Error('required field missing'))).toBe('VALIDATION');
      expect(categoriseError(new Error('expected string but got number'))).toBe('VALIDATION');
      // Also test error name pattern
      const validationError = new Error('Check failed');
      validationError.name = 'ValidationError';
      expect(categoriseError(validationError)).toBe('VALIDATION');
    });

    it('categorises D1 errors', () => {
      expect(categoriseError(new Error('D1_ERROR: Query failed'))).toBe('D1_ERROR');
      expect(categoriseError(new Error('SQLITE error'))).toBe('D1_ERROR');
    });

    it('categorises KV errors', () => {
      expect(categoriseError(new Error('KV_ERROR: Key not found'))).toBe('KV_ERROR');
      expect(categoriseError(new Error('Namespace error'))).toBe('KV_ERROR');
    });

    it('categorises queue errors', () => {
      expect(categoriseError(new Error('QUEUE_ERROR: Send failed'))).toBe('QUEUE_ERROR');
    });

    it('categorises external API errors', () => {
      expect(categoriseError(new Error('Server returned 500'))).toBe('EXTERNAL_API');
      expect(categoriseError(new Error('502 Bad Gateway'))).toBe('EXTERNAL_API');
      expect(categoriseError(new Error('Service unavailable 503'))).toBe('EXTERNAL_API');
    });

    it('defaults to INTERNAL for unknown errors', () => {
      expect(categoriseError(new Error('Something went wrong'))).toBe('INTERNAL');
      expect(categoriseError(new Error('Generic failure'))).toBe('INTERNAL');
      expect(categoriseError('string error')).toBe('INTERNAL');
      expect(categoriseError(null)).toBe('INTERNAL');
    });
  });

  describe('extractErrorCode', () => {
    it('extracts code property', () => {
      const error = { code: 'ERR_TIMEOUT' };
      expect(extractErrorCode(error)).toBe('ERR_TIMEOUT');
    });

    it('extracts errno property', () => {
      const error = { errno: 'ECONNREFUSED' };
      expect(extractErrorCode(error)).toBe('ECONNREFUSED');
    });

    it('extracts status as HTTP code', () => {
      const error = { status: 404 };
      expect(extractErrorCode(error)).toBe('HTTP_404');
    });

    it('returns undefined for non-object errors', () => {
      expect(extractErrorCode('string')).toBeUndefined();
      expect(extractErrorCode(null)).toBeUndefined();
      expect(extractErrorCode(undefined)).toBeUndefined();
    });

    it('returns undefined when no code is present', () => {
      expect(extractErrorCode({ message: 'Error' })).toBeUndefined();
    });
  });

  describe('createLogger', () => {
    it('creates a logger with the specified worker name', () => {
      const log = createLogger({ worker: 'test-worker' });

      log.info('Test message');

      expect(consoleLogs).toHaveLength(1);
      const logEntry = JSON.parse(consoleLogs[0].args[0] as string);
      expect(logEntry.worker).toBe('test-worker');
      expect(logEntry.level).toBe('info');
      expect(logEntry.message).toBe('Test message');
    });

    it('includes featureId when provided', () => {
      const log = createLogger({
        worker: 'test-worker',
        featureId: 'platform:connector:stripe',
      });

      log.info('Test message');

      const logEntry = JSON.parse(consoleLogs[0].args[0] as string);
      expect(logEntry.featureId).toBe('platform:connector:stripe');
    });

    it('uses provided correlation ID', () => {
      const customId = 'my-correlation-id';
      const log = createLogger({ worker: 'test-worker', correlationId: customId });

      log.info('Test message');

      const logEntry = JSON.parse(consoleLogs[0].args[0] as string);
      expect(logEntry.correlationId).toBe(customId);
    });

    it('exposes correlationId property', () => {
      const customId = 'my-correlation-id';
      const log = createLogger({ worker: 'test-worker', correlationId: customId });
      expect(log.correlationId).toBe(customId);
    });

    it('includes timestamp in ISO format', () => {
      const log = createLogger({ worker: 'test-worker' });

      log.info('Test message');

      const logEntry = JSON.parse(consoleLogs[0].args[0] as string);
      expect(logEntry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('includes context when provided', () => {
      const log = createLogger({ worker: 'test-worker' });

      log.info('Test message', { customerId: 'cus_123', amount: 100 });

      const logEntry = JSON.parse(consoleLogs[0].args[0] as string);
      expect(logEntry.context).toEqual({ customerId: 'cus_123', amount: 100 });
    });

    describe('log levels', () => {
      it('logs debug messages with console.debug', () => {
        const log = createLogger({ worker: 'test-worker', minLevel: 'debug' });
        log.debug('Debug message');

        expect(consoleLogs).toHaveLength(1);
        expect(consoleLogs[0].method).toBe('debug');
      });

      it('logs info messages with console.log', () => {
        const log = createLogger({ worker: 'test-worker' });
        log.info('Info message');

        expect(consoleLogs).toHaveLength(1);
        expect(consoleLogs[0].method).toBe('log');
      });

      it('logs warn messages with console.warn', () => {
        const log = createLogger({ worker: 'test-worker' });
        log.warn('Warning message');

        expect(consoleLogs).toHaveLength(1);
        expect(consoleLogs[0].method).toBe('warn');
      });

      it('logs error messages with console.error', () => {
        const log = createLogger({ worker: 'test-worker' });
        log.error('Error message');

        expect(consoleLogs).toHaveLength(1);
        expect(consoleLogs[0].method).toBe('error');
      });
    });

    describe('minLevel filtering', () => {
      it('filters out debug when minLevel is info', () => {
        const log = createLogger({ worker: 'test-worker', minLevel: 'info' });

        log.debug('Should be filtered');
        log.info('Should appear');

        expect(consoleLogs).toHaveLength(1);
        const logEntry = JSON.parse(consoleLogs[0].args[0] as string);
        expect(logEntry.message).toBe('Should appear');
      });

      it('filters out info when minLevel is warn', () => {
        const log = createLogger({ worker: 'test-worker', minLevel: 'warn' });

        log.info('Should be filtered');
        log.warn('Should appear');

        expect(consoleLogs).toHaveLength(1);
        const logEntry = JSON.parse(consoleLogs[0].args[0] as string);
        expect(logEntry.message).toBe('Should appear');
      });

      it('only logs errors when minLevel is error', () => {
        const log = createLogger({ worker: 'test-worker', minLevel: 'error' });

        log.info('Filtered');
        log.warn('Filtered');
        log.error('Should appear');

        expect(consoleLogs).toHaveLength(1);
        const logEntry = JSON.parse(consoleLogs[0].args[0] as string);
        expect(logEntry.message).toBe('Should appear');
      });
    });

    describe('error handling', () => {
      it('includes error details for warn', () => {
        const log = createLogger({ worker: 'test-worker' });
        const error = new Error('Something went wrong');

        log.warn('Warning', error);

        const logEntry = JSON.parse(consoleLogs[0].args[0] as string);
        expect(logEntry.error).toBeDefined();
        expect(logEntry.error.name).toBe('Error');
        expect(logEntry.error.message).toBe('Something went wrong');
        expect(logEntry.category).toBe('INTERNAL');
      });

      it('includes stack trace for errors', () => {
        const log = createLogger({ worker: 'test-worker' });
        const error = new Error('Fatal error');

        log.error('Error occurred', error);

        const logEntry = JSON.parse(consoleLogs[0].args[0] as string);
        expect(logEntry.error.stack).toBeDefined();
        expect(logEntry.error.stack).toContain('Error: Fatal error');
      });

      it('categorises errors correctly', () => {
        const log = createLogger({ worker: 'test-worker' });
        const cbError = new CircuitBreakerError(
          'test:category:feature',
          'feature',
          'budget_exceeded'
        );

        log.error('Circuit breaker tripped', cbError);

        const logEntry = JSON.parse(consoleLogs[0].args[0] as string);
        expect(logEntry.category).toBe('CIRCUIT_BREAKER');
      });

      it('handles non-Error objects', () => {
        const log = createLogger({ worker: 'test-worker' });

        log.error('Error occurred', 'string error');

        const logEntry = JSON.parse(consoleLogs[0].args[0] as string);
        expect(logEntry.error.name).toBe('Error');
        expect(logEntry.error.message).toBe('string error');
      });
    });

    describe('timed', () => {
      it('logs duration for successful operations', async () => {
        const log = createLogger({ worker: 'test-worker' });

        const result = await log.timed('fetch_data', async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return 'success';
        });

        expect(result).toBe('success');
        expect(consoleLogs).toHaveLength(1);

        const logEntry = JSON.parse(consoleLogs[0].args[0] as string);
        expect(logEntry.message).toBe('fetch_data completed');
        expect(logEntry.durationMs).toBeGreaterThanOrEqual(10);
      });

      it('logs duration and error for failed operations', async () => {
        const log = createLogger({ worker: 'test-worker' });

        await expect(
          log.timed('fetch_data', async () => {
            throw new Error('Fetch failed');
          })
        ).rejects.toThrow('Fetch failed');

        expect(consoleLogs).toHaveLength(1);

        const logEntry = JSON.parse(consoleLogs[0].args[0] as string);
        expect(logEntry.level).toBe('error');
        expect(logEntry.message).toBe('fetch_data failed');
        expect(logEntry.durationMs).toBeDefined();
        expect(logEntry.error.message).toBe('Fetch failed');
      });

      it('includes context in timed logs', async () => {
        const log = createLogger({ worker: 'test-worker' });

        await log.timed('fetch_data', async () => 'success', { customerId: 'cus_123' });

        const logEntry = JSON.parse(consoleLogs[0].args[0] as string);
        expect(logEntry.context).toEqual({ customerId: 'cus_123' });
      });
    });

    describe('child', () => {
      it('creates a child logger with additional context', () => {
        const log = createLogger({ worker: 'test-worker' });
        const child = log.child({ requestId: 'req_123' });

        child.info('Child message', { extra: 'data' });

        const logEntry = JSON.parse(consoleLogs[0].args[0] as string);
        expect(logEntry.context).toEqual({ requestId: 'req_123', extra: 'data' });
      });

      it('preserves parent correlationId', () => {
        const log = createLogger({ worker: 'test-worker', correlationId: 'parent-id' });
        const child = log.child({ requestId: 'req_123' });

        expect(child.correlationId).toBe('parent-id');
      });

      it('allows nested children', () => {
        const log = createLogger({ worker: 'test-worker' });
        const child1 = log.child({ level1: true });
        const child2 = child1.child({ level2: true });

        child2.info('Nested message');

        const logEntry = JSON.parse(consoleLogs[0].args[0] as string);
        expect(logEntry.context).toEqual({ level1: true, level2: true });
      });
    });

    describe('defaultContext', () => {
      it('includes defaultContext in all logs', () => {
        const log = createLogger({
          worker: 'test-worker',
          defaultContext: { environment: 'production' },
        });

        log.info('Test message');

        const logEntry = JSON.parse(consoleLogs[0].args[0] as string);
        expect(logEntry.context).toEqual({ environment: 'production' });
      });

      it('merges defaultContext with provided context', () => {
        const log = createLogger({
          worker: 'test-worker',
          defaultContext: { environment: 'production' },
        });

        log.info('Test message', { customerId: 'cus_123' });

        const logEntry = JSON.parse(consoleLogs[0].args[0] as string);
        expect(logEntry.context).toEqual({
          environment: 'production',
          customerId: 'cus_123',
        });
      });
    });
  });

  describe('createLoggerFromEnv', () => {
    it('creates a logger with correlation ID from env', () => {
      const env = { test: true };
      const log = createLoggerFromEnv(env, 'test-worker', 'platform:test:feature');

      log.info('Test message');

      const logEntry = JSON.parse(consoleLogs[0].args[0] as string);
      expect(logEntry.worker).toBe('test-worker');
      expect(logEntry.featureId).toBe('platform:test:feature');
      expect(logEntry.correlationId).toBeDefined();
    });

    it('reuses correlation ID for same env', () => {
      const env = { test: true };
      const log1 = createLoggerFromEnv(env, 'worker-1');
      const log2 = createLoggerFromEnv(env, 'worker-2');

      expect(log1.correlationId).toBe(log2.correlationId);
    });

    it('respects minLevel parameter', () => {
      const env = { test: true };
      const log = createLoggerFromEnv(env, 'test-worker', undefined, 'warn');

      log.info('Should be filtered');
      log.warn('Should appear');

      expect(consoleLogs).toHaveLength(1);
      const logEntry = JSON.parse(consoleLogs[0].args[0] as string);
      expect(logEntry.message).toBe('Should appear');
    });
  });

  describe('extractCorrelationIdFromRequest', () => {
    it('extracts x-correlation-id header', () => {
      const request = new Request('https://example.com', {
        headers: { 'x-correlation-id': 'corr-123' },
      });

      expect(extractCorrelationIdFromRequest(request)).toBe('corr-123');
    });

    it('extracts x-request-id header', () => {
      const request = new Request('https://example.com', {
        headers: { 'x-request-id': 'req-456' },
      });

      expect(extractCorrelationIdFromRequest(request)).toBe('req-456');
    });

    it('extracts x-trace-id header', () => {
      const request = new Request('https://example.com', {
        headers: { 'x-trace-id': 'trace-789' },
      });

      expect(extractCorrelationIdFromRequest(request)).toBe('trace-789');
    });

    it('uses cf-ray as fallback', () => {
      const request = new Request('https://example.com', {
        headers: { 'cf-ray': 'cf-ray-abc' },
      });

      expect(extractCorrelationIdFromRequest(request)).toBe('cf-ray-abc');
    });

    it('prefers x-correlation-id over others', () => {
      const request = new Request('https://example.com', {
        headers: {
          'x-correlation-id': 'corr-123',
          'x-request-id': 'req-456',
          'cf-ray': 'cf-ray-abc',
        },
      });

      expect(extractCorrelationIdFromRequest(request)).toBe('corr-123');
    });

    it('returns undefined when no headers present', () => {
      const request = new Request('https://example.com');
      expect(extractCorrelationIdFromRequest(request)).toBeUndefined();
    });
  });

  describe('createLoggerFromRequest', () => {
    it('uses correlation ID from request headers', () => {
      const request = new Request('https://example.com', {
        headers: { 'x-correlation-id': 'from-request' },
      });
      const env = { test: true };

      const log = createLoggerFromRequest(request, env, 'test-worker');

      log.info('Test message');

      const logEntry = JSON.parse(consoleLogs[0].args[0] as string);
      expect(logEntry.correlationId).toBe('from-request');
    });

    it('sets correlation ID on env for downstream use', () => {
      const request = new Request('https://example.com', {
        headers: { 'x-correlation-id': 'from-request' },
      });
      const env = { test: true };

      createLoggerFromRequest(request, env, 'test-worker');

      // Creating another logger from same env should get same ID
      const log2 = createLoggerFromEnv(env, 'another-worker');
      expect(log2.correlationId).toBe('from-request');
    });

    it('generates new ID when no header present', () => {
      const request = new Request('https://example.com');
      const env = { test: true };

      const log = createLoggerFromRequest(request, env, 'test-worker');

      expect(log.correlationId).toMatch(/^[0-9a-f]{8}-/i);
    });
  });
});
