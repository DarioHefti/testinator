import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { experimental_createMCPClient as createMCPClient } from 'ai';
import { Experimental_StdioMCPTransport as StdioMCPTransport } from 'ai/mcp-stdio';
import { chromium } from 'playwright';
import { BrowserManager } from './browser-setup.js';
import { runSpecWithClient } from './agent.js';
import type { LLMProvider } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Get the path to the locally installed @playwright/mcp CLI
 */
function getMcpCliPath(): string {
  return join(__dirname, '..', 'node_modules', '@playwright', 'mcp', 'cli.js');
}

/**
 * Result of authentication attempt
 */
export interface AuthResult {
  success: boolean;
  /** Path to storage state JSON file */
  storageStatePath?: string;
  error?: string;
  durationMs: number;
  /** Relative path to the auth screenshot (from reports folder) */
  screenshotPath?: string;
}

/**
 * Run authentication using the AI agent, then extract storage state via Playwright.
 * 
 * Flow:
 * 1. AI agent performs login via Playwright MCP (session saved to userDataDir)
 * 2. After MCP closes, Playwright opens the userDataDir to extract storage state
 * 3. Storage state JSON is passed to all pool workers
 * 
 * @param authSpecPath - Path to AUTH_LOGIN.md
 * @param authSpecContent - Content of AUTH_LOGIN.md  
 * @param baseUrl - Base URL of the application
 * @param provider - LLM provider to use
 * @param model - Model name (optional)
 * @param headless - Run in headless mode
 * @param screenshotPath - Full path to save the auth screenshot
 * @returns AuthResult with storageStatePath on success
 */
export async function runAuthentication(
  authSpecPath: string,
  authSpecContent: string,
  baseUrl: string,
  provider: LLMProvider,
  model?: string,
  headless: boolean = true,
  screenshotPath?: string
): Promise<AuthResult> {
  const startTime = Date.now();
  console.log('🔐 Running authentication setup via AI agent...');
  
  // Create a dedicated userDataDir for auth
  const authUserDataDir = join(tmpdir(), `testinator-auth-${Date.now()}`);
  mkdirSync(authUserDataDir, { recursive: true });
  
  try {
    // Ensure browser is available
    const browserManager = BrowserManager.getInstance();
    await browserManager.ensureBrowsers(!headless);
    const chromiumPath = headless ? browserManager.getChromiumPath() : null;
    
    // Build MCP args with dedicated userDataDir
    const mcpCliPath = getMcpCliPath();
    const mcpArgs = [mcpCliPath, '--user-data-dir', authUserDataDir];
    
    if (headless) {
      mcpArgs.push('--headless');
    }
    if (chromiumPath) {
      mcpArgs.push('--executable-path', chromiumPath);
    }
    
    console.log(`  [Auth] Mode: ${headless ? 'headless' : 'headed'}`);
    
    // Create MCP client for auth
    const transport = new StdioMCPTransport({
      command: process.execPath,
      args: mcpArgs,
    });
    
    const mcpClient = await createMCPClient({ transport });
    
    let agentSuccess = false;
    let agentError = '';
    
    try {
      // Run the auth spec through the AI agent
      const result = await runSpecWithClient(
        mcpClient,
        authSpecContent,
        baseUrl,
        'AUTH_LOGIN.md',
        provider,
        model,
        screenshotPath // capture screenshot of final auth state
      );
      
      agentSuccess = result.success;
      if (!result.success) {
        agentError = result.criteria
          .filter(c => !c.passed)
          .map(c => `${c.criterion}: ${c.reason}`)
          .join(', ') || 'Unknown error';
      }
      
    } finally {
      // Close MCP client - session is persisted in userDataDir
      await mcpClient.close();
    }
    
    if (!agentSuccess) {
      // Clean up on failure
      rmSync(authUserDataDir, { recursive: true, force: true });
      
      // Compute relative screenshot path for report
      const relativeScreenshotPath = screenshotPath && existsSync(screenshotPath) 
        ? `images/${basename(screenshotPath)}` 
        : undefined;
      
      return {
        success: false,
        error: `Login failed: ${agentError}`,
        durationMs: Date.now() - startTime,
        screenshotPath: relativeScreenshotPath,
      };
    }
    
    console.log('  [Auth] ✓ Login successful, extracting storage state...');
    
    // Now use Playwright directly to extract storage state from the userDataDir
    const storageStatePath = await extractStorageState(authUserDataDir, chromiumPath, headless);
    
    // Clean up userDataDir (we have the storage state now)
    rmSync(authUserDataDir, { recursive: true, force: true });
    
    console.log(`  [Auth] ✓ Storage state saved: ${storageStatePath}`);
    
    // Compute relative screenshot path for report
    const relativeScreenshotPath = screenshotPath && existsSync(screenshotPath) 
      ? `images/${basename(screenshotPath)}` 
      : undefined;
    
    return {
      success: true,
      storageStatePath,
      durationMs: Date.now() - startTime,
      screenshotPath: relativeScreenshotPath,
    };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`  [Auth] ✗ Authentication failed: ${errorMessage}`);
    
    // Clean up on failure
    try {
      rmSync(authUserDataDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    
    // Compute relative screenshot path for report (may have been captured before error)
    const relativeScreenshotPath = screenshotPath && existsSync(screenshotPath) 
      ? `images/${basename(screenshotPath)}` 
      : undefined;
    
    return {
      success: false,
      error: errorMessage,
      durationMs: Date.now() - startTime,
      screenshotPath: relativeScreenshotPath,
    };
  }
}

/**
 * Extract storage state from a userDataDir using Playwright directly.
 * Opens the persistent context briefly just to call storageState().
 */
async function extractStorageState(
  userDataDir: string,
  chromiumPath: string | null,
  headless: boolean
): Promise<string> {
  const launchOptions: Parameters<typeof chromium.launchPersistentContext>[1] = {
    headless,
  };
  
  if (chromiumPath) {
    launchOptions.executablePath = chromiumPath;
  }
  
  // Open the persistent context with the existing userDataDir
  const context = await chromium.launchPersistentContext(userDataDir, launchOptions);
  
  try {
    // Extract storage state
    const storageState = await context.storageState();
    
    // Save to a JSON file
    const storageStatePath = join(tmpdir(), `testinator-storage-${Date.now()}.json`);
    writeFileSync(storageStatePath, JSON.stringify(storageState, null, 2));
    
    console.log(`  [Auth] Cookies: ${storageState.cookies.length}, Origins: ${storageState.origins.length}`);
    
    return storageStatePath;
  } finally {
    await context.close();
  }
}
