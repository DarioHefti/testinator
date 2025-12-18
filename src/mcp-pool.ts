import { experimental_createMCPClient as createMCPClient } from 'ai';
import { Experimental_StdioMCPTransport as StdioMCPTransport } from 'ai/mcp-stdio';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  private initialized = false;

  constructor(headless: boolean = true) {
    this.headless = headless;
    this.baseDir = join(tmpdir(), `testinator-${Date.now()}`);
  }

  /**
   * Initialize the pool with the specified number of MCP clients.
   */
  async initialize(size: number): Promise<void> {
    if (this.initialized) return;

    console.log(`  [MCPPool] Creating ${size} isolated browser instance(s)...`);

    // Create base temp directory
    mkdirSync(this.baseDir, { recursive: true });

    // Create clients in parallel (Chromium is pre-installed via postinstall)
    const createPromises = Array.from({ length: size }, (_, i) => 
      this.createClient(i)
    );

    const clients = await Promise.all(createPromises);
    this.available = clients;
    this.initialized = true;

    console.log(`  [MCPPool] ${size} isolated browser instance(s) ready`);
  }

  /**
   * Create a single isolated MCP client.
   * Each client uses a unique user-data-dir for browser isolation (works on all platforms).
   * Chromium is pre-installed via postinstall script.
   */
  private async createClient(id: number): Promise<PooledClient> {
    const userDataDir = join(this.baseDir, `agent-${id}`);
    mkdirSync(userDataDir, { recursive: true });

    // Build MCP args - each instance gets its own user-data-dir for isolation
    const mcpCliPath = getMcpCliPath();
    const mcpArgs = [mcpCliPath, '--user-data-dir', userDataDir];
    
    if (this.headless) {
      mcpArgs.push('--headless');
    }

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
