import { experimental_createMCPClient as createMCPClient } from 'ai';
import { Experimental_StdioMCPTransport as StdioMCPTransport } from 'ai/mcp-stdio';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserManager } from './browser-setup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Get the path to the locally installed @playwright/mcp CLI
 */
function getMcpCliPath(): string {
  // In dist/, go up to project root then into node_modules
  return join(__dirname, '..', 'node_modules', '@playwright', 'mcp', 'cli.js');
}

type MCPClient = Awaited<ReturnType<typeof createMCPClient>>;

interface PooledClient {
  client: MCPClient;
  id: number;
  userDataDir: string;
}

/**
 * Pool of isolated Playwright MCP clients for parallel test execution.
 * Each client has its own browser instance with separate user data directory.
 */
export class MCPPool {
  private available: PooledClient[] = [];
  private inUse: Set<number> = new Set();
  private baseDir: string;
  private headless: boolean;
  private storageStatePath: string | undefined;
  private initialized = false;

  /**
   * @param headless - Run browsers in headless mode
   * @param storageStatePath - Path to storage state JSON for authenticated sessions
   */
  constructor(headless: boolean = true, storageStatePath?: string) {
    this.headless = headless;
    this.storageStatePath = storageStatePath;
    this.baseDir = join(tmpdir(), `testinator-${Date.now()}`);
  }

  /**
   * Initialize the pool with the specified number of MCP clients.
   */
  async initialize(size: number): Promise<void> {
    if (this.initialized) return;

    console.log(`  [MCPPool] Creating ${size} isolated browser instance(s)...`);
    if (this.storageStatePath) {
      console.log(`  [MCPPool] Using authenticated session from: ${this.storageStatePath}`);
    }

    // Ensure browsers are available
    const browserManager = BrowserManager.getInstance();
    await browserManager.ensureBrowsers(!this.headless);
    const chromiumPath = this.headless ? browserManager.getChromiumPath() : null;

    // Create base temp directory
    mkdirSync(this.baseDir, { recursive: true });

    // Create clients in parallel
    const createPromises = Array.from({ length: size }, (_, i) => 
      this.createClient(i, chromiumPath)
    );

    const clients = await Promise.all(createPromises);
    this.available = clients;
    this.initialized = true;

    console.log(`  [MCPPool] ${size} isolated browser instance(s) ready`);
  }

  /**
   * Create a single isolated MCP client.
   * Uses isolated mode (in-memory profile) to guarantee no lock conflicts between parallel workers.
   * Storage state is passed via config file when authentication is needed.
   */
  private async createClient(id: number, chromiumPath: string | null): Promise<PooledClient> {
    const userDataDir = join(this.baseDir, `agent-${id}`);
    mkdirSync(userDataDir, { recursive: true });

    // Build MCP args
    const mcpCliPath = getMcpCliPath();
    const mcpArgs = [mcpCliPath];
    
    if (this.headless) {
      mcpArgs.push('--headless');
    }
    if (chromiumPath) {
      mcpArgs.push('--executable-path', chromiumPath);
    }
    
    // Always use config file with isolated: true for in-memory profiles (no disk locks!)
    // This guarantees parallel workers don't conflict
    const storageState = this.storageStatePath 
      ? JSON.parse(readFileSync(this.storageStatePath, 'utf-8')) 
      : undefined;
    
    const config = {
      browser: {
        isolated: true, // Keep profile in memory, no disk persistence
        ...(storageState ? { contextOptions: { storageState } } : {}),
      },
    };
    
    const configPath = join(userDataDir, 'mcp-config.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    mcpArgs.push('--config', configPath);

    const transport = new StdioMCPTransport({
      command: process.execPath, // Use current Node.js executable
      args: mcpArgs,
    });

    const client = await createMCPClient({ transport });

    return { client, id, userDataDir };
  }

  /**
   * Acquire a client from the pool. Blocks until one is available.
   */
  async acquire(): Promise<{ client: MCPClient; id: number }> {
    // Wait for an available client
    while (this.available.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    const pooled = this.available.shift()!;
    this.inUse.add(pooled.id);
    return { client: pooled.client, id: pooled.id };
  }

  /**
   * Release a client back to the pool.
   */
  release(id: number, client: MCPClient): void {
    if (this.inUse.has(id)) {
      this.inUse.delete(id);
      // Find the userDataDir for this client
      const userDataDir = join(this.baseDir, `agent-${id}`);
      this.available.push({ client, id, userDataDir });
    }
  }

  /**
   * Close all clients and clean up resources.
   */
  async close(): Promise<void> {
    // Close all available clients
    for (const pooled of this.available) {
      try {
        await pooled.client.close();
      } catch {
        // Ignore close errors
      }
    }
    this.available = [];

    // Clean up temp directories
    try {
      rmSync(this.baseDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    this.initialized = false;
  }

  /**
   * Get the number of available clients.
   */
  get availableCount(): number {
    return this.available.length;
  }

  /**
   * Get the total pool size.
   */
  get totalSize(): number {
    return this.available.length + this.inUse.size;
  }
}
