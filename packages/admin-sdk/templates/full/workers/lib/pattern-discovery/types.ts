/**
 * Types for Automated Transient Error Pattern Discovery
 * @module workers/lib/pattern-discovery/types
 */

/** Pattern types supported by the DSL (ordered by safety) */
export type PatternType = 'contains' | 'startsWith' | 'statusCode' | 'regex';

/** Scope for pattern application */
export type PatternScope = 'global' | `service:${string}` | `upstream:${string}`;

/** Pattern suggestion status - expanded for self-tuning */
export type SuggestionStatus = 'pending' | 'shadow' | 'approved' | 'stale' | 'rejected' | 'disabled';

/** Pattern source tracking */
export type PatternSource = 'ai-discovered' | 'static-import' | 'manual';

/** Audit log action types - expanded for self-tuning */
export type AuditAction =
  | 'created'
  | 'approved'
  | 'rejected'
  | 'enabled'
  | 'disabled'
  | 'auto-disabled'
  | 'backtest-passed'
  | 'backtest-failed'
  | 'shadow-started'
  | 'shadow-completed'
  | 'expired'
  // Self-tuning actions
  | 'auto-promoted'
  | 'auto-demoted'
  | 'ready-for-review'
  | 'reactivated'
  | 'imported';

/** Pattern rule using the constrained DSL */
export interface PatternRule {
  type: PatternType;
  value: string; // Token(s) for contains, prefix for startsWith, code for statusCode, regex string for regex
  category: string;
  scope: PatternScope;
}

/** Pattern suggestion from AI analysis */
export interface PatternSuggestion {
  id: string;
  patternType: PatternType;
  patternValue: string;
  category: string;
  scope: PatternScope;
  confidenceScore: number;
  sampleMessages: string[];
  aiReasoning: string;
  clusterId: string | null;
  status: SuggestionStatus;
  reviewedBy: string | null;
  reviewedAt: number | null;
  rejectionReason: string | null;
  backtestMatchCount: number | null;
  backtestTotalErrors: number | null;
  backtestMatchRate: number | null;
  // Shadow mode tracking
  shadowModeStart: number | null;
  shadowModeEnd: number | null;
  shadowModeMatches: number;
  shadowMatchDays: string[] | null; // Unique days with matches
  // Lifecycle
  enabledAt: number | null;
  disabledAt: number | null;
  lastMatchedAt: number | null;
  matchCount: number;
  // Self-tuning fields
  isProtected: boolean;
  source: PatternSource;
  originalRegex: string | null;
  // Timestamps
  createdAt: number;
  updatedAt: number;
}

/** Shadow evaluation result for auto-promotion decision */
export interface ShadowEvaluationResult {
  patternId: string;
  shadowMatchCount: number;
  shadowDays: number;
  matchSpreadDays: number; // How many unique days had matches
  currentMatchRate: number;
  recommendation: 'promote' | 'demote' | 'continue';
  reasoning: string;
}

/** Configuration for shadow evaluation thresholds */
export interface ShadowEvaluationConfig {
  minMatchesForPromotion: number;     // Default: 5
  minSpreadDaysForPromotion: number;  // Default: 3
  maxMatchRateForPromotion: number;   // Default: 0.8 (80%)
  shadowPeriodDays: number;           // Default: 7
  staleDaysThreshold: number;         // Default: 30
}

/** Error cluster for grouping similar unclassified errors */
export interface ErrorCluster {
  id: string;
  clusterHash: string;
  representativeMessage: string;
  occurrenceCount: number;
  uniqueFingerprints: number;
  firstSeenAt: number;
  lastSeenAt: number;
  scripts: string[];
  status: 'pending' | 'processing' | 'suggested' | 'ignored';
  suggestionId: string | null;
}

/** AI suggestion response from DeepSeek */
export interface AISuggestionResponse {
  patterns: Array<{
    patternType: PatternType;
    patternValue: string;
    category: string;
    confidence: number;
    reasoning: string;
    positiveExamples: string[];
    negativeExamples: string[];
  }>;
  summary: string;
}

/** Backtest result for a pattern */
export interface BacktestResult {
  patternId: string;
  matchCount: number;
  totalErrors: number;
  matchRate: number;
  matchedFingerprints: string[];
  overMatching: boolean; // true if > 80% match rate
  runAt: number;
}

/** Unclassified error from D1 for clustering */
export interface UnclassifiedError {
  fingerprint: string;
  scriptName: string;
  normalizedMessage: string;
  occurrenceCount: number;
  lastSeenAt: number;
}

/** Discovery run result */
export interface DiscoveryResult {
  runId: string;
  runAt: number;
  clustersFound: number;
  clustersProcessed: number;
  suggestionsCreated: number;
  errors: string[];
}
