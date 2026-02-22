/// <reference types="@cloudflare/workers-types" />

/**
 * Circuit Breaker Middleware -- Thin Re-export from Platform SDK
 *
 * All logic lives in @littlebearapps/platform-sdk/middleware.
 * This file re-exports with the original names for backward compatibility.
 *
 * @see packages/platform-sdk/src/middleware.ts
 */

// Re-export with original names (SDK uses prefixed names)
export {
  PROJECT_CB_STATUS as CB_STATUS,
  CB_PROJECT_KEYS,
  CB_ERROR_CODES,
  BUDGET_STATUS_HEADER,
  checkProjectCircuitBreaker as checkCircuitBreaker,
  checkProjectCircuitBreakerDetailed as checkCircuitBreakerDetailed,
  createCircuitBreakerMiddleware,
  getCircuitBreakerStates,
  type CircuitBreakerStatusValue,
  type CircuitBreakerCheckResult,
  type CircuitBreakerErrorResponse,
} from '@littlebearapps/platform-sdk/middleware';
