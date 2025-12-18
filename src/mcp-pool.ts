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
  return join(__dirname, '..', 'node_modules', '@playwright', 'mcp', 'cli.js');
}

type MCPClient = Awaited<ReturnType<typeof createMCPClient>>;

interface PooledClient {
  client: MCPClient;
  id: number;
}

/**
 * Pool of Playwright MCP clients for parallel test execution.
 * Each client runs in an isolated browser context with injected auth state.
 */
export class MCPPool {
  private available: PooledClient[] = [];
  private inUse: Set<number> = new Set();
  private baseDir: string;
  private headless: boolean;
  private storageStatePath: string | undefined;
  private initialized = false;

  constructor(headless: boolean = true, storageStatePath?: string) {
    this.headless = headless;
    this.storageStatePath = storageStatePath;
    this.baseDir = join(tmpdir(), `testinator-pool-${Date.now()}`);
  }

  /**
   * Initialize the pool with the specified number of MCP clients.
   */
  async initialize(size: number): Promise<void> {
    if (this.initialized) return;

    console.log(`  [MCPPool] Creating ${size} browser instance(s)...`);
    if (this.storageStatePath) {
      console.log(`  [MCPPool] Using authenticated session from: ${this.storageStatePath}`);
    }

    mkdirSync(this.baseDir, { recursive: true });

    // Create clients sequentially with delay to avoid port conflicts
    const clients: PooledClient[] = [];
    for (let i = 0; i < size; i++) {
      const client = await this.createClient(i);
      clients.push(client);
      // Increased delay for Windows stability
      if (i < size - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    this.available = clients;
    this.initialized = true;

    console.log(`  [MCPPool] ${size} browser instance(s) ready`);
  }

  /**
   * Create a single MCP client with isolated browser context.
   * Storage state (auth tokens) is injected via contextOptions.
   */
  private async createClient(id: number): Promise<PooledClient> {
    const mcpCliPath = getMcpCliPath();
    const workerDir = join(this.baseDir, `worker-${id}`);
    mkdirSync(workerDir, { recursive: true });

    const mcpArgs: string[] = [mcpCliPath];
    
    if (this.headless) {
      mcpArgs.push('--headless');
    }

    // IMPORTANT:
    // - Use official CLI flags for isolation/session injection (per Playwright MCP docs).
    // - Do NOT override browserName/launchOptions via config: MCP uses a dynamically chosen
    //   websocket port for Chromium; overriding via config can lead to "Invalid URL undefined".
    mcpArgs.push('--isolated');
    mcpArgs.push('--browser', 'chrome');
    mcpArgs.push('--user-data-dir', workerDir);

    // Inject auth state if available (isolated sessions).
    if (this.storageStatePath) {
      mcpArgs.push('--storage-state', this.storageStatePath);
    }

    const transport = new StdioMCPTransport({
      command: process.execPath,
      args: mcpArgs,
    });

    const client = await createMCPClient({ transport });
    console.log(`  [MCPPool] Worker ${id} ready`);

    return { client, id };
  }

  async acquire(): Promise<{ client: MCPClient; id: number }> {
    while (this.available.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const pooled = this.available.shift()!;
    this.inUse.add(pooled.id);
    return { client: pooled.client, id: pooled.id };
  }

  release(id: number, client: MCPClient): void {
    if (this.inUse.has(id)) {
      this.inUse.delete(id);
      this.available.push({ client, id });
    }
  }

  async close(): Promise<void> {
    for (const pooled of this.available) {
      try {
        await pooled.client.close();
      } catch {
        // Ignore close errors
      }
    }
    this.available = [];

    try {
      rmSync(this.baseDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    this.initialized = false;
  }

  get availableCount(): number {
    return this.available.length;
  }

  get totalSize(): number {
    return this.available.length + this.inUse.size;
  }
}
