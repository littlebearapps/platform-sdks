/// <reference types="@cloudflare/workers-types" />

/**
 * Platform SDK Proxy
 *
 * Proxy handlers for automatic metric collection on Cloudflare bindings.
 * Supports D1, KV, AI, and Vectorize with lazy/JIT circuit breaker checks.
 */

import type { MetricsAccumulator } from './types';
import { getTelemetryContext } from './telemetry';

// =============================================================================
// TYPE GUARDS
// =============================================================================

/**
 * Type guard to check if a value is a D1 database.
 */
export function isD1Database(value: unknown): value is D1Database {
  return (
    value !== null &&
    typeof value === 'object' &&
    'prepare' in value &&
    'batch' in value &&
    'exec' in value
  );
}

/**
 * Type guard to check if a value is a KV namespace.
 */
export function isKVNamespace(value: unknown): value is KVNamespace {
  return (
    value !== null &&
    typeof value === 'object' &&
    'get' in value &&
    'put' in value &&
    'delete' in value &&
    'list' in value &&
    !('prepare' in value) && // Distinguish from D1
    !('head' in value) // Distinguish from R2
  );
}

/**
 * Type guard to check if a value is a Workers AI binding.
 * AI bindings have a 'run' method.
 */
export function isAIBinding(value: unknown): value is Ai {
  return (
    value !== null &&
    typeof value === 'object' &&
    'run' in value &&
    typeof (value as { run: unknown }).run === 'function'
  );
}

/**
 * Type guard to check if a value is a Vectorize index.
 * Vectorize has query, insert, upsert, deleteByIds methods.
 */
export function isVectorizeIndex(value: unknown): value is VectorizeIndex {
  return (
    value !== null &&
    typeof value === 'object' &&
    'query' in value &&
    'insert' in value &&
    'upsert' in value &&
    'deleteByIds' in value
  );
}

/**
 * Type guard to check if a value is a Queue.
 */
export function isQueue(value: unknown): value is Queue {
  return value !== null && typeof value === 'object' && 'send' in value && 'sendBatch' in value;
}

/**
 * Type guard to check if a value is a Durable Object namespace.
 */
export function isDurableObjectNamespace(value: unknown): value is DurableObjectNamespace {
  return (
    value !== null &&
    typeof value === 'object' &&
    'get' in value &&
    'idFromName' in value &&
    'idFromString' in value
  );
}

/**
 * Type guard to check if a value is an R2 bucket.
 */
export function isR2Bucket(value: unknown): value is R2Bucket {
  return (
    value !== null &&
    typeof value === 'object' &&
    'put' in value &&
    'get' in value &&
    'head' in value &&
    'list' in value &&
    'delete' in value &&
    'createMultipartUpload' in value
  );
}

/**
 * Type guard to check if a value is a Workflow binding.
 * Workflow bindings have get, create, and createBatch methods.
 */
export function isWorkflow(value: unknown): value is Workflow {
  return (
    value !== null &&
    typeof value === 'object' &&
    'get' in value &&
    'create' in value &&
    'createBatch' in value &&
    !('idFromName' in value) // Distinguish from DurableObjectNamespace
  );
}

// =============================================================================
// D1 PROXY
// =============================================================================

/**
 * Create a proxied D1 database that tracks reads and writes.
 */
export function createD1Proxy(db: D1Database, metrics: MetricsAccumulator): D1Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (query: string) => {
          const stmt = target.prepare(query);
          return createD1StatementProxy(stmt, metrics);
        };
      }

      if (prop === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          // Count all batch operations from meta
          for (const result of results) {
            if (result.meta) {
              metrics.d1Writes += result.meta.changes ?? 0;
              metrics.d1RowsWritten += result.meta.changes ?? 0;
              metrics.d1Reads += result.meta.rows_read ?? 0;
              metrics.d1RowsRead += result.meta.rows_read ?? 0;
            }
          }
          return results;
        };
      }

      if (prop === 'dump') {
        return async () => {
          metrics.d1Reads += 1;
          return target.dump();
        };
      }

      return Reflect.get(target, prop);
    },
  });
}

/**
 * Create a proxied D1 prepared statement that tracks statement runs.
 * Handles bind() chaining correctly.
 */
function createD1StatementProxy(
  stmt: D1PreparedStatement,
  metrics: MetricsAccumulator
): D1PreparedStatement {
  return new Proxy(stmt, {
    get(target, prop) {
      // Handle bind() - returns a new statement that also needs proxying
      if (prop === 'bind') {
        return (...values: unknown[]) => {
          const boundStmt = target.bind(...values);
          return createD1StatementProxy(boundStmt, metrics);
        };
      }

      // Handle statement runs
      if (prop === 'run' || prop === 'all' || prop === 'first' || prop === 'raw') {
        return async (...args: unknown[]) => {
          const method = target[prop as keyof D1PreparedStatement] as (
            ...args: unknown[]
          ) => Promise<D1Result<unknown>>;
          const result = await method.apply(target, args);

          // Track based on result meta
          if (result && typeof result === 'object' && 'meta' in result) {
            const meta = (result as D1Result<unknown>).meta;
            if (meta) {
              metrics.d1Writes += meta.changes ?? 0;
              metrics.d1RowsWritten += meta.changes ?? 0;
              metrics.d1Reads += meta.rows_read ?? 0;
              metrics.d1RowsRead += meta.rows_read ?? 0;
            }
          }

          return result;
        };
      }

      return Reflect.get(target, prop);
    },
  });
}

// =============================================================================
// KV PROXY
// =============================================================================

/**
 * Create a proxied KV namespace that tracks reads, writes, deletes, and lists.
 */
export function createKVProxy(kv: KVNamespace, metrics: MetricsAccumulator): KVNamespace {
  return new Proxy(kv, {
    get(target, prop) {
      if (prop === 'get') {
        return async (...args: Parameters<KVNamespace['get']>) => {
          metrics.kvReads += 1;
          return target.get(...args);
        };
      }

      if (prop === 'getWithMetadata') {
        return async (...args: Parameters<KVNamespace['getWithMetadata']>) => {
          metrics.kvReads += 1;
          return target.getWithMetadata(...args);
        };
      }

      if (prop === 'put') {
        return async (...args: Parameters<KVNamespace['put']>) => {
          metrics.kvWrites += 1;
          return target.put(...args);
        };
      }

      if (prop === 'delete') {
        return async (...args: Parameters<KVNamespace['delete']>) => {
          metrics.kvDeletes += 1;
          return target.delete(...args);
        };
      }

      if (prop === 'list') {
        return async (...args: Parameters<KVNamespace['list']>) => {
          metrics.kvLists += 1;
          return target.list(...args);
        };
      }

      return Reflect.get(target, prop);
    },
  });
}

// =============================================================================
// AI PROXY
// =============================================================================

/**
 * Create a proxied AI binding that tracks run() calls.
 * Tracks both total request count and per-model breakdown.
 */
export function createAIProxy(ai: Ai, metrics: MetricsAccumulator): Ai {
  return new Proxy(ai, {
    get(target, prop) {
      if (prop === 'run') {
        return async (
          model: string | { name: string; [key: string]: unknown },
          inputs: unknown,
          options?: unknown
        ) => {
          // Extract model name from string or object
          const modelName = typeof model === 'string' ? model : model.name;

          // Track total AI requests
          metrics.aiRequests += 1;

          // Track per-model count
          const currentCount = metrics.aiModelCounts.get(modelName) ?? 0;
          metrics.aiModelCounts.set(modelName, currentCount + 1);

          // Call the actual AI.run method
          const result = await target.run(
            model as Parameters<Ai['run']>[0],
            inputs as Parameters<Ai['run']>[1],
            options as Parameters<Ai['run']>[2]
          );

          // Note: We can't easily track neurons here as they're returned
          // in usage metadata that varies by model. The consumer can
          // derive this from the model + input size.

          return result;
        };
      }

      return Reflect.get(target, prop);
    },
  });
}

// =============================================================================
// VECTORIZE PROXY
// =============================================================================

/**
 * Create a proxied Vectorize index that tracks queries, inserts, and deletes.
 */
export function createVectorizeProxy(
  index: VectorizeIndex,
  metrics: MetricsAccumulator
): VectorizeIndex {
  return new Proxy(index, {
    get(target, prop) {
      if (prop === 'query') {
        return async (...args: Parameters<VectorizeIndex['query']>) => {
          metrics.vectorizeQueries += 1;
          return target.query(...args);
        };
      }

      if (prop === 'insert') {
        return async (vectors: VectorizeVector[]) => {
          metrics.vectorizeInserts += vectors.length;
          return target.insert(vectors);
        };
      }

      if (prop === 'upsert') {
        return async (vectors: VectorizeVector[]) => {
          metrics.vectorizeInserts += vectors.length;
          return target.upsert(vectors);
        };
      }

      if (prop === 'deleteByIds') {
        return async (ids: string[]) => {
          // vectorizeDeletes removed - Analytics Engine 20 double limit
          // Deletes still work, just not tracked in telemetry
          return target.deleteByIds(ids);
        };
      }

      if (prop === 'getByIds') {
        return async (...args: Parameters<VectorizeIndex['getByIds']>) => {
          metrics.vectorizeQueries += 1;
          return target.getByIds(...args);
        };
      }

      if (prop === 'describe') {
        return async () => {
          // describe() is a read operation but doesn't query vectors
          return target.describe();
        };
      }

      return Reflect.get(target, prop);
    },
  });
}

// =============================================================================
// R2 PROXY
// =============================================================================

/**
 * Create a proxied R2MultipartUpload that tracks uploadPart/complete/abort.
 */
function createR2MultipartUploadProxy(
  upload: R2MultipartUpload,
  metrics: MetricsAccumulator
): R2MultipartUpload {
  return new Proxy(upload, {
    get(target, prop) {
      if (prop === 'uploadPart') {
        return async (
          partNumber: number,
          value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob
        ) => {
          metrics.r2ClassA += 1;
          return target.uploadPart(partNumber, value);
        };
      }

      if (prop === 'complete') {
        return async (uploadedParts: R2UploadedPart[]) => {
          metrics.r2ClassA += 1;
          return target.complete(uploadedParts);
        };
      }

      if (prop === 'abort') {
        return async () => {
          metrics.r2ClassA += 1;
          return target.abort();
        };
      }

      return Reflect.get(target, prop);
    },
  });
}

/**
 * Create a proxied R2 bucket that tracks Class A and Class B operations.
 * Class A: list, put, delete, createMultipartUpload, resumeMultipartUpload
 * Class B: head, get
 *
 * IMPORTANT: get() does NOT consume the stream body - just logs the call.
 */
export function createR2Proxy(bucket: R2Bucket, metrics: MetricsAccumulator): R2Bucket {
  return new Proxy(bucket, {
    get(target, prop) {
      // Class B: head
      if (prop === 'head') {
        return async (key: string) => {
          metrics.r2ClassB += 1;
          return target.head(key);
        };
      }

      // Class B: get (don't consume stream)
      if (prop === 'get') {
        return async (key: string, options?: R2GetOptions) => {
          metrics.r2ClassB += 1;
          return target.get(key, options);
        };
      }

      // Class A: put
      if (prop === 'put') {
        return async (
          key: string,
          value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
          options?: R2PutOptions
        ) => {
          metrics.r2ClassA += 1;
          return target.put(key, value, options);
        };
      }

      // Class A: delete
      if (prop === 'delete') {
        return async (keys: string | string[]) => {
          metrics.r2ClassA += 1;
          return target.delete(keys);
        };
      }

      // Class A: list
      if (prop === 'list') {
        return async (options?: R2ListOptions) => {
          metrics.r2ClassA += 1;
          return target.list(options);
        };
      }

      // Class A: createMultipartUpload
      if (prop === 'createMultipartUpload') {
        return async (key: string, options?: R2MultipartOptions) => {
          metrics.r2ClassA += 1;
          const upload = await target.createMultipartUpload(key, options);
          return createR2MultipartUploadProxy(upload, metrics);
        };
      }

      // Class A: resumeMultipartUpload (sync)
      if (prop === 'resumeMultipartUpload') {
        return (key: string, uploadId: string) => {
          metrics.r2ClassA += 1;
          const upload = target.resumeMultipartUpload(key, uploadId);
          return createR2MultipartUploadProxy(upload, metrics);
        };
      }

      return Reflect.get(target, prop);
    },
  });
}

// =============================================================================
// QUEUE PROXY
// =============================================================================

/**
 * Create a proxied Queue that tracks message sends.
 * send() = 1 message, sendBatch() = N messages.
 */
export function createQueueProxy<T = unknown>(
  queue: Queue<T>,
  metrics: MetricsAccumulator
): Queue<T> {
  return new Proxy(queue, {
    get(target, prop) {
      if (prop === 'send') {
        return async (message: T, options?: QueueSendOptions) => {
          metrics.queueMessages += 1;
          return target.send(message, options);
        };
      }

      if (prop === 'sendBatch') {
        return async (
          messages: Iterable<MessageSendRequest<T>>,
          options?: QueueSendBatchOptions
        ) => {
          const messageArray = Array.isArray(messages) ? messages : Array.from(messages);
          metrics.queueMessages += messageArray.length;
          return target.sendBatch(messageArray, options);
        };
      }

      return Reflect.get(target, prop);
    },
  });
}

// =============================================================================
// WORKFLOW PROXY
// =============================================================================

/**
 * Create a proxied Workflow that tracks invocations.
 * create() = 1 invocation, createBatch() = N invocations.
 * get() is read-only and not tracked.
 */
export function createWorkflowProxy<PARAMS = unknown>(
  workflow: Workflow<PARAMS>,
  metrics: MetricsAccumulator
): Workflow<PARAMS> {
  return new Proxy(workflow, {
    get(target, prop) {
      if (prop === 'create') {
        return async (options?: WorkflowInstanceCreateOptions<PARAMS>) => {
          metrics.workflowInvocations += 1;
          return target.create(options);
        };
      }

      if (prop === 'createBatch') {
        return async (batch: WorkflowInstanceCreateOptions<PARAMS>[]) => {
          metrics.workflowInvocations += batch.length;
          return target.createBatch(batch);
        };
      }

      // get() is read-only, pass through
      return Reflect.get(target, prop);
    },
  });
}

// =============================================================================
// DURABLE OBJECTS PROXY
// =============================================================================

/**
 * Create a proxied Durable Object stub that tracks fetch() calls.
 * This is the second level (returned by namespace.get()).
 */
function createDOStubProxy(
  stub: DurableObjectStub,
  metrics: MetricsAccumulator
): DurableObjectStub {
  return new Proxy(stub, {
    get(target, prop) {
      if (prop === 'fetch') {
        return async (...args: Parameters<DurableObjectStub['fetch']>) => {
          const startTime = performance.now();
          metrics.doRequests += 1;
          try {
            return await target.fetch(...args);
          } finally {
            const latencyMs = performance.now() - startTime;
            metrics.doLatencyMs.push(latencyMs);
            metrics.doTotalLatencyMs += latencyMs;
          }
        };
      }

      // Pass through: id, name
      return Reflect.get(target, prop);
    },
  });
}

/**
 * Create a proxied Durable Object namespace.
 * get(id) returns a wrapped stub that tracks fetch() calls.
 * ID creation methods (idFromName, idFromString, newUniqueId) pass through.
 */
export function createDOProxy(
  ns: DurableObjectNamespace,
  metrics: MetricsAccumulator
): DurableObjectNamespace {
  return new Proxy(ns, {
    get(target, prop) {
      if (prop === 'get') {
        return (id: DurableObjectId) => {
          const stub = target.get(id);
          return createDOStubProxy(stub, metrics);
        };
      }

      // Pass through ID methods
      return Reflect.get(target, prop);
    },
  });
}

// =============================================================================
// ENVIRONMENT PROXY
// =============================================================================

/**
 * Reserved binding names that should NOT be proxied.
 * These are used by the SDK itself for control/telemetry.
 */
const RESERVED_BINDINGS = new Set(['PLATFORM_CACHE', 'PLATFORM_TELEMETRY']);

/**
 * Create a proxied environment that wraps all known binding types.
 * Bindings are wrapped lazily on first access.
 *
 * @param env - Original environment object
 * @param metrics - Metrics accumulator to update
 * @returns Proxied environment with tracked bindings
 */
export function createEnvProxy<T extends object>(env: T, metrics: MetricsAccumulator): T {
  // Cache for wrapped bindings to avoid re-wrapping on each access
  const wrappedBindings = new Map<string | symbol, unknown>();

  return new Proxy(env, {
    get(target, prop) {
      // Return cached wrapped binding if available
      if (wrappedBindings.has(prop)) {
        return wrappedBindings.get(prop);
      }

      const value = Reflect.get(target, prop);

      // Skip wrapping for reserved bindings
      if (typeof prop === 'string' && RESERVED_BINDINGS.has(prop)) {
        return value;
      }

      // Wrap D1 databases
      if (isD1Database(value)) {
        const wrapped = createD1Proxy(value, metrics);
        wrappedBindings.set(prop, wrapped);
        return wrapped;
      }

      // Wrap KV namespaces
      if (isKVNamespace(value)) {
        const wrapped = createKVProxy(value, metrics);
        wrappedBindings.set(prop, wrapped);
        return wrapped;
      }

      // Wrap AI bindings
      if (isAIBinding(value)) {
        const wrapped = createAIProxy(value, metrics);
        wrappedBindings.set(prop, wrapped);
        return wrapped;
      }

      // Wrap Vectorize indexes
      if (isVectorizeIndex(value)) {
        const wrapped = createVectorizeProxy(value, metrics);
        wrappedBindings.set(prop, wrapped);
        return wrapped;
      }

      // Wrap R2 buckets
      if (isR2Bucket(value)) {
        const wrapped = createR2Proxy(value, metrics);
        wrappedBindings.set(prop, wrapped);
        return wrapped;
      }

      // Wrap Queues (skip PLATFORM_TELEMETRY - handled by RESERVED_BINDINGS)
      if (isQueue(value)) {
        const wrapped = createQueueProxy(value, metrics);
        wrappedBindings.set(prop, wrapped);
        return wrapped;
      }

      // Wrap Workflows
      if (isWorkflow(value)) {
        const wrapped = createWorkflowProxy(value, metrics);
        wrappedBindings.set(prop, wrapped);
        return wrapped;
      }

      // Wrap Durable Object namespaces
      if (isDurableObjectNamespace(value)) {
        const wrapped = createDOProxy(value, metrics);
        wrappedBindings.set(prop, wrapped);
        return wrapped;
      }

      // Return unwrapped value for other types
      return value;
    },
  });
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Get the metrics accumulator for a proxied environment.
 * Returns undefined if the environment is not being tracked.
 */
export function getMetrics(env: object): MetricsAccumulator | undefined {
  const context = getTelemetryContext(env);
  return context?.metrics;
}
