/**
 * Unit Tests for Platform SDK AI Gateway Tracking
 *
 * Tests URL parsing, usage reporting, and fetch wrapper functionality.
 *
 * @module tests/unit/platform-sdk/ai-gateway
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  parseAIGatewayUrl,
  reportAIGatewayUsage,
  createAIGatewayFetch,
  createAIGatewayFetchWithBodyParsing,
} from '@littlebearapps/platform-sdk';
import {
  setTelemetryContext,
  getTelemetryContext,
  clearTelemetryContext,
  type TelemetryContext,
} from '@littlebearapps/platform-sdk';
import { createMetricsAccumulator } from '@littlebearapps/platform-sdk';

// =============================================================================
// URL PARSING TESTS
// =============================================================================

describe('parseAIGatewayUrl', () => {
  describe('Google AI Studio', () => {
    it('parses generateContent URL', () => {
      const url =
        'https://gateway.ai.cloudflare.com/v1/abc123/my-gateway/google-ai-studio/v1beta/models/gemini-pro:generateContent';
      const result = parseAIGatewayUrl(url);

      expect(result).toEqual({
        provider: 'google-ai-studio',
        model: 'gemini-pro',
        accountId: 'abc123',
        gatewayId: 'my-gateway',
      });
    });

    it('parses gemini-2.0-flash model', () => {
      const url =
        'https://gateway.ai.cloudflare.com/v1/abc123/scout-gateway/google-ai-studio/v1beta/models/gemini-2.0-flash:generateContent';
      const result = parseAIGatewayUrl(url);

      expect(result).toEqual({
        provider: 'google-ai-studio',
        model: 'gemini-2.0-flash',
        accountId: 'abc123',
        gatewayId: 'scout-gateway',
      });
    });

    it('parses streamGenerateContent URL', () => {
      const url =
        'https://gateway.ai.cloudflare.com/v1/abc123/my-gateway/google-ai-studio/v1beta/models/gemini-pro:streamGenerateContent';
      const result = parseAIGatewayUrl(url);

      expect(result).toEqual({
        provider: 'google-ai-studio',
        model: 'gemini-pro',
        accountId: 'abc123',
        gatewayId: 'my-gateway',
      });
    });
  });

  describe('OpenAI', () => {
    it('parses chat completions URL', () => {
      const url =
        'https://gateway.ai.cloudflare.com/v1/abc123/my-gateway/openai/v1/chat/completions';
      const result = parseAIGatewayUrl(url);

      expect(result).toEqual({
        provider: 'openai',
        model: 'gpt-4o',
        accountId: 'abc123',
        gatewayId: 'my-gateway',
      });
    });

    it('parses embeddings URL', () => {
      const url = 'https://gateway.ai.cloudflare.com/v1/abc123/my-gateway/openai/v1/embeddings';
      const result = parseAIGatewayUrl(url);

      expect(result).toEqual({
        provider: 'openai',
        model: 'text-embedding-3-small',
        accountId: 'abc123',
        gatewayId: 'my-gateway',
      });
    });

    it('parses images URL', () => {
      const url =
        'https://gateway.ai.cloudflare.com/v1/abc123/my-gateway/openai/v1/images/generations';
      const result = parseAIGatewayUrl(url);

      expect(result).toEqual({
        provider: 'openai',
        model: 'dall-e-3',
        accountId: 'abc123',
        gatewayId: 'my-gateway',
      });
    });
  });

  describe('DeepSeek', () => {
    it('parses chat completions URL', () => {
      const url =
        'https://gateway.ai.cloudflare.com/v1/abc123/my-gateway/deepseek/v1/chat/completions';
      const result = parseAIGatewayUrl(url);

      expect(result).toEqual({
        provider: 'deepseek',
        model: 'deepseek-chat',
        accountId: 'abc123',
        gatewayId: 'my-gateway',
      });
    });

    it('parses embeddings URL', () => {
      const url = 'https://gateway.ai.cloudflare.com/v1/abc123/my-gateway/deepseek/v1/embeddings';
      const result = parseAIGatewayUrl(url);

      expect(result).toEqual({
        provider: 'deepseek',
        model: 'deepseek-embedding',
        accountId: 'abc123',
        gatewayId: 'my-gateway',
      });
    });
  });

  describe('Anthropic', () => {
    it('parses messages URL', () => {
      const url = 'https://gateway.ai.cloudflare.com/v1/abc123/my-gateway/anthropic/v1/messages';
      const result = parseAIGatewayUrl(url);

      expect(result).toEqual({
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        accountId: 'abc123',
        gatewayId: 'my-gateway',
      });
    });
  });

  describe('Non-AI Gateway URLs', () => {
    it('returns null for regular API URLs', () => {
      const url = 'https://api.openai.com/v1/chat/completions';
      const result = parseAIGatewayUrl(url);

      expect(result).toBeNull();
    });

    it('returns null for unrelated URLs', () => {
      const url = 'https://example.com/api/data';
      const result = parseAIGatewayUrl(url);

      expect(result).toBeNull();
    });

    it('returns null for partial AI Gateway URLs', () => {
      const url = 'https://gateway.ai.cloudflare.com/v1/abc123';
      const result = parseAIGatewayUrl(url);

      expect(result).toBeNull();
    });
  });
});

// =============================================================================
// USAGE REPORTING TESTS
// =============================================================================

describe('reportAIGatewayUsage', () => {
  let env: Record<string, unknown>;

  beforeEach(() => {
    env = {};
  });

  afterEach(() => {
    clearTelemetryContext(env);
  });

  it('increments aiRequests counter', () => {
    const metrics = createMetricsAccumulator();
    const context: TelemetryContext = {
      featureId: 'scout:ai:scoring',
      metrics,
      startTime: Date.now(),
    };
    setTelemetryContext(env, context);

    reportAIGatewayUsage(env, 'google-ai-studio', 'gemini-pro');

    expect(metrics.aiRequests).toBe(1);
  });

  it('tracks model breakdown', () => {
    const metrics = createMetricsAccumulator();
    const context: TelemetryContext = {
      featureId: 'scout:ai:scoring',
      metrics,
      startTime: Date.now(),
    };
    setTelemetryContext(env, context);

    reportAIGatewayUsage(env, 'google-ai-studio', 'gemini-pro');

    expect(metrics.aiModelCounts.get('google-ai-studio/gemini-pro')).toBe(1);
  });

  it('accumulates multiple calls', () => {
    const metrics = createMetricsAccumulator();
    const context: TelemetryContext = {
      featureId: 'scout:ai:scoring',
      metrics,
      startTime: Date.now(),
    };
    setTelemetryContext(env, context);

    reportAIGatewayUsage(env, 'google-ai-studio', 'gemini-pro');
    reportAIGatewayUsage(env, 'google-ai-studio', 'gemini-pro');
    reportAIGatewayUsage(env, 'openai', 'gpt-4o');

    expect(metrics.aiRequests).toBe(3);
    expect(metrics.aiModelCounts.get('google-ai-studio/gemini-pro')).toBe(2);
    expect(metrics.aiModelCounts.get('openai/gpt-4o')).toBe(1);
  });

  it('handles missing telemetry context gracefully', () => {
    // No context set - should not throw
    expect(() => {
      reportAIGatewayUsage(env, 'google-ai-studio', 'gemini-pro');
    }).not.toThrow();
  });
});

// =============================================================================
// FETCH WRAPPER TESTS
// =============================================================================

describe('createAIGatewayFetch', () => {
  let env: Record<string, unknown>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    env = {};
    originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(new Response('ok'));
  });

  afterEach(() => {
    clearTelemetryContext(env);
    global.fetch = originalFetch;
  });

  it('tracks AI Gateway calls', async () => {
    const metrics = createMetricsAccumulator();
    const context: TelemetryContext = {
      featureId: 'scout:ai:scoring',
      metrics,
      startTime: Date.now(),
    };
    setTelemetryContext(env, context);

    const trackedFetch = createAIGatewayFetch(env);
    await trackedFetch(
      'https://gateway.ai.cloudflare.com/v1/abc123/my-gateway/google-ai-studio/v1beta/models/gemini-pro:generateContent',
      { method: 'POST', body: '{}' }
    );

    expect(metrics.aiRequests).toBe(1);
    expect(metrics.aiModelCounts.get('google-ai-studio/gemini-pro')).toBe(1);
  });

  it('passes through non-AI Gateway calls', async () => {
    const metrics = createMetricsAccumulator();
    const context: TelemetryContext = {
      featureId: 'scout:ai:scoring',
      metrics,
      startTime: Date.now(),
    };
    setTelemetryContext(env, context);

    const trackedFetch = createAIGatewayFetch(env);
    await trackedFetch('https://api.example.com/data');

    expect(metrics.aiRequests).toBe(0);
    expect(metrics.aiModelCounts.size).toBe(0);
  });

  it('returns the actual response', async () => {
    const expectedResponse = new Response('test response', { status: 200 });
    global.fetch = vi.fn().mockResolvedValue(expectedResponse);

    const trackedFetch = createAIGatewayFetch(env);
    const response = await trackedFetch('https://example.com');

    expect(response).toBe(expectedResponse);
  });
});

describe('createAIGatewayFetchWithBodyParsing', () => {
  let env: Record<string, unknown>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    env = {};
    originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(new Response('ok'));
  });

  afterEach(() => {
    clearTelemetryContext(env);
    global.fetch = originalFetch;
  });

  it('extracts model from request body for OpenAI', async () => {
    const metrics = createMetricsAccumulator();
    const context: TelemetryContext = {
      featureId: 'brand-copilot:content:generate',
      metrics,
      startTime: Date.now(),
    };
    setTelemetryContext(env, context);

    const trackedFetch = createAIGatewayFetchWithBodyParsing(env);
    await trackedFetch(
      'https://gateway.ai.cloudflare.com/v1/abc123/my-gateway/openai/v1/chat/completions',
      {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-4o-mini', messages: [] }),
      }
    );

    expect(metrics.aiRequests).toBe(1);
    expect(metrics.aiModelCounts.get('openai/gpt-4o-mini')).toBe(1);
  });

  it('falls back to URL-derived model when body parsing fails', async () => {
    const metrics = createMetricsAccumulator();
    const context: TelemetryContext = {
      featureId: 'brand-copilot:content:generate',
      metrics,
      startTime: Date.now(),
    };
    setTelemetryContext(env, context);

    const trackedFetch = createAIGatewayFetchWithBodyParsing(env);
    await trackedFetch(
      'https://gateway.ai.cloudflare.com/v1/abc123/my-gateway/openai/v1/chat/completions',
      { method: 'POST', body: 'not-json' }
    );

    expect(metrics.aiRequests).toBe(1);
    expect(metrics.aiModelCounts.get('openai/gpt-4o')).toBe(1);
  });
});

// =============================================================================
// TRACKED ENV FETCH TESTS (via withFeatureBudget)
// =============================================================================

describe('trackedEnv.fetch (integrated)', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(new Response('ok'));
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('is available on trackedEnv', async () => {
    const { withFeatureBudget } = await import('@littlebearapps/platform-sdk');

    const env = {
      PLATFORM_CACHE: {
        get: vi.fn().mockResolvedValue(null),
      } as unknown as KVNamespace,
    };

    const trackedEnv = withFeatureBudget(env, 'test:api:handler', {
      checkCircuitBreaker: false,
      reportTelemetry: true,
    });

    expect(typeof trackedEnv.fetch).toBe('function');
  });

  it('tracks AI Gateway calls via trackedEnv.fetch', async () => {
    const { withFeatureBudget, getTelemetryContext } =
      await import('@littlebearapps/platform-sdk');

    const env = {
      PLATFORM_CACHE: {
        get: vi.fn().mockResolvedValue(null),
      } as unknown as KVNamespace,
    };

    const trackedEnv = withFeatureBudget(env, 'test:ai:generate', {
      checkCircuitBreaker: false,
      reportTelemetry: true,
    });

    await trackedEnv.fetch(
      'https://gateway.ai.cloudflare.com/v1/abc123/my-gateway/google-ai-studio/v1beta/models/gemini-2.0-flash:generateContent',
      { method: 'POST', body: '{}' }
    );

    const context = getTelemetryContext(trackedEnv);
    expect(context?.metrics.aiRequests).toBe(1);
    expect(context?.metrics.aiModelCounts.get('google-ai-studio/gemini-2.0-flash')).toBe(1);
  });

  it('extracts model from request body for OpenAI', async () => {
    const { withFeatureBudget, getTelemetryContext } =
      await import('@littlebearapps/platform-sdk');

    const env = {
      PLATFORM_CACHE: {
        get: vi.fn().mockResolvedValue(null),
      } as unknown as KVNamespace,
    };

    const trackedEnv = withFeatureBudget(env, 'test:ai:chat', {
      checkCircuitBreaker: false,
      reportTelemetry: true,
    });

    await trackedEnv.fetch(
      'https://gateway.ai.cloudflare.com/v1/abc123/my-gateway/openai/v1/chat/completions',
      {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-4o-mini', messages: [] }),
      }
    );

    const context = getTelemetryContext(trackedEnv);
    expect(context?.metrics.aiRequests).toBe(1);
    expect(context?.metrics.aiModelCounts.get('openai/gpt-4o-mini')).toBe(1);
  });

  it('does not track non-AI Gateway URLs', async () => {
    const { withFeatureBudget, getTelemetryContext } =
      await import('@littlebearapps/platform-sdk');

    const env = {
      PLATFORM_CACHE: {
        get: vi.fn().mockResolvedValue(null),
      } as unknown as KVNamespace,
    };

    const trackedEnv = withFeatureBudget(env, 'test:api:external', {
      checkCircuitBreaker: false,
      reportTelemetry: true,
    });

    await trackedEnv.fetch('https://api.example.com/data');

    const context = getTelemetryContext(trackedEnv);
    expect(context?.metrics.aiRequests).toBe(0);
    expect(context?.metrics.aiModelCounts.size).toBe(0);
  });

  it('returns the actual response', async () => {
    const { withFeatureBudget } = await import('@littlebearapps/platform-sdk');

    const expectedResponse = new Response('test data', { status: 200 });
    global.fetch = vi.fn().mockResolvedValue(expectedResponse);

    const env = {
      PLATFORM_CACHE: {
        get: vi.fn().mockResolvedValue(null),
      } as unknown as KVNamespace,
    };

    const trackedEnv = withFeatureBudget(env, 'test:api:fetch', {
      checkCircuitBreaker: false,
      reportTelemetry: true,
    });

    const response = await trackedEnv.fetch('https://example.com');

    expect(response).toBe(expectedResponse);
  });
});
