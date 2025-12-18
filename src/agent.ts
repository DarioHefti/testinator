import { generateText, experimental_createMCPClient as createMCPClient, tool, type Tool } from 'ai';
import { Experimental_StdioMCPTransport as StdioMCPTransport } from 'ai/mcp-stdio';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { AgentResultSchema, type AgentResult, type LLMProvider } from './types.js';
import { getLanguageModel } from './llm-providers.js';
import { normalizeToolsForAzure } from './azure-compat.js';
import { buildSystemPrompt } from './prompt-builder.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

type MCPClient = Awaited<ReturnType<typeof createMCPClient>>;

type McpImageContentPart = {
  type: 'image';
  data: string; // base64
  mimeType?: string;
};

function extractFirstImageBase64(result: unknown): { base64: string; mimeType?: string } | undefined {
  if (!result || typeof result !== 'object') return undefined;

  // Check for direct content array (standard MCP)
  let content = (result as { content?: unknown }).content;

  // Check for nested result object (e.g. { result: { content: ... } }) which some adapters might produce
  if (!content && (result as { result?: { content?: unknown } }).result) {
    content = (result as { result?: { content?: unknown } }).result?.content;
  }

  if (!Array.isArray(content)) return undefined;

  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as Partial<McpImageContentPart>;
    if (p.type === 'image' && typeof p.data === 'string') {
      return { base64: p.data, mimeType: typeof p.mimeType === 'string' ? p.mimeType : undefined };
    }
  }
  return undefined;
}

async function captureFinalScreenshotIfRequested(
  mcpTools: Record<string, Tool>,
  screenshotPath?: string
): Promise<boolean> {
  if (!screenshotPath) return false;
  
  const toolName = 'browser_take_screenshot';
  const screenshotTool = mcpTools[toolName];
  
  if (!screenshotTool?.execute) return false;

  try {
    // Ensure destination folder exists before writing.
    mkdirSync(dirname(screenshotPath), { recursive: true });

    const toolResult = await screenshotTool.execute(
      {},
      // This tool is being invoked by the runner (not the model), so we provide a minimal
      // execution context for the AI SDK tool interface.
      { toolCallId: 'final_screenshot', messages: [] }
    );
    
    const image = extractFirstImageBase64(toolResult);
    if (!image) return false;

    writeFileSync(screenshotPath, Buffer.from(image.base64, 'base64'));
    return true;
  } catch (error) {
    return false;
  }
}

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
  headless: boolean = true,
  screenshotPath?: string
): Promise<AgentResult> {
  // Build MCP args using locally installed @playwright/mcp
  // Chromium is pre-installed via postinstall script
  const mcpCliPath = getMcpCliPath();
  const mcpArgs = [mcpCliPath];
  if (headless) {
    mcpArgs.push('--headless');
  }
  
  const transport = new StdioMCPTransport({
    command: process.execPath, // Use current Node.js executable
    args: mcpArgs,
  });

  // Create MCP client
  const mcpClient = await createMCPClient({
    transport,
  });

  try {
    return await runSpecWithClient(mcpClient, markdown, baseUrl, specName, provider, model, screenshotPath);
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
  model?: string,
  screenshotPath?: string
): Promise<AgentResult> {
  // Get the language model based on provider
  const languageModel = getLanguageModel(provider, model);

  // Get tools from MCP server (Playwright)
  const mcpTools = await mcpClient.tools();
  let finalScreenshotCaptured = false;

  // Create the result reporting tool
  const reportResultTool = tool({
    description: 'Report the final test result after completing all checks',
    parameters: AgentResultSchema,
    execute: async (params) => {
      // Capture final state right before reporting (best chance the page is still open).
      try {
        finalScreenshotCaptured = await captureFinalScreenshotIfRequested(mcpTools, screenshotPath);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.warn(`    [Playwright] Final screenshot capture failed: ${message}`);
      }
      return JSON.stringify(params);
    },
  });

  // Combine MCP tools with our reporting tool
  let allTools: Record<string, Tool> = {
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
    system: buildSystemPrompt(baseUrl, specName, screenshotPath),
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

  // Fallback: if the model never called report_result, still try to capture a final screenshot.
  if (!finalScreenshotCaptured) {
    try {
      await captureFinalScreenshotIfRequested(mcpTools, screenshotPath);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`    [Playwright] Final screenshot capture failed: ${message}`);
    }
  }

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
