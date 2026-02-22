/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect, vi } from 'vitest';
import {
  createR2Proxy,
  createQueueProxy,
  createWorkflowProxy,
  createDOProxy,
  createEnvProxy,
  isR2Bucket,
  isQueue,
  isWorkflow,
  isDurableObjectNamespace,
} from '@littlebearapps/platform-sdk';
import { createMetricsAccumulator } from '@littlebearapps/platform-sdk';

// =============================================================================
// MOCK FACTORIES
// =============================================================================

function createMockR2Bucket() {
  const mockMultipartUpload = {
    key: 'test-key',
    uploadId: 'upload-123',
    uploadPart: vi.fn().mockResolvedValue({ partNumber: 1, etag: 'etag1' }),
    abort: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue({ key: 'test-key', version: 'v1' }),
  };

  return {
    head: vi.fn().mockResolvedValue({ key: 'test', size: 100 }),
    get: vi.fn().mockResolvedValue({ key: 'test', body: new ReadableStream() }),
    put: vi.fn().mockResolvedValue({ key: 'test', version: 'v1' }),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
    createMultipartUpload: vi.fn().mockResolvedValue(mockMultipartUpload),
    resumeMultipartUpload: vi.fn().mockReturnValue(mockMultipartUpload),
    _mockMultipartUpload: mockMultipartUpload,
  } as unknown as R2Bucket & { _mockMultipartUpload: typeof mockMultipartUpload };
}

function createMockQueue<T = unknown>() {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    sendBatch: vi.fn().mockResolvedValue(undefined),
  } as unknown as Queue<T>;
}

function createMockWorkflow<PARAMS = unknown>() {
  const mockInstance = { id: 'test-instance-id' };
  return {
    get: vi.fn().mockResolvedValue(mockInstance),
    create: vi.fn().mockResolvedValue(mockInstance),
    createBatch: vi.fn().mockResolvedValue([mockInstance]),
  } as unknown as Workflow<PARAMS>;
}

function createMockDurableObjectNamespace() {
  const mockStub = {
    id: { toString: () => 'test-id' },
    fetch: vi.fn().mockResolvedValue(new Response('OK')),
  };
  return {
    idFromName: vi.fn().mockReturnValue({ toString: () => 'id-from-name' }),
    idFromString: vi.fn().mockReturnValue({ toString: () => 'id-from-string' }),
    newUniqueId: vi.fn().mockReturnValue({ toString: () => 'unique-id' }),
    get: vi.fn().mockReturnValue(mockStub),
    _mockStub: mockStub,
  } as unknown as DurableObjectNamespace & { _mockStub: typeof mockStub };
}

// =============================================================================
// TYPE GUARD TESTS
// =============================================================================

describe('Type Guards', () => {
  describe('isR2Bucket', () => {
    it('returns true for R2 bucket', () => {
      expect(isR2Bucket(createMockR2Bucket())).toBe(true);
    });
    it('returns false for Queue', () => {
      expect(isR2Bucket(createMockQueue())).toBe(false);
    });
  });

  describe('isQueue', () => {
    it('returns true for Queue', () => {
      expect(isQueue(createMockQueue())).toBe(true);
    });
    it('returns false for R2 bucket', () => {
      expect(isQueue(createMockR2Bucket())).toBe(false);
    });
  });

  describe('isWorkflow', () => {
    it('returns true for Workflow', () => {
      expect(isWorkflow(createMockWorkflow())).toBe(true);
    });
    it('returns false for DurableObjectNamespace', () => {
      expect(isWorkflow(createMockDurableObjectNamespace())).toBe(false);
    });
  });

  describe('isDurableObjectNamespace', () => {
    it('returns true for DO namespace', () => {
      expect(isDurableObjectNamespace(createMockDurableObjectNamespace())).toBe(true);
    });
    it('returns false for Workflow', () => {
      expect(isDurableObjectNamespace(createMockWorkflow())).toBe(false);
    });
  });
});

// =============================================================================
// R2 PROXY TESTS
// =============================================================================

describe('R2 Proxy', () => {
  it('tracks head() as Class B', async () => {
    const bucket = createMockR2Bucket();
    const metrics = createMetricsAccumulator();
    const proxied = createR2Proxy(bucket, metrics);

    await proxied.head('my-key');

    expect(metrics.r2ClassB).toBe(1);
    expect(metrics.r2ClassA).toBe(0);
  });

  it('tracks get() as Class B without consuming stream', async () => {
    const bucket = createMockR2Bucket();
    const metrics = createMetricsAccumulator();
    const proxied = createR2Proxy(bucket, metrics);

    const result = await proxied.get('my-key');

    expect(metrics.r2ClassB).toBe(1);
    expect(result).not.toBeNull();
  });

  it('tracks put() as Class A', async () => {
    const bucket = createMockR2Bucket();
    const metrics = createMetricsAccumulator();
    const proxied = createR2Proxy(bucket, metrics);

    await proxied.put('my-key', 'content');

    expect(metrics.r2ClassA).toBe(1);
  });

  it('tracks delete() as Class A', async () => {
    const bucket = createMockR2Bucket();
    const metrics = createMetricsAccumulator();
    const proxied = createR2Proxy(bucket, metrics);

    await proxied.delete('my-key');

    expect(metrics.r2ClassA).toBe(1);
  });

  it('tracks list() as Class A', async () => {
    const bucket = createMockR2Bucket();
    const metrics = createMetricsAccumulator();
    const proxied = createR2Proxy(bucket, metrics);

    await proxied.list();

    expect(metrics.r2ClassA).toBe(1);
  });

  it('tracks createMultipartUpload and uploadPart', async () => {
    const bucket = createMockR2Bucket();
    const metrics = createMetricsAccumulator();
    const proxied = createR2Proxy(bucket, metrics);

    const upload = await proxied.createMultipartUpload('large-file');
    await upload.uploadPart(1, 'part-data');

    expect(metrics.r2ClassA).toBe(2);
  });

  it('tracks resumeMultipartUpload and complete', async () => {
    const bucket = createMockR2Bucket();
    const metrics = createMetricsAccumulator();
    const proxied = createR2Proxy(bucket, metrics);

    const upload = proxied.resumeMultipartUpload('large-file', 'upload-id');
    await upload.complete([{ partNumber: 1, etag: 'etag1' }]);

    expect(metrics.r2ClassA).toBe(2);
  });

  it('tracks multipart abort', async () => {
    const bucket = createMockR2Bucket();
    const metrics = createMetricsAccumulator();
    const proxied = createR2Proxy(bucket, metrics);

    const upload = await proxied.createMultipartUpload('large-file');
    await upload.abort();

    expect(metrics.r2ClassA).toBe(2);
  });
});

// =============================================================================
// QUEUE PROXY TESTS
// =============================================================================

describe('Queue Proxy', () => {
  it('tracks send() as 1 message', async () => {
    const queue = createMockQueue();
    const metrics = createMetricsAccumulator();
    const proxied = createQueueProxy(queue, metrics);

    await proxied.send({ data: 'test' });

    expect(metrics.queueMessages).toBe(1);
  });

  it('tracks sendBatch() with message count', async () => {
    const queue = createMockQueue();
    const metrics = createMetricsAccumulator();
    const proxied = createQueueProxy(queue, metrics);

    await proxied.sendBatch([{ body: { id: 1 } }, { body: { id: 2 } }, { body: { id: 3 } }]);

    expect(metrics.queueMessages).toBe(3);
  });

  it('accumulates multiple operations', async () => {
    const queue = createMockQueue();
    const metrics = createMetricsAccumulator();
    const proxied = createQueueProxy(queue, metrics);

    await proxied.send({ data: 'a' });
    await proxied.sendBatch([{ body: 'b' }, { body: 'c' }]);

    expect(metrics.queueMessages).toBe(3);
  });
});

// =============================================================================
// WORKFLOW PROXY TESTS
// =============================================================================

describe('Workflow Proxy', () => {
  it('tracks create() as 1 invocation', async () => {
    const workflow = createMockWorkflow();
    const metrics = createMetricsAccumulator();
    const proxied = createWorkflowProxy(workflow, metrics);

    await proxied.create({ id: 'test-1' });

    expect(metrics.workflowInvocations).toBe(1);
  });

  it('tracks createBatch() with batch count', async () => {
    const workflow = createMockWorkflow();
    const metrics = createMetricsAccumulator();
    const proxied = createWorkflowProxy(workflow, metrics);

    await proxied.createBatch([{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }]);

    expect(metrics.workflowInvocations).toBe(3);
  });

  it('does not track get() (read-only)', async () => {
    const workflow = createMockWorkflow();
    const metrics = createMetricsAccumulator();
    const proxied = createWorkflowProxy(workflow, metrics);

    await proxied.get('existing-instance');

    expect(metrics.workflowInvocations).toBe(0);
  });
});

// =============================================================================
// DURABLE OBJECTS PROXY TESTS
// =============================================================================

describe('Durable Objects Proxy', () => {
  it('tracks stub.fetch() as doRequest', async () => {
    const ns = createMockDurableObjectNamespace();
    const metrics = createMetricsAccumulator();
    const proxied = createDOProxy(ns, metrics);

    const id = proxied.idFromName('my-do');
    const stub = proxied.get(id);
    await stub.fetch('https://do/endpoint');

    expect(metrics.doRequests).toBe(1);
  });

  it('does not track idFromName/idFromString', () => {
    const ns = createMockDurableObjectNamespace();
    const metrics = createMetricsAccumulator();
    const proxied = createDOProxy(ns, metrics);

    proxied.idFromName('test');
    proxied.idFromString('abc123');

    expect(metrics.doRequests).toBe(0);
  });

  it('accumulates multiple fetch calls', async () => {
    const ns = createMockDurableObjectNamespace();
    const metrics = createMetricsAccumulator();
    const proxied = createDOProxy(ns, metrics);

    const stub = proxied.get(proxied.idFromName('test'));
    await stub.fetch('/a');
    await stub.fetch('/b');
    await stub.fetch('/c');

    expect(metrics.doRequests).toBe(3);
  });
});

// =============================================================================
// ENVIRONMENT PROXY INTEGRATION TESTS
// =============================================================================

describe('Environment Proxy Integration', () => {
  it('wraps R2 bucket automatically', async () => {
    const env = { BUCKET: createMockR2Bucket() };
    const metrics = createMetricsAccumulator();
    const proxied = createEnvProxy(env, metrics);

    await proxied.BUCKET.put('key', 'value');

    expect(metrics.r2ClassA).toBe(1);
  });

  it('wraps Queue automatically', async () => {
    const env = { MY_QUEUE: createMockQueue() };
    const metrics = createMetricsAccumulator();
    const proxied = createEnvProxy(env, metrics);

    await proxied.MY_QUEUE.send({ data: 'test' });

    expect(metrics.queueMessages).toBe(1);
  });

  it('wraps Workflow automatically', async () => {
    const env = { MY_WORKFLOW: createMockWorkflow() };
    const metrics = createMetricsAccumulator();
    const proxied = createEnvProxy(env, metrics);

    await proxied.MY_WORKFLOW.create({ id: 'test' });

    expect(metrics.workflowInvocations).toBe(1);
  });

  it('wraps DurableObjectNamespace automatically', async () => {
    const env = { MY_DO: createMockDurableObjectNamespace() };
    const metrics = createMetricsAccumulator();
    const proxied = createEnvProxy(env, metrics);

    const stub = proxied.MY_DO.get(proxied.MY_DO.idFromName('test'));
    await stub.fetch('/endpoint');

    expect(metrics.doRequests).toBe(1);
  });

  it('does not wrap PLATFORM_TELEMETRY queue', async () => {
    const queue = createMockQueue();
    const env = { PLATFORM_TELEMETRY: queue };
    const metrics = createMetricsAccumulator();
    const proxied = createEnvProxy(env, metrics);

    // Access should return the original queue, not a proxy
    await proxied.PLATFORM_TELEMETRY.send({ data: 'test' });

    // Since it's not wrapped, metrics should not be tracked
    expect(metrics.queueMessages).toBe(0);
  });
});
