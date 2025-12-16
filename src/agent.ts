import { generateText, experimental_createMCPClient as createMCPClient, tool, type LanguageModel, type CoreTool } from 'ai';
import { Experimental_StdioMCPTransport as StdioMCPTransport } from 'ai/mcp-stdio';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { spawn, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { AgentResultSchema, type AgentResult, type LLMProvider, DEFAULT_MODELS } from './types.js';

// Track if we've already ensured browsers are installed this session
let browsersEnsured = false;
let chromiumPath: string | null = null;

/**
 * Find system-installed Chromium/Chrome browser.
 * Returns the path if found, null otherwise.
 */
function findSystemChromium(): string | null {
  const platform = process.platform;
  
  const candidates: string[] = [];
  
  if (platform === 'win32') {
    // Windows paths
    candidates.push(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      'C:\\Program Files\\Chromium\\Application\\chrome.exe',
      `${process.env.LOCALAPPDATA}\\Chromium\\Application\\chrome.exe`,
    );
  } else if (platform === 'darwin') {
    // macOS paths
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      `${process.env.HOME}/Applications/Chromium.app/Contents/MacOS/Chromium`,
    );
  } else {
    // Linux paths
    candidates.push(
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/snap/bin/chromium',
      '/var/lib/flatpak/exports/bin/com.github.nickvergessen.chromium',
    );
    
    // Also try 'which' command on Linux/macOS
    try {
      const result = spawnSync('which', ['chromium'], { encoding: 'utf-8' });
      if (result.status === 0 && result.stdout.trim()) {
        candidates.unshift(result.stdout.trim());
      }
    } catch {}
    
    try {
      const result = spawnSync('which', ['chromium-browser'], { encoding: 'utf-8' });
      if (result.status === 0 && result.stdout.trim()) {
        candidates.unshift(result.stdout.trim());
      }
    } catch {}
    
    try {
      const result = spawnSync('which', ['google-chrome'], { encoding: 'utf-8' });
      if (result.status === 0 && result.stdout.trim()) {
        candidates.unshift(result.stdout.trim());
      }
    } catch {}
  }
  
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  
  return null;
}

/**
 * Ensure Playwright browsers are available.
 * First tries to find system Chromium, then falls back to installing Playwright's bundled browser.
 * Works across Windows, macOS, and Linux.
 */
async function ensurePlaywrightBrowsers(): Promise<void> {
  if (browsersEnsured) {
    return;
  }

  // First, check for system Chromium
  console.log('  [Playwright] Checking for browser...');
  chromiumPath = findSystemChromium();
  
  if (chromiumPath) {
    console.log(`  [Playwright] Found system browser: ${chromiumPath}`);
    browsersEnsured = true;
    return;
  }
  
  // No system browser found, install Playwright's bundled one
  console.log('  [Playwright] No system browser found, installing Chromium...');
  
  const isWindows = process.platform === 'win32';
  
  return new Promise((resolve) => {
    const proc = spawn(
      isWindows ? 'cmd.exe' : 'npx',
      isWindows 
        ? ['/c', 'npx', 'playwright', 'install', 'chromium']
        : ['playwright', 'install', 'chromium'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      }
    );

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        browsersEnsured = true;
        if (stdout.includes('Downloading') || stdout.includes('Installing')) {
          console.log('  [Playwright] Browser installed successfully');
        } else {
          console.log('  [Playwright] Browser ready');
        }
        resolve();
      } else {
        console.warn(`  [Playwright] Browser install returned code ${code}`);
        if (stderr) {
          console.warn(`  [Playwright] ${stderr.slice(0, 200)}`);
        }
        browsersEnsured = true;
        resolve();
      }
    });

    proc.on('error', (err) => {
      console.warn(`  [Playwright] Could not run browser install: ${err.message}`);
      browsersEnsured = true;
      resolve();
    });
  });
}

/**
 * Normalize tool schemas for Azure OpenAI compatibility.
 * Azure requires all properties to be in the 'required' array.
 */
function normalizeToolsForAzure(tools: Record<string, CoreTool>): Record<string, CoreTool> {
  for (const toolDef of Object.values(tools)) {
    const tool = toolDef as Record<string, unknown>;
    
    // Try different possible schema locations
    if (tool.parameters) {
      const params = tool.parameters as Record<string, unknown>;
      
      // Check for jsonSchema wrapper (MCP tools)
      if ('jsonSchema' in params && params.jsonSchema) {
        normalizeSchema(params.jsonSchema as Record<string, unknown>);
      }
      // Check for direct schema properties
      else if (params.type === 'object' && params.properties) {
        normalizeSchema(params);
      }
    }
  }
  
  return tools;
}

/**
 * Recursively normalize a JSON schema to ensure all properties are required.
 */
function normalizeSchema(schema: Record<string, unknown>): void {
  if (!schema || typeof schema !== 'object') return;
  
  if (schema.type === 'object' && schema.properties) {
    const props = schema.properties as Record<string, unknown>;
    const propNames = Object.keys(props);
    
    // Make all properties required
    if (propNames.length > 0) {
      schema.required = propNames;
    }
    
    // Recursively normalize nested objects
    for (const prop of Object.values(props)) {
      if (prop && typeof prop === 'object') {
        normalizeSchema(prop as Record<string, unknown>);
      }
    }
  }
  
  // Handle arrays with items
  if (schema.type === 'array' && schema.items && typeof schema.items === 'object') {
    normalizeSchema(schema.items as Record<string, unknown>);
  }
}

/**
 * Get the language model instance based on provider and model name
 */
function getLanguageModel(provider: LLMProvider, model?: string): LanguageModel {
  const modelName = model || DEFAULT_MODELS[provider];

  switch (provider) {
    case 'openai': {
      const openai = createOpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
      return openai(modelName);
    }
    case 'anthropic': {
      const anthropic = createAnthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
      });
      return anthropic(modelName);
    }
    case 'azure': {
      const resourceOrUrl = process.env.AZURE_OPENAI_BASE_URL || process.env.AZURE_OPENAI_RESOURCE_NAME || '';
      
      // Extract resource name from full URL if provided (e.g., https://my-resource.openai.azure.com -> my-resource)
      let resourceName: string;
      if (resourceOrUrl.includes('.openai.azure.com') || resourceOrUrl.includes('.cognitiveservices.azure.com')) {
        const match = resourceOrUrl.match(/https?:\/\/([^.]+)\./);
        resourceName = match ? match[1] : resourceOrUrl;
      } else {
        resourceName = resourceOrUrl;
      }
      
      console.log(`    [Azure] Using resource: ${resourceName}, deployment: ${modelName}`);
      
      const azure = createAzure({
        apiKey: process.env.AZURE_OPENAI_API_KEY,
        resourceName,
      });
      return azure(modelName);
    }
    case 'google': {
      const google = createGoogleGenerativeAI({
        apiKey: process.env.GOOGLE_API_KEY,
      });
      return google(modelName);
    }
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

/**
 * Quick connection check to verify LLM is accessible
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
 * Build the system prompt for the E2E testing agent
 */
function buildSystemPrompt(baseUrl: string, specName: string): string {
  return `You are an automated E2E test runner. Your job is to execute end-to-end tests based on markdown specifications.

## Configuration
- Application Base URL: ${baseUrl}
- Current Test Spec: ${specName}

## Your Task
1. Read and understand the markdown test specification provided as input
2. Use the Playwright browser tools to:
   - Navigate to the appropriate pages (starting from the base URL)
   - Interact with UI elements as described in the spec
   - Verify expected behaviors and states
3. Determine if the test PASSES or FAILS based on whether all requirements are met

## Guidelines
- Start by navigating to the base URL unless the spec indicates otherwise
- Take screenshots when useful for verification
- Be thorough but efficient - verify what the spec asks for
- If an element cannot be found or an action fails, the test should FAIL
- If all specified behaviors work as expected, the test should PASS

## Output
When you have completed all checks, call the 'report_result' tool with:
- success: true if ALL requirements in the spec are met, false otherwise
- details: A clear summary of what was checked and any failures encountered

Be precise and factual in your details. Include specific element names, URLs visited, and exact error messages when tests fail.`;
}

/**
 * Run a single test spec through the agent
 */
export async function runSpec(
  markdown: string,
  baseUrl: string,
  specName: string,
  provider: LLMProvider = 'openai',
  model?: string
): Promise<AgentResult> {
  // Ensure Playwright browsers are installed before proceeding
  await ensurePlaywrightBrowsers();

  // Create MCP transport for Playwright
  // On Windows, we need to spawn via cmd.exe to properly resolve npx
  const isWindows = process.platform === 'win32';
  
  // Build MCP args - include --executable-path if we found a system browser
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
