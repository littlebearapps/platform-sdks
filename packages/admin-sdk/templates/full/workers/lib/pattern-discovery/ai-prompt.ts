/**
 * AI Prompt for Pattern Suggestion
 *
 * Uses DeepSeek via AI Gateway to analyse error clusters
 * and suggest transient error patterns.
 *
 * @module workers/lib/pattern-discovery/ai-prompt
 */

import type { ErrorCluster, AISuggestionResponse, PatternType } from './types';
import type { Logger } from '@littlebearapps/platform-consumer-sdk';
import type { AggregatedPatternEvidence } from './storage';

/** DeepSeek AI Gateway URL */
const DEEPSEEK_GATEWAY_URL = 'https://gateway.ai.cloudflare.com/v1';

/** Maximum tokens for AI response */
const MAX_TOKENS = 1500;

/** Timeout for AI API calls (25s — well within Worker's 30s scheduled limit) */
const AI_FETCH_TIMEOUT_MS = 25_000;

/**
 * Build the prompt for pattern suggestion
 */
function buildPrompt(clusters: ErrorCluster[], sampleMessages: Map<string, string[]>): string {
  const clusterDescriptions = clusters
    .map((cluster, i) => {
      const samples = sampleMessages.get(cluster.id) || [cluster.representativeMessage];
      return `
### Cluster ${i + 1}
- **Occurrences**: ${cluster.occurrenceCount}
- **Unique fingerprints**: ${cluster.uniqueFingerprints}
- **Scripts**: ${cluster.scripts.join(', ')}
- **Sample messages**:
${samples.map((s, j) => `  ${j + 1}. "${s}"`).join('\n')}
`;
    })
    .join('\n');

  return `You are analysing error messages from Cloudflare Workers to identify TRANSIENT errors.

## Definition of Transient Errors
Transient errors are expected operational issues that:
- Self-resolve over time (quota resets, rate limits lift, services recover)
- Are caused by external factors (API limits, network issues, deployments)
- Should NOT create duplicate GitHub issues

## Common Transient Categories
- \`quota-exhausted\`: API quotas, daily limits
- \`rate-limited\`: Rate limiting, 429 errors
- \`timeout\`: Request/connection timeouts
- \`service-unavailable\`: 502/503 errors
- \`connection-error\`: ECONNREFUSED, ETIMEDOUT, ECONNRESET
- \`deployment-related\`: Durable Object resets, code updates

## Error Clusters to Analyse
${clusterDescriptions}

## Your Task
For each cluster that represents a TRANSIENT error, suggest a pattern to match it.

**IMPORTANT**: Use the safest pattern type possible:
1. \`contains\` - Match if message contains specific tokens (SAFEST)
2. \`startsWith\` - Match if message starts with prefix
3. \`statusCode\` - Match HTTP status codes (e.g., "429", "503")
4. \`regex\` - Only if the above won't work (AVOID if possible)

If a cluster is NOT transient (actual bugs, logic errors), mark confidence as 0.

## Response Format (JSON only)
{
  "patterns": [
    {
      "patternType": "contains",
      "patternValue": "quota exceeded",
      "category": "quota-exhausted",
      "confidence": 0.9,
      "reasoning": "Error mentions quota exceeded, typical API rate limit",
      "positiveExamples": ["quota exceeded for API", "daily quota exceeded"],
      "negativeExamples": ["quota configuration error"]
    }
  ],
  "summary": "Found 2 transient patterns (quota, rate-limit), 1 cluster appears to be a real bug"
}

IMPORTANT: Your response must be valid JSON. Do not include any text outside the JSON object.`;
}

/**
 * Validate AI response matches expected schema
 */
function validateResponse(data: unknown): AISuggestionResponse | null {
  if (!data || typeof data !== 'object') return null;

  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.patterns)) return null;
  if (typeof obj.summary !== 'string') return null;

  const validTypes: PatternType[] = ['contains', 'startsWith', 'statusCode', 'regex'];

  for (const pattern of obj.patterns) {
    if (!pattern || typeof pattern !== 'object') return null;
    const p = pattern as Record<string, unknown>;

    if (!validTypes.includes(p.patternType as PatternType)) return null;
    if (typeof p.patternValue !== 'string') return null;
    if (typeof p.category !== 'string') return null;
    if (typeof p.confidence !== 'number') return null;
    if (typeof p.reasoning !== 'string') return null;
    if (!Array.isArray(p.positiveExamples)) return null;
    if (!Array.isArray(p.negativeExamples)) return null;
  }

  return obj as unknown as AISuggestionResponse;
}

/**
 * Call DeepSeek to analyse clusters and suggest patterns
 */
/** Static pattern evaluation request */
export interface StaticPatternInput {
  pattern: string; // The regex pattern as a string
  category: string;
  index: number;
}

/** AI evaluation response for static patterns */
export interface StaticPatternEvaluation {
  evaluations: Array<{
    index: number;
    category: string;
    verdict: 'keep-static' | 'migrate-dynamic' | 'merge' | 'deprecate';
    convertedType?: PatternType;
    convertedValue?: string;
    reasoning: string;
    confidenceScore: number;
  }>;
  summary: string;
}

/**
 * Build prompt for evaluating static patterns
 */
function buildStaticEvaluationPrompt(patterns: StaticPatternInput[]): string {
  const patternList = patterns
    .map(
      (p) => `${p.index}. Category: "${p.category}"
   Regex: \`${p.pattern}\``
    )
    .join('\n\n');

  return `You are evaluating HARDCODED transient error patterns to determine if they should be migrated to a dynamic pattern system.

## Current Static Patterns
These patterns are compiled into production code. They detect transient errors (quota, rate limits, timeouts, etc.) that should NOT create duplicate GitHub issues.

${patternList}

## Your Task
For each pattern, evaluate whether it should:
1. **keep-static** - Keep as hardcoded (core infrastructure patterns that rarely change)
2. **migrate-dynamic** - Convert to dynamic DSL for better visibility/management
3. **merge** - Can be merged with another pattern
4. **deprecate** - Pattern is too broad, outdated, or problematic

If recommending migration, convert the regex to our safer DSL:
- \`contains\` - Match if message contains tokens (PREFERRED)
- \`startsWith\` - Match if message starts with prefix
- \`statusCode\` - Match HTTP status codes
- \`regex\` - Only if truly necessary

## Response Format (JSON only)
{
  "evaluations": [
    {
      "index": 1,
      "category": "quota-exhausted",
      "verdict": "migrate-dynamic",
      "convertedType": "contains",
      "convertedValue": "quota exceeded",
      "reasoning": "Can be expressed safely with contains, benefits from visibility in dashboard",
      "confidenceScore": 0.9
    },
    {
      "index": 2,
      "category": "rate-limited",
      "verdict": "keep-static",
      "reasoning": "Core infrastructure pattern, simple regex, low maintenance risk",
      "confidenceScore": 0.85
    }
  ],
  "summary": "Recommend migrating 5 patterns, keeping 10 static, merging 2, deprecating 1"
}

IMPORTANT: Respond with valid JSON only. No text outside the JSON object.`;
}

/**
 * Validate static evaluation response
 */
function validateStaticEvaluationResponse(data: unknown): StaticPatternEvaluation | null {
  if (!data || typeof data !== 'object') return null;

  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.evaluations)) return null;
  if (typeof obj.summary !== 'string') return null;

  const validVerdicts = ['keep-static', 'migrate-dynamic', 'merge', 'deprecate'];
  const validTypes: PatternType[] = ['contains', 'startsWith', 'statusCode', 'regex'];

  for (const evaluation of obj.evaluations) {
    if (!evaluation || typeof evaluation !== 'object') return null;
    const e = evaluation as Record<string, unknown>;

    if (typeof e.index !== 'number') return null;
    if (typeof e.category !== 'string') return null;
    if (!validVerdicts.includes(e.verdict as string)) return null;
    if (typeof e.reasoning !== 'string') return null;
    if (typeof e.confidenceScore !== 'number') return null;

    // If migrating, must have converted type/value
    if (e.verdict === 'migrate-dynamic') {
      if (!validTypes.includes(e.convertedType as PatternType)) return null;
      if (typeof e.convertedValue !== 'string') return null;
    }
  }

  return obj as unknown as StaticPatternEvaluation;
}

/**
 * Call DeepSeek to evaluate static patterns for potential migration
 */
export async function evaluateStaticPatterns(
  patterns: StaticPatternInput[],
  env: { CLOUDFLARE_ACCOUNT_ID: string; PLATFORM_AI_GATEWAY_KEY: string },
  log: Logger
): Promise<StaticPatternEvaluation | null> {
  if (patterns.length === 0) {
    log.info('No patterns to evaluate');
    return { evaluations: [], summary: 'No patterns provided' };
  }

  const prompt = buildStaticEvaluationPrompt(patterns);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${DEEPSEEK_GATEWAY_URL}/${env.CLOUDFLARE_ACCOUNT_ID}/platform/deepseek/chat/completions`,
      {
        method: 'POST',
        headers: {
          'cf-aig-authorization': `Bearer ${env.PLATFORM_AI_GATEWAY_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            {
              role: 'system',
              content:
                'You are an expert at evaluating error patterns for production systems. Respond with valid JSON only.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.1,
          max_tokens: 3000, // Larger for evaluating many patterns
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error');
      log.error('DeepSeek API error', new Error(`HTTP ${response.status}`), {
        status: response.status,
        errorBody: errorBody.slice(0, 500),
      });
      return null;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      log.error('Empty response from DeepSeek');
      return null;
    }

    // Parse JSON response
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      log.error('Invalid JSON from DeepSeek', new Error('Parse failed'), {
        content: content.slice(0, 500),
      });
      return null;
    }

    // Validate response structure
    const validated = validateStaticEvaluationResponse(parsed);
    if (!validated) {
      log.error('Response failed validation', new Error('Schema mismatch'), {
        parsed: JSON.stringify(parsed).slice(0, 500),
      });
      return null;
    }

    log.info('Static pattern evaluation complete', {
      patternsEvaluated: validated.evaluations.length,
      summary: validated.summary.slice(0, 100),
    });

    return validated;
  } catch (error) {
    log.error('DeepSeek request failed', error);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Call DeepSeek to analyse clusters and suggest patterns
 */
export async function suggestPatterns(
  clusters: ErrorCluster[],
  sampleMessages: Map<string, string[]>,
  env: { CLOUDFLARE_ACCOUNT_ID: string; PLATFORM_AI_GATEWAY_KEY: string },
  log: Logger
): Promise<AISuggestionResponse | null> {
  if (clusters.length === 0) {
    log.info('No clusters to analyse');
    return { patterns: [], summary: 'No clusters provided' };
  }

  const prompt = buildPrompt(clusters, sampleMessages);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${DEEPSEEK_GATEWAY_URL}/${env.CLOUDFLARE_ACCOUNT_ID}/platform/deepseek/chat/completions`,
      {
        method: 'POST',
        headers: {
          'cf-aig-authorization': `Bearer ${env.PLATFORM_AI_GATEWAY_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            {
              role: 'system',
              content:
                'You are an expert at identifying transient vs permanent errors in production systems. Respond with valid JSON only.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.1,
          max_tokens: MAX_TOKENS,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error');
      log.error('DeepSeek API error', new Error(`HTTP ${response.status}`), {
        status: response.status,
        errorBody: errorBody.slice(0, 500),
      });
      return null;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      log.error('Empty response from DeepSeek');
      return null;
    }

    // Parse JSON response
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      log.error('Invalid JSON from DeepSeek', new Error('Parse failed'), {
        content: content.slice(0, 500),
      });
      return null;
    }

    // Validate response structure
    const validated = validateResponse(parsed);
    if (!validated) {
      log.error('Response failed validation', new Error('Schema mismatch'), {
        parsed: JSON.stringify(parsed).slice(0, 500),
      });
      return null;
    }

    log.info('DeepSeek analysis complete', {
      patternsFound: validated.patterns.length,
      summary: validated.summary.slice(0, 100),
    });

    return validated;
  } catch (error) {
    log.error('DeepSeek request failed', error);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Review context explainer response from AI
 */
export interface PatternReviewExplainer {
  whatItCatches: string;
  whyTransient: string;
  affectedAreas: string;
  recommendation: 'likely-approve' | 'needs-investigation' | 'likely-reject';
  concerns: string[];
  summary: string;
}

/**
 * Build prompt for generating pattern review context
 */
function buildReviewContextPrompt(
  pattern: {
    patternType: string;
    patternValue: string;
    category: string;
    confidenceScore: number;
    aiReasoning?: string;
  },
  evidence: AggregatedPatternEvidence
): string {
  const projectsList = Object.entries(evidence.matchesByProject)
    .map(([project, count]) => `- ${project}: ${count} matches`)
    .join('\n');

  const scriptsList = Object.entries(evidence.matchesByScript)
    .map(([script, count]) => `- ${script}: ${count} matches`)
    .join('\n');

  const samplesList = evidence.sampleMessages.slice(0, 5)
    .map((msg, i) => `${i + 1}. "${msg}"`)
    .join('\n');

  return `You are helping a platform admin review a transient error pattern for approval.

## Pattern Details
- **Type**: ${pattern.patternType}
- **Value**: "${pattern.patternValue}"
- **Category**: ${pattern.category}
- **Initial AI Confidence**: ${Math.round(pattern.confidenceScore * 100)}%
${pattern.aiReasoning ? `- **Original Reasoning**: ${pattern.aiReasoning}` : ''}

## Match Evidence (collected over shadow period)
- **Total Matches**: ${evidence.totalMatches}
- **Distinct Days**: ${evidence.distinctDays}
- **First Match**: ${evidence.firstMatchAt ? new Date(evidence.firstMatchAt * 1000).toISOString() : 'N/A'}
- **Last Match**: ${evidence.lastMatchAt ? new Date(evidence.lastMatchAt * 1000).toISOString() : 'N/A'}

### Matches by Project
${projectsList || 'None recorded'}

### Matches by Worker Script
${scriptsList || 'None recorded'}

### Sample Error Messages
${samplesList || 'None available'}

## Your Task
Generate a review context to help the admin decide whether to approve this pattern.

Consider:
1. Does this pattern clearly catch transient errors (quota, rate limits, timeouts)?
2. Is there a risk of over-matching (catching real bugs as transient)?
3. Is there a risk of under-matching (missing similar errors)?
4. Which projects/workers are most affected?

## Response Format (JSON only)
{
  "whatItCatches": "Brief 1-2 sentence description of what errors this pattern catches",
  "whyTransient": "Brief explanation of why these errors are transient and self-resolving",
  "affectedAreas": "Summary of which projects and workers are most affected",
  "recommendation": "likely-approve" | "needs-investigation" | "likely-reject",
  "concerns": ["List of any concerns about approving this pattern"],
  "summary": "One paragraph summary for the admin dashboard"
}

IMPORTANT: Respond with valid JSON only.`;
}

/**
 * Validate review context response
 */
function validateReviewContextResponse(data: unknown): PatternReviewExplainer | null {
  if (!data || typeof data !== 'object') return null;

  const obj = data as Record<string, unknown>;
  if (typeof obj.whatItCatches !== 'string') return null;
  if (typeof obj.whyTransient !== 'string') return null;
  if (typeof obj.affectedAreas !== 'string') return null;
  if (!['likely-approve', 'needs-investigation', 'likely-reject'].includes(obj.recommendation as string)) return null;
  if (!Array.isArray(obj.concerns)) return null;
  if (typeof obj.summary !== 'string') return null;

  return obj as unknown as PatternReviewExplainer;
}

/**
 * Generate AI review context for a pattern ready for human review
 */
export async function generateReviewContext(
  pattern: {
    patternType: string;
    patternValue: string;
    category: string;
    confidenceScore: number;
    aiReasoning?: string;
  },
  evidence: AggregatedPatternEvidence,
  env: { CLOUDFLARE_ACCOUNT_ID: string; PLATFORM_AI_GATEWAY_KEY: string },
  log: Logger
): Promise<PatternReviewExplainer | null> {
  // If no matches, generate a simple context without AI
  if (evidence.totalMatches === 0) {
    return {
      whatItCatches: `Matches ${pattern.patternType} patterns containing "${pattern.patternValue}"`,
      whyTransient: 'No real-world matches recorded during shadow period',
      affectedAreas: 'No data available',
      recommendation: 'needs-investigation',
      concerns: ['No matches recorded - pattern may be too specific or not yet triggered'],
      summary: 'This pattern has not matched any errors during the shadow evaluation period. Consider extending observation or reviewing the pattern logic.',
    };
  }

  const prompt = buildReviewContextPrompt(pattern, evidence);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${DEEPSEEK_GATEWAY_URL}/${env.CLOUDFLARE_ACCOUNT_ID}/platform/deepseek/chat/completions`,
      {
        method: 'POST',
        headers: {
          'cf-aig-authorization': `Bearer ${env.PLATFORM_AI_GATEWAY_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            {
              role: 'system',
              content: 'You are an expert at evaluating transient error patterns for production systems. Help the admin understand this pattern clearly and concisely. Respond with valid JSON only.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.2,
          max_tokens: 800,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error');
      log.error('DeepSeek API error (review context)', new Error(`HTTP ${response.status}`), {
        status: response.status,
        errorBody: errorBody.slice(0, 500),
      });
      // Return a fallback context
      return {
        whatItCatches: `Matches "${pattern.patternValue}" errors in the ${pattern.category} category`,
        whyTransient: 'AI analysis unavailable - review manually',
        affectedAreas: `${Object.keys(evidence.matchesByProject).length} projects, ${Object.keys(evidence.matchesByScript).length} workers`,
        recommendation: 'needs-investigation',
        concerns: ['AI context generation failed - manual review recommended'],
        summary: `Pattern matched ${evidence.totalMatches} times across ${evidence.distinctDays} days. Please review evidence manually.`,
      };
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      log.error('Empty response from DeepSeek (review context)');
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      log.error('Invalid JSON from DeepSeek (review context)', new Error('Parse failed'), {
        content: content.slice(0, 500),
      });
      return null;
    }

    const validated = validateReviewContextResponse(parsed);
    if (!validated) {
      log.error('Review context response failed validation', new Error('Schema mismatch'), {
        parsed: JSON.stringify(parsed).slice(0, 500),
      });
      return null;
    }

    log.info('Generated review context', {
      patternValue: pattern.patternValue,
      recommendation: validated.recommendation,
    });

    return validated;
  } catch (error) {
    log.error('Failed to generate review context', error);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
