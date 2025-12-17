import { z } from 'zod';

/**
 * Schema for individual acceptance criteria result
 */
export const CriterionResultSchema = z.object({
  criterion: z.string().describe('Short name of the acceptance criterion'),
  passed: z.boolean().describe('Whether this criterion passed'),
  reason: z.string().describe('Brief reason why it passed or failed (max 10 words)'),
});

/**
 * Schema for the structured output from the AI agent
 */
export const AgentResultSchema = z.object({
  success: z.boolean().describe('Whether the E2E test spec passed or failed'),
  isToolingError: z.boolean().describe('True if failure is due to tooling/infrastructure issues (browser errors, network issues, timeouts), not actual test failure'),
  toolingErrorMessage: z.string().describe('Brief description of tooling error if isToolingError is true, otherwise empty string'),
  criteria: z.array(CriterionResultSchema).describe('Results for each acceptance criterion'),
});

export type CriterionResult = z.infer<typeof CriterionResultSchema>;
export type AgentResult = z.infer<typeof AgentResultSchema>;

/**
 * Result for a single test spec file
 */
export interface TestResult {
  specName: string;
  specPath: string;
  success: boolean;
  details: string;
  durationMs: number;
  isToolingError?: boolean;
  toolingErrorMessage?: string;
  criteria?: CriterionResult[];
  screenshotPath?: string;
}

/**
 * Summary of all test runs
 */
export interface RunSummary {
  results: TestResult[];
  allPassed: boolean;
  totalDurationMs: number;
  timestamp: string;
}

/**
 * Supported LLM providers
 */
export type LLMProvider = 'openai' | 'anthropic' | 'azure' | 'google';

/**
 * Configuration for the agent
 */
export interface AgentConfig {
  baseUrl: string;
  specName: string;
  provider: LLMProvider;
  model: string;
  headless: boolean;
}

/**
 * Default models for each provider
 */
export const DEFAULT_MODELS: Record<LLMProvider, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-20250514',
  azure: 'gpt-4o',
  google: 'gemini-1.5-pro',
};
