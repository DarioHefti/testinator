import { generateText, experimental_createMCPClient as createMCPClient, tool, type CoreTool } from 'ai';
import { Experimental_StdioMCPTransport as StdioMCPTransport } from 'ai/mcp-stdio';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentResultSchema, type AgentResult, type LLMProvider } from './types.js';
import { BrowserManager } from './browser-setup.js';
import { getLanguageModel } from './llm-providers.js';
import { normalizeToolsForAzure } from './azure-compat.js';
import { buildSystemPrompt } from './prompt-builder.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

type MCPClient = Awaited<ReturnType<typeof createMCPClient>>;

/**
 * Get the path to the locally installed @playwright/mcp CLI
 */
function getMcpCliPath(): string {
  // In dist/, go up to project root then into node_modules
  return join(__dirname, '..', 'node_modules', '@playwright', 'mcp', 'cli.js');
}

/**
 * Quick connection check to verify LLM is accessible.
 */
export async function checkLLMConnection(provider: LLMProvider, model?: string): Promise<void> {
  console.log(`Checking ${provider} connection...`);
  
  try {
    const languageModel = getLanguageModel(provider, model);
    const { text } = await generateText({
      model: languageModel,
      prompt: 'Reply with just "ok"',
      maxTokens: 10,
    });
    console.log(`✓ ${provider} connection OK (response: "${text.trim()}")\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${provider} connection failed: ${message}`);
  }
}

/**
 * Run a single test spec through the agent (creates its own MCP client).
 * Use this for sequential execution.
 */
export async function runSpec(
  markdown: string,
  baseUrl: string,
  specName: string,
  provider: LLMProvider = 'openai',
  model?: string,
  headless: boolean = true
): Promise<AgentResult> {
  // Ensure Playwright browsers are available
  // For headed mode, we need Playwright's bundled browser (better Wayland support)
  const browserManager = BrowserManager.getInstance();
  await browserManager.ensureBrowsers(!headless);

  // Build MCP args using locally installed @playwright/mcp
  const chromiumPath = headless ? browserManager.getChromiumPath() : null;
  const mcpCliPath = getMcpCliPath();
  const mcpArgs = [mcpCliPath];
  if (headless) {
    mcpArgs.push('--headless');
  }
  if (chromiumPath) {
    mcpArgs.push('--executable-path', chromiumPath);
  }

  console.log(`  [Playwright] Mode: ${headless ? 'headless' : 'headed'}`);
  
  const transport = new StdioMCPTransport({
    command: process.execPath, // Use current Node.js executable
    args: mcpArgs,
  });

  // Create MCP client
  const mcpClient = await createMCPClient({
    transport,
  });

  try {
    return await runSpecWithClient(mcpClient, markdown, baseUrl, specName, provider, model);
  } finally {
    // Close the MCP client
    await mcpClient.close();
  }
}

/**
 * Run a single test spec using an existing MCP client.
 * Use this with MCPPool for parallel execution.
 */
export async function runSpecWithClient(
  mcpClient: MCPClient,
  markdown: string,
  baseUrl: string,
  specName: string,
  provider: LLMProvider = 'openai',
  model?: string
): Promise<AgentResult> {
  // Get the language model based on provider
  const languageModel = getLanguageModel(provider, model);

  // Get tools from MCP server (Playwright)
  const mcpTools = await mcpClient.tools();

  // Create the result reporting tool
  const reportResultTool = tool({
    description: 'Report the final test result after completing all checks',
    parameters: AgentResultSchema,
    execute: async (params) => {
      return JSON.stringify(params);
    },
  });

  // Combine MCP tools with our reporting tool
  let allTools: Record<string, CoreTool> = {
    ...mcpTools,
    report_result: reportResultTool,
  };
  
  // Azure OpenAI has stricter schema requirements - normalize tools
  if (provider === 'azure') {
    allTools = normalizeToolsForAzure(allTools);
  }

  // Run the agent with all tools
  console.log(`    [LLM] Starting agent with ${Object.keys(allTools).length} tools available`);
  const result = await generateText({
    model: languageModel,
    system: buildSystemPrompt(baseUrl, specName),
    prompt: markdown,
    tools: allTools,
    maxSteps: 50,
    onStepFinish: ({ stepType, toolCalls, text }) => {
      if (toolCalls && toolCalls.length > 0) {
        const toolNames = toolCalls.map(tc => tc.toolName).join(', ');
        console.log(`    [LLM] Step: ${stepType} → Tools: ${toolNames}`);
      } else if (text) {
        console.log(`    [LLM] Step: ${stepType} → Response: ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`);
      }
    },
  });
  console.log(`    [LLM] Completed in ${result.steps.length} steps`);

  // Find the report_result tool call in the steps
  for (const step of result.steps) {
    if (step.toolCalls) {
      for (const toolCall of step.toolCalls) {
        if (toolCall.toolName === 'report_result') {
          return toolCall.args as AgentResult;
        }
      }
    }
  }

  // If no explicit result was reported, try to parse from text
  if (result.text) {
    // Check if the response indicates success or failure
    const lowerText = result.text.toLowerCase();
    const success = lowerText.includes('pass') && !lowerText.includes('fail');
    return {
      success,
      isToolingError: false,
      toolingErrorMessage: '',
      criteria: [{ criterion: 'Test execution', passed: success, reason: success ? 'Completed' : 'See details' }],
    };
  }

  return {
    success: false,
    isToolingError: true,
    toolingErrorMessage: 'Agent did not produce a test result',
    criteria: [],
  };
}
