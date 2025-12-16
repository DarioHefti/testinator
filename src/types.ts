import { z } from 'zod';

/**
 * Schema for the structured output from the AI agent
 */
export const AgentResultSchema = z.object({
  success: z.boolean().describe('Whether the E2E test spec passed or failed'),
  details: z.string().describe('Explanation of checks performed and any failures encountered'),
});

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
