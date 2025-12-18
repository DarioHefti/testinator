import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page, type BrowserContext } from 'playwright';
import type { LLMProvider } from './types.js';
import { generateText, tool, type Tool } from 'ai';
import { z } from 'zod';
import { getLanguageModel } from './llm-providers.js';
import { normalizeToolsForAzure } from './azure-compat.js';
import { AgentResultSchema, type AgentResult } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
 * Run authentication using Playwright directly (not MCP).
 * This allows us to extract storage state while the browser is still open,
 * ensuring localStorage/cookies are properly captured.
 * 
 * Flow:
 * 1. Launch Playwright browser directly
 * 2. AI agent performs login using custom browser tools
 * 3. Extract storage state while browser is still open (captures localStorage!)
 * 4. Pass storage state to all MCP pool workers
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
  console.log('🔐 Running authentication setup...');
  console.log(`  [Auth] Mode: ${headless ? 'headless' : 'headed'}`);
  
  // Launch browser directly with Playwright
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  // Storage state path will be set when AI calls save_session
  let savedSessionPath: string | null = null;
  
  try {
    // Create browser tools including the save_session tool
    const browserTools = createAuthBrowserTools(page, context, (path) => {
      savedSessionPath = path;
    });
    
    const languageModel = getLanguageModel(provider, model);
    
    let allTools: Record<string, Tool> = browserTools;
    if (provider === 'azure') {
      allTools = normalizeToolsForAzure(allTools);
    }
    
    console.log(`  [Auth] Starting agent with ${Object.keys(allTools).length} tools`);
    
    // Build auth-specific system prompt
    const systemPrompt = buildAuthPrompt(baseUrl);
    
    // Run the AI agent
    const result = await generateText({
      model: languageModel,
      system: systemPrompt,
      prompt: authSpecContent,
      tools: allTools,
      maxSteps: 30,
      onStepFinish: ({ toolCalls }) => {
        if (toolCalls && toolCalls.length > 0) {
          const toolNames = toolCalls.map(tc => tc.toolName).join(', ');
          console.log(`  [Auth] Tools: ${toolNames}`);
        }
      },
    });
    
    // Take screenshot
    if (screenshotPath) {
      try {
        mkdirSync(dirname(screenshotPath), { recursive: true });
        await page.screenshot({ path: screenshotPath, type: 'jpeg', quality: 80 });
      } catch { /* ignore */ }
    }
    
    // Check if session was saved
    if (!savedSessionPath) {
      return {
        success: false,
        error: 'Login failed: AI did not call save_session after login',
        durationMs: Date.now() - startTime,
        screenshotPath: screenshotPath && existsSync(screenshotPath) 
          ? `images/${basename(screenshotPath)}` : undefined,
      };
    }
    
    console.log(`  [Auth] ✓ Session saved: ${savedSessionPath}`);
    
    return {
      success: true,
      storageStatePath: savedSessionPath,
      durationMs: Date.now() - startTime,
      screenshotPath: screenshotPath && existsSync(screenshotPath) 
        ? `images/${basename(screenshotPath)}` : undefined,
    };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`  [Auth] ✗ Authentication failed: ${errorMessage}`);
    
    return {
      success: false,
      error: errorMessage,
      durationMs: Date.now() - startTime,
      screenshotPath: screenshotPath && existsSync(screenshotPath) 
        ? `images/${basename(screenshotPath)}` : undefined,
    };
  } finally {
    await browser.close();
  }
}

/**
 * Build system prompt specifically for authentication.
 */
function buildAuthPrompt(baseUrl: string): string {
  return `You are performing a login/authentication flow on a web application.

## Configuration
- Base URL: ${baseUrl}

## Your Task
1. Read the login instructions provided
2. Navigate to the application and perform the login steps
3. After successful login, you MUST call the 'save_session' tool to capture the authentication state
4. This is critical - without calling save_session, the login won't be persisted for other tests

## Important
- Use browser_navigate to go to URLs
- Use browser_type to fill in form fields (use labels, placeholders, or CSS selectors)
- Use browser_click to click buttons and links
- Use browser_snapshot to see the current page state if needed
- After login succeeds (you see logged-in state), IMMEDIATELY call save_session
- Do NOT call report_result - just call save_session when login is complete`;
}

/**
 * Create browser tools for auth flow.
 * General-purpose tools that work with any login page.
 */
function createAuthBrowserTools(
  page: Page, 
  context: BrowserContext,
  onSessionSaved: (path: string) => void
): Record<string, Tool> {
  return {
    browser_navigate: tool({
      description: 'Navigate to a URL',
      parameters: z.object({ url: z.string() }),
      execute: async ({ url }) => {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        return { success: true, url: page.url(), title: await page.title() };
      },
    }),
    
    browser_snapshot: tool({
      description: 'Get current page content to see what is on screen',
      parameters: z.object({}),
      execute: async () => {
        const title = await page.title();
        const url = page.url();
        const text = await page.locator('body').innerText();
        return { title, url, content: text.slice(0, 4000) };
      },
    }),
    
    browser_click: tool({
      description: 'Click on an element. Pass button text like "Login", "Submit", or a CSS selector',
      parameters: z.object({
        target: z.string().describe('Button text, link text, or CSS selector'),
      }),
      execute: async ({ target }) => {
        try {
          // Try as CSS selector first
          if (target.startsWith('#') || target.startsWith('.') || target.startsWith('[')) {
            const el = await page.$(target);
            if (el) {
              await el.click();
              return { success: true, clicked: target };
            }
          }
          
          // Try as button
          const button = page.getByRole('button', { name: target });
          if (await button.count() > 0) {
            await button.first().click();
            return { success: true, clicked: `button: ${target}` };
          }
          
          // Try as link
          const link = page.getByRole('link', { name: target });
          if (await link.count() > 0) {
            await link.first().click();
            return { success: true, clicked: `link: ${target}` };
          }
          
          // Try by text
          const textEl = page.getByText(target, { exact: false });
          if (await textEl.count() > 0) {
            await textEl.first().click();
            return { success: true, clicked: `text: ${target}` };
          }
          
          return { success: false, error: `Could not find: ${target}` };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      },
    }),
    
    browser_type: tool({
      description: 'Type text into an input field. Use the field label, placeholder, or CSS selector',
      parameters: z.object({
        field: z.string().describe('Field label, placeholder text, or CSS selector'),
        text: z.string().describe('Text to type'),
      }),
      execute: async ({ field, text }) => {
        try {
          // Try as CSS selector
          if (field.startsWith('#') || field.startsWith('.') || field.startsWith('[')) {
            const el = await page.$(field);
            if (el) {
              await el.fill(text);
              return { success: true, field };
            }
          }
          
          // Try by label
          const byLabel = page.getByLabel(field, { exact: false });
          if (await byLabel.count() > 0) {
            await byLabel.first().fill(text);
            return { success: true, field: `label: ${field}` };
          }
          
          // Try by placeholder
          const byPlaceholder = page.getByPlaceholder(field, { exact: false });
          if (await byPlaceholder.count() > 0) {
            await byPlaceholder.first().fill(text);
            return { success: true, field: `placeholder: ${field}` };
          }
          
          return { success: false, error: `Could not find field: ${field}` };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      },
    }),
    
    browser_wait: tool({
      description: 'Wait for a short time in seconds (useful after clicking login)',
      parameters: z.object({ seconds: z.number() }),
      execute: async ({ seconds }) => {
        await page.waitForTimeout(seconds * 1000);
        return { success: true };
      },
    }),
    
    save_session: tool({
      description: 'IMPORTANT: Call this after login is successful to save cookies and localStorage for other tests. This captures the authenticated session.',
      parameters: z.object({}),
      execute: async () => {
        try {
          // Wait a bit for any background auth requests to finish
          await page.waitForTimeout(1000);
          
          // Get Playwright's storage state (includes cookies)
          const storageState = await context.storageState();
          
          // Also get localStorage directly from the page
          const localStorageData = await page.evaluate(() => {
            const data: Record<string, string> = {};
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              if (key) data[key] = localStorage.getItem(key) || '';
            }
            return data;
          });
          
          // Merge localStorage into origins
          const currentUrl = new URL(page.url());
          const origin = currentUrl.origin;
          
          let originEntry = storageState.origins.find(o => o.origin === origin);
          if (!originEntry) {
            originEntry = { origin, localStorage: [] };
            storageState.origins.push(originEntry);
          }
          
          for (const [key, value] of Object.entries(localStorageData)) {
            if (!originEntry.localStorage.some(item => item.name === key)) {
              originEntry.localStorage.push({ name: key, value });
            }
          }
          
          // Save to file
          const storagePath = join(tmpdir(), `testinator-session-${Date.now()}.json`);
          writeFileSync(storagePath, JSON.stringify(storageState, null, 2));
          
          onSessionSaved(storagePath);
          
          return { 
            success: true, 
            cookies: storageState.cookies.length,
            localStorage: originEntry.localStorage.length,
            message: 'Session saved successfully.'
          };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      },
    }),
  };
}
