import { generateText, experimental_createMCPClient as createMCPClient, tool, type CoreTool } from 'ai';
import { Experimental_StdioMCPTransport as StdioMCPTransport } from 'ai/mcp-stdio';
import { AgentResultSchema, type AgentResult, type LLMProvider } from './types.js';
import { BrowserManager } from './browser-setup.js';
import { getLanguageModel } from './llm-providers.js';
import { normalizeToolsForAzure } from './azure-compat.js';
import { buildSystemPrompt } from './prompt-builder.js';

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
 * Run a single test spec through the agent.
 */
export async function runSpec(
  markdown: string,
  baseUrl: string,
  specName: string,
  provider: LLMProvider = 'openai',
  model?: string
): Promise<AgentResult> {
  // Ensure Playwright browsers are available
  const browserManager = BrowserManager.getInstance();
  await browserManager.ensureBrowsers();

  // Create MCP transport for Playwright
  // On Windows, we need to spawn via cmd.exe to properly resolve npx
  const isWindows = process.platform === 'win32';
  
  // Build MCP args - include --executable-path if we found a system browser
  const chromiumPath = browserManager.getChromiumPath();
  const mcpArgs = ['@playwright/mcp@latest', '--headless'];
  if (chromiumPath) {
    mcpArgs.push('--executable-path', chromiumPath);
  }
  
  const transport = new StdioMCPTransport({
    command: isWindows ? 'cmd.exe' : 'npx',
    args: isWindows 
      ? ['/c', 'npx', ...mcpArgs]
      : mcpArgs,
  });

  // Create MCP client
  const mcpClient = await createMCPClient({
    transport,
  });

  try {
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
    
    // Debug: Log tool structure to understand format
    if (provider === 'azure') {
      const sampleTool = Object.entries(mcpTools)[0];
      if (sampleTool) {
        console.log(`    [Debug] Sample MCP tool "${sampleTool[0]}" structure:`, 
          JSON.stringify(sampleTool[1], (key, value) => {
            // Skip functions and complex objects for logging
            if (typeof value === 'function') return '[Function]';
            if (key === 'execute') return '[Function]';
            return value;
          }, 2).slice(0, 500));
      }
      
      // Azure OpenAI has stricter schema requirements - normalize tools
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
        details: result.text,
      };
    }

    return {
      success: false,
      details: 'Agent did not produce a test result',
    };
  } finally {
    // Close the MCP client
    await mcpClient.close();
  }
}
