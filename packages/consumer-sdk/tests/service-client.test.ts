import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createServiceClient,
  createServiceBindingHeaders,
  wrapServiceBinding,
  extractCorrelationChain,
  CORRELATION_ID_HEADER,
  SOURCE_SERVICE_HEADER,
  TARGET_SERVICE_HEADER,
  FEATURE_ID_HEADER,
} from '../src/service-client';

// Mock dependencies
vi.mock('../src/logging', () => ({
  getCorrelationId: vi.fn(() => 'mock-correlation-id-123'),
}));

vi.mock('../src/tracing', () => ({
  getTraceContext: vi.fn(() => ({
    traceId: 'abcdef1234567890abcdef1234567890',
    spanId: '1234567890abcdef',
    traceFlags: 1,
    version: '00',
  })),
  propagateTraceContext: vi.fn((ctx) => {
    const headers = new Headers();
    headers.set('traceparent', `00-${ctx.traceId}-fedcba0987654321-01`);
    return headers;
  }),
}));

describe('service-client', () => {
  // =========================================================================
  // HEADER CONSTANTS
  // =========================================================================

  describe('header constants', () => {
    it('exports CORRELATION_ID_HEADER', () => {
      expect(CORRELATION_ID_HEADER).toBe('x-correlation-id');
    });

    it('exports SOURCE_SERVICE_HEADER', () => {
      expect(SOURCE_SERVICE_HEADER).toBe('x-source-service');
    });

    it('exports TARGET_SERVICE_HEADER', () => {
      expect(TARGET_SERVICE_HEADER).toBe('x-target-service');
    });

    it('exports FEATURE_ID_HEADER', () => {
      expect(FEATURE_ID_HEADER).toBe('x-feature-id');
    });
  });

  // =========================================================================
  // createServiceClient
  // =========================================================================

  describe('createServiceClient', () => {
    let originalFetch: typeof globalThis.fetch;
    let mockFetch: ReturnType<typeof vi.fn>;
    const mockEnv = {};

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      mockFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
      globalThis.fetch = mockFetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('returns a ServiceClient with correlationId getter', () => {
      const client = createServiceClient(mockEnv, 'test-service');
      expect(client.correlationId).toBe('mock-correlation-id-123');
    });

    it('returns a ServiceClient with traceId getter', () => {
      const client = createServiceClient(mockEnv, 'test-service');
      expect(client.traceId).toBe('abcdef1234567890abcdef1234567890');
    });

    it('propagates correlation ID header on fetch', async () => {
      const client = createServiceClient(mockEnv, 'test-service');
      await client.fetch('https://example.com/api');

      const [, init] = mockFetch.mock.calls[0];
      const headers = new Headers(init.headers);
      expect(headers.get(CORRELATION_ID_HEADER)).toBe('mock-correlation-id-123');
    });

    it('propagates source service header on fetch', async () => {
      const client = createServiceClient(mockEnv, 'my-worker');
      await client.fetch('https://example.com/api');

      const [, init] = mockFetch.mock.calls[0];
      const headers = new Headers(init.headers);
      expect(headers.get(SOURCE_SERVICE_HEADER)).toBe('my-worker');
    });

    it('propagates target service header when specified', async () => {
      const client = createServiceClient(mockEnv, 'my-worker', {
        targetService: 'alert-router',
      });
      await client.fetch('https://example.com/api');

      const [, init] = mockFetch.mock.calls[0];
      const headers = new Headers(init.headers);
      expect(headers.get(TARGET_SERVICE_HEADER)).toBe('alert-router');
    });

    it('does not set target service header when not specified', async () => {
      const client = createServiceClient(mockEnv, 'my-worker');
      await client.fetch('https://example.com/api');

      const [, init] = mockFetch.mock.calls[0];
      const headers = new Headers(init.headers);
      expect(headers.get(TARGET_SERVICE_HEADER)).toBeNull();
    });

    it('propagates trace context headers on fetch', async () => {
      const client = createServiceClient(mockEnv, 'my-worker');
      await client.fetch('https://example.com/api');

      const [, init] = mockFetch.mock.calls[0];
      const headers = new Headers(init.headers);
      expect(headers.get('traceparent')).toContain('abcdef1234567890abcdef1234567890');
    });

    it('applies default headers', async () => {
      const client = createServiceClient(mockEnv, 'my-worker', {
        defaultHeaders: { 'x-custom': 'value123' },
      });
      await client.fetch('https://example.com/api');

      const [, init] = mockFetch.mock.calls[0];
      const headers = new Headers(init.headers);
      expect(headers.get('x-custom')).toBe('value123');
    });

    it('does not overwrite existing headers with defaults', async () => {
      const client = createServiceClient(mockEnv, 'my-worker', {
        defaultHeaders: { 'content-type': 'text/plain' },
      });
      await client.fetch('https://example.com/api', {
        headers: { 'content-type': 'application/json' },
      });

      const [, init] = mockFetch.mock.calls[0];
      const headers = new Headers(init.headers);
      expect(headers.get('content-type')).toBe('application/json');
    });

    it('preserves init options like method and body', async () => {
      const client = createServiceClient(mockEnv, 'my-worker');
      await client.fetch('https://example.com/api', {
        method: 'POST',
        body: '{"key":"value"}',
      });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://example.com/api');
      expect(init.method).toBe('POST');
      expect(init.body).toBe('{"key":"value"}');
    });

    it('applies timeout via AbortController', async () => {
      const client = createServiceClient(mockEnv, 'my-worker', {
        timeoutMs: 5000,
      });

      await client.fetch('https://example.com/api');

      const [, init] = mockFetch.mock.calls[0];
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('calls fetch without signal when no timeout', async () => {
      const client = createServiceClient(mockEnv, 'my-worker');
      await client.fetch('https://example.com/api');

      const [, init] = mockFetch.mock.calls[0];
      expect(init.signal).toBeUndefined();
    });

    it('returns the Response from fetch', async () => {
      const expected = new Response('test-body', { status: 201 });
      mockFetch.mockResolvedValueOnce(expected);

      const client = createServiceClient(mockEnv, 'my-worker');
      const response = await client.fetch('https://example.com/api');

      expect(response).toBe(expected);
    });
  });

  // =========================================================================
  // createServiceBindingHeaders
  // =========================================================================

  describe('createServiceBindingHeaders', () => {
    const mockEnv = {};

    it('returns a Headers object', () => {
      const headers = createServiceBindingHeaders(mockEnv, 'test-service');
      expect(headers).toBeInstanceOf(Headers);
    });

    it('includes correlation ID header', () => {
      const headers = createServiceBindingHeaders(mockEnv, 'test-service');
      expect(headers.get(CORRELATION_ID_HEADER)).toBe('mock-correlation-id-123');
    });

    it('includes source service header', () => {
      const headers = createServiceBindingHeaders(mockEnv, 'platform-usage');
      expect(headers.get(SOURCE_SERVICE_HEADER)).toBe('platform-usage');
    });

    it('includes traceparent header from trace context', () => {
      const headers = createServiceBindingHeaders(mockEnv, 'test-service');
      expect(headers.get('traceparent')).toContain('abcdef1234567890abcdef1234567890');
    });
  });

  // =========================================================================
  // wrapServiceBinding
  // =========================================================================

  describe('wrapServiceBinding', () => {
    const mockEnv = {};
    let mockFetcher: Fetcher;
    let mockFetcherFetch: ReturnType<typeof vi.fn>;
    let mockConnect: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockFetcherFetch = vi.fn().mockResolvedValue(new Response('ok'));
      mockConnect = vi.fn();
      mockFetcher = {
        fetch: mockFetcherFetch,
        connect: mockConnect,
      } as unknown as Fetcher;
    });

    it('returns an object with fetch and connect', () => {
      const wrapped = wrapServiceBinding(mockFetcher, mockEnv, 'my-worker');
      expect(typeof wrapped.fetch).toBe('function');
      expect(wrapped.connect).toBe(mockConnect);
    });

    it('preserves the original connect method', () => {
      const wrapped = wrapServiceBinding(mockFetcher, mockEnv, 'my-worker');
      expect(wrapped.connect).toBe(mockFetcher.connect);
    });

    it('adds correlation headers to fetch calls', async () => {
      const wrapped = wrapServiceBinding(mockFetcher, mockEnv, 'my-worker');
      await wrapped.fetch('https://example.com/api');

      const [, init] = mockFetcherFetch.mock.calls[0];
      const headers = new Headers(init.headers);
      expect(headers.get(CORRELATION_ID_HEADER)).toBe('mock-correlation-id-123');
      expect(headers.get(SOURCE_SERVICE_HEADER)).toBe('my-worker');
    });

    it('adds trace context to fetch calls', async () => {
      const wrapped = wrapServiceBinding(mockFetcher, mockEnv, 'my-worker');
      await wrapped.fetch('https://example.com/api');

      const [, init] = mockFetcherFetch.mock.calls[0];
      const headers = new Headers(init.headers);
      expect(headers.get('traceparent')).toBeTruthy();
    });

    it('preserves existing init headers alongside context headers', async () => {
      const wrapped = wrapServiceBinding(mockFetcher, mockEnv, 'my-worker');
      await wrapped.fetch('https://example.com/api', {
        headers: { 'content-type': 'application/json' },
      });

      const [, init] = mockFetcherFetch.mock.calls[0];
      const headers = new Headers(init.headers);
      // Context headers overwrite, but content-type should still be present
      // Actually, createServiceBindingHeaders uses .set() which overwrites same keys
      // but content-type is not a context header so it should persist
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.get(CORRELATION_ID_HEADER)).toBe('mock-correlation-id-123');
    });

    it('passes through init options to underlying fetcher', async () => {
      const wrapped = wrapServiceBinding(mockFetcher, mockEnv, 'my-worker');
      await wrapped.fetch('https://example.com/api', {
        method: 'PUT',
        body: 'data',
      });

      const [url, init] = mockFetcherFetch.mock.calls[0];
      expect(url).toBe('https://example.com/api');
      expect(init.method).toBe('PUT');
      expect(init.body).toBe('data');
    });

    it('delegates to the original fetcher.fetch', async () => {
      const expectedResponse = new Response('result', { status: 201 });
      mockFetcherFetch.mockResolvedValueOnce(expectedResponse);

      const wrapped = wrapServiceBinding(mockFetcher, mockEnv, 'my-worker');
      const response = await wrapped.fetch('https://example.com/api');

      expect(response).toBe(expectedResponse);
      expect(mockFetcherFetch).toHaveBeenCalledOnce();
    });
  });

  // =========================================================================
  // extractCorrelationChain
  // =========================================================================

  describe('extractCorrelationChain', () => {
    function makeRequest(headers: Record<string, string> = {}): Request {
      return new Request('https://example.com', { headers });
    }

    it('extracts correlation ID from x-correlation-id header', () => {
      const request = makeRequest({ 'x-correlation-id': 'my-corr-id' });
      const chain = extractCorrelationChain(request);
      expect(chain.correlationId).toBe('my-corr-id');
    });

    it('falls back to x-request-id header', () => {
      const request = makeRequest({ 'x-request-id': 'req-id-456' });
      const chain = extractCorrelationChain(request);
      expect(chain.correlationId).toBe('req-id-456');
    });

    it('generates a UUID when no correlation headers present', () => {
      const request = makeRequest();
      const chain = extractCorrelationChain(request);
      // crypto.randomUUID() returns a UUID v4 format
      expect(chain.correlationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    it('prefers x-correlation-id over x-request-id', () => {
      const request = makeRequest({
        'x-correlation-id': 'corr-id',
        'x-request-id': 'req-id',
      });
      const chain = extractCorrelationChain(request);
      expect(chain.correlationId).toBe('corr-id');
    });

    it('extracts source service', () => {
      const request = makeRequest({ 'x-source-service': 'platform-usage' });
      const chain = extractCorrelationChain(request);
      expect(chain.sourceService).toBe('platform-usage');
    });

    it('returns undefined sourceService when header missing', () => {
      const request = makeRequest();
      const chain = extractCorrelationChain(request);
      expect(chain.sourceService).toBeUndefined();
    });

    it('extracts target service', () => {
      const request = makeRequest({ 'x-target-service': 'alert-router' });
      const chain = extractCorrelationChain(request);
      expect(chain.targetService).toBe('alert-router');
    });

    it('returns undefined targetService when header missing', () => {
      const request = makeRequest();
      const chain = extractCorrelationChain(request);
      expect(chain.targetService).toBeUndefined();
    });

    it('extracts feature ID', () => {
      const request = makeRequest({ 'x-feature-id': 'scout:api:main' });
      const chain = extractCorrelationChain(request);
      expect(chain.featureId).toBe('scout:api:main');
    });

    it('returns undefined featureId when header missing', () => {
      const request = makeRequest();
      const chain = extractCorrelationChain(request);
      expect(chain.featureId).toBeUndefined();
    });

    it('extracts traceId from traceparent header', () => {
      const request = makeRequest({
        traceparent: '00-abcdef1234567890abcdef1234567890-1234567890abcdef-01',
      });
      const chain = extractCorrelationChain(request);
      expect(chain.traceId).toBe('abcdef1234567890abcdef1234567890');
    });

    it('extracts spanId from traceparent header', () => {
      const request = makeRequest({
        traceparent: '00-abcdef1234567890abcdef1234567890-1234567890abcdef-01',
      });
      const chain = extractCorrelationChain(request);
      expect(chain.spanId).toBe('1234567890abcdef');
    });

    it('returns undefined traceId when no traceparent', () => {
      const request = makeRequest();
      const chain = extractCorrelationChain(request);
      expect(chain.traceId).toBeUndefined();
    });

    it('returns undefined spanId when no traceparent', () => {
      const request = makeRequest();
      const chain = extractCorrelationChain(request);
      expect(chain.spanId).toBeUndefined();
    });

    it('handles traceparent with only version and traceId', () => {
      const request = makeRequest({ traceparent: '00-abcdef1234567890abcdef1234567890' });
      const chain = extractCorrelationChain(request);
      expect(chain.traceId).toBe('abcdef1234567890abcdef1234567890');
      expect(chain.spanId).toBeUndefined();
    });

    it('extracts all fields from a fully populated request', () => {
      const request = makeRequest({
        'x-correlation-id': 'corr-123',
        'x-source-service': 'worker-a',
        'x-target-service': 'worker-b',
        'x-feature-id': 'app:api:main',
        traceparent: '00-aaaa1111bbbb2222cccc3333dddd4444-eeee5555ffff6666-01',
      });
      const chain = extractCorrelationChain(request);
      expect(chain).toEqual({
        correlationId: 'corr-123',
        sourceService: 'worker-a',
        targetService: 'worker-b',
        featureId: 'app:api:main',
        traceId: 'aaaa1111bbbb2222cccc3333dddd4444',
        spanId: 'eeee5555ffff6666',
      });
    });
  });
});
