/// <reference types="@cloudflare/workers-types" />

/**
 * Platform SDK AI Gateway Tracking
 *
 * Provides a drop-in replacement fetch wrapper for AI Gateway calls.
 * Automatically parses provider/model from URLs and reports usage to telemetry.
 *
 * @example
 * ```typescript
 * const trackedEnv = withFeatureBudget(env, 'scout:ai:scoring', { ctx });
 * const trackedFetch = createAIGatewayFetch(trackedEnv);
 *
 * const response = await trackedFetch(
 *   `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/google-ai-studio/v1beta/models/gemini-pro:generateContent`,
 *   { method: 'POST', body: JSON.stringify(payload) }
 * );
 * ```
 */

import { getTelemetryContext } from './telemetry';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Parsed AI Gateway URL components.
 */
export interface AIGatewayUrlInfo {
  /** Provider name (google-ai-studio, openai, deepseek, anthropic, etc.) */
  provider: string;
  /** Model name extracted from URL path */
  model: string;
  /** Account ID from the URL */
  accountId: string;
  /** Gateway ID from the URL */
  gatewayId: string;
}

/**
 * AI Gateway provider types.
 */
export type AIGatewayProvider =
  | 'google-ai-studio'
  | 'openai'
  | 'deepseek'
  | 'anthropic'
  | 'workers-ai'
  | 'azure-openai'
  | 'bedrock'
  | 'groq'
  | 'mistral'
  | 'perplexity'
  | string; // Allow custom providers

// =============================================================================
// URL PARSING
// =============================================================================

/**
 * AI Gateway URL pattern.
 * Format: gateway.ai.cloudflare.com/v1/{accountId}/{gatewayId}/{provider}/...
 */
const AI_GATEWAY_PATTERN = /gateway\.ai\.cloudflare\.com\/v1\/([^/]+)\/([^/]+)\/([^/]+)\/(.*)/;

/**
 * Parse an AI Gateway URL to extract provider and model information.
 * Supports all major providers: Google AI Studio, OpenAI, DeepSeek, Anthropic, etc.
 *
 * @param url - The AI Gateway URL to parse
 * @returns Parsed URL info or null if not an AI Gateway URL
 *
 * @example
 * ```typescript
 * const info = parseAIGatewayUrl(
 *   'https://gateway.ai.cloudflare.com/v1/abc123/my-gateway/google-ai-studio/v1beta/models/gemini-pro:generateContent'
 * );
 * // { provider: 'google-ai-studio', model: 'gemini-pro', accountId: 'abc123', gatewayId: 'my-gateway' }
 * ```
 */
export function parseAIGatewayUrl(url: string): AIGatewayUrlInfo | null {
  const match = url.match(AI_GATEWAY_PATTERN);
  if (!match) return null;

  const accountId = match[1];
  const gatewayId = match[2];
  const provider = match[3];
  const path = match[4];

  const model = extractModelFromPath(provider, path);

  return { provider, model, accountId, gatewayId };
}

/**
 * Extract model name from the URL path based on provider-specific patterns.
 */
function extractModelFromPath(provider: string, path: string): string {
  switch (provider) {
    case 'google-ai-studio': {
      // Pattern: v1beta/models/{model}:generateContent or v1beta/models/{model}:streamGenerateContent
      const match = path.match(/models\/([^/:]+)/);
      return match?.[1] ?? 'gemini-unknown';
    }

    case 'openai': {
      // Model is typically in request body, not URL
      // Path patterns: v1/chat/completions, v1/embeddings, v1/images/generations
      if (path.includes('embeddings')) {
        return 'text-embedding-3-small';
      }
      if (path.includes('images')) {
        return 'dall-e-3';
      }
      // Default to gpt-4o for chat completions - actual model in body
      return 'gpt-4o';
    }

    case 'deepseek': {
      // DeepSeek follows OpenAI format
      if (path.includes('embeddings')) {
        return 'deepseek-embedding';
      }
      return 'deepseek-chat';
    }

    case 'anthropic': {
      // Anthropic: v1/messages
      // Model is in request body, default to claude-sonnet
      return 'claude-3-5-sonnet';
    }

    case 'workers-ai': {
      // Pattern: {model} directly in path
      const segments = path.split('/').filter(Boolean);
      return segments[0] ?? 'workers-ai-unknown';
    }

    case 'groq': {
      // Groq follows OpenAI format
      return 'llama-3.1-70b';
    }

    case 'mistral': {
      // Mistral: v1/chat/completions
      return 'mistral-large';
    }

    case 'perplexity': {
      // Perplexity: chat/completions
      return 'llama-3.1-sonar';
    }

    default: {
      // For unknown providers, try to extract model from common patterns
      // Try OpenAI-style /models/{model} pattern
      const modelMatch = path.match(/models\/([^/]+)/);
      if (modelMatch) {
        return modelMatch[1];
      }
      // Return provider as model identifier
      return `${provider}-unknown`;
    }
  }
}

// =============================================================================
// USAGE REPORTING
// =============================================================================

/**
 * Report AI Gateway usage to telemetry context.
 * Increments aiRequests counter and tracks per-model breakdown.
 *
 * @param env - The tracked environment from withFeatureBudget
 * @param provider - AI provider name (google-ai-studio, openai, etc.)
 * @param model - Model name
 *
 * @example
 * ```typescript
 * const trackedEnv = withFeatureBudget(env, 'scout:ai:scoring', { ctx });
 * reportAIGatewayUsage(trackedEnv, 'google-ai-studio', 'gemini-pro');
 * ```
 */
export function reportAIGatewayUsage(env: object, provider: string, model: string): void {
  const context = getTelemetryContext(env);
  if (!context) {
    // No telemetry context - silently skip
    // This happens when called outside of withFeatureBudget
    return;
  }

  // Increment total AI requests
  context.metrics.aiRequests += 1;

  // Track per-model breakdown using provider/model format
  const fullModelName = `${provider}/${model}`;
  const currentCount = context.metrics.aiModelCounts.get(fullModelName) ?? 0;
  context.metrics.aiModelCounts.set(fullModelName, currentCount + 1);
}

// =============================================================================
// TRACKED FETCH WRAPPER
// =============================================================================

/**
 * Create a tracked fetch wrapper for AI Gateway calls.
 * Automatically extracts provider and model from URL and reports usage.
 *
 * This is a drop-in replacement for fetch() when calling AI Gateway endpoints.
 * Non-AI Gateway URLs are passed through without tracking.
 *
 * @param env - The tracked environment from withFeatureBudget
 * @returns A fetch function that tracks AI Gateway usage
 *
 * @example
 * ```typescript
 * const trackedEnv = withFeatureBudget(env, 'scout:ai:scoring', { ctx });
 * const trackedFetch = createAIGatewayFetch(trackedEnv);
 *
 * // This call is automatically tracked
 * const response = await trackedFetch(
 *   `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/google-ai-studio/v1beta/models/gemini-pro:generateContent`,
 *   { method: 'POST', body: JSON.stringify(payload) }
 * );
 *
 * // Non-AI Gateway calls pass through unchanged
 * const other = await trackedFetch('https://api.example.com/data');
 * ```
 */
export function createAIGatewayFetch(env: object): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Extract URL string from various input types
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    // Parse AI Gateway URL
    const parsed = parseAIGatewayUrl(url);

    // Make the actual fetch call
    const response = await fetch(input, init);

    // Report usage if this was an AI Gateway call
    if (parsed) {
      reportAIGatewayUsage(env, parsed.provider, parsed.model);
    }

    return response;
  };
}

/**
 * Create a tracked fetch wrapper that also extracts the model from the request body.
 * Use this when you need accurate model tracking for providers where the model
 * is specified in the request body (OpenAI, Anthropic, DeepSeek).
 *
 * @param env - The tracked environment from withFeatureBudget
 * @returns A fetch function that tracks AI Gateway usage with body parsing
 *
 * @example
 * ```typescript
 * const trackedEnv = withFeatureBudget(env, 'brand-copilot:content:generate', { ctx });
 * const trackedFetch = createAIGatewayFetchWithBodyParsing(trackedEnv);
 *
 * const response = await trackedFetch(
 *   `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/openai/v1/chat/completions`,
 *   {
 *     method: 'POST',
 *     body: JSON.stringify({ model: 'gpt-4o-mini', messages: [...] })
 *   }
 * );
 * // Tracks as 'openai/gpt-4o-mini' instead of default 'openai/gpt-4o'
 * ```
 */
export function createAIGatewayFetchWithBodyParsing(env: object): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Extract URL string
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    // Parse AI Gateway URL
    const parsed = parseAIGatewayUrl(url);

    // Make the actual fetch call
    const response = await fetch(input, init);

    // Report usage if this was an AI Gateway call
    if (parsed) {
      // Try to extract model from request body
      let model = parsed.model;
      if (init?.body && typeof init.body === 'string') {
        try {
          const body = JSON.parse(init.body) as { model?: string };
          if (body.model && typeof body.model === 'string') {
            model = body.model;
          }
        } catch {
          // Body is not JSON or doesn't have model field - use URL-derived model
        }
      }
      reportAIGatewayUsage(env, parsed.provider, model);
    }

    return response;
  };
}
