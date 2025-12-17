import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, basename, relative, sep } from 'node:path';
import type { RunSummary, TestResult, LLMProvider, AgentResult, FolderNode, FolderSummary } from './types.js';
import { runSpec, runSpecWithClient, checkLLMConnection } from './agent.js';
import { MCPPool } from './mcp-pool.js';
import { runAuthentication } from './auth-runner.js';

/** Name of the authentication spec file */
const AUTH_SPEC_NAME = 'AUTH_LOGIN.md';

export class Main {
  /**
   * Run all markdown specs in the given folder (recursively)
   */
  async run(
    folderPath: string,
    baseUrl: string,
    provider: LLMProvider = 'openai',
    model?: string,
    headless: boolean = true,
    concurrency: number = 1
  ): Promise<RunSummary> {
    const startTime = Date.now();
    let authResult: RunSummary['authResult'] | undefined;

    // Quick check to verify LLM connection before running tests
    await checkLLMConnection(provider, model);

    // Clean up and create fresh reports folder structure
    const reportsDir = join(folderPath, 'reports');
    const imagesDir = join(reportsDir, 'images');
    if (existsSync(reportsDir)) {
      rmSync(reportsDir, { recursive: true, force: true });
    }
    mkdirSync(imagesDir, { recursive: true });

    // Check for AUTH_LOGIN.md in the root of specs folder
    const authSpecPath = join(folderPath, AUTH_SPEC_NAME);
    let storageStatePath: string | undefined;
    
    if (existsSync(authSpecPath)) {
      const authSpecContent = readFileSync(authSpecPath, 'utf-8');
      const authScreenshotPath = join(imagesDir, 'auth_login.jpg');
      const result = await runAuthentication(
        authSpecPath,
        authSpecContent,
        baseUrl,
        provider,
        model,
        headless,
        authScreenshotPath
      );
      
      authResult = {
        success: result.success,
        durationMs: result.durationMs,
        error: result.error,
        screenshotPath: result.screenshotPath,
      };
      
      if (!result.success) {
        // Auth failed - abort test run
        const summary: RunSummary = {
          results: [],
          allPassed: false,
          totalDurationMs: Date.now() - startTime,
          timestamp: this.getTimestamp(),
          authResult,
        };
        this.generateHtmlReport(reportsDir, summary, provider, model, folderPath);
        return summary;
      }
      
      storageStatePath = result.storageStatePath;
      console.log('✓ Authentication completed successfully\n');
    }

    // Find all .md files recursively (excluding AUTH_LOGIN.md and reports folder)
    const mdFiles = this.findMarkdownFilesRecursive(folderPath, folderPath);

    if (mdFiles.length === 0) {
      console.warn(`Warning: No .md spec files found in ${folderPath}`);
    }

    console.log(`Found ${mdFiles.length} spec file(s) to run\n`);

    let results: TestResult[];
    
    // Always run in parallel mode (using pool), pass storage state if available
    results = await this.runSpecsInParallel(
      mdFiles, 
      baseUrl, 
      provider, 
      model, 
      headless, 
      concurrency, 
      imagesDir,
      storageStatePath
    );

    // Build folder tree for hierarchical report
    const folderTree = this.buildFolderTree(results, folderPath);

    const summary: RunSummary = {
      results,
      allPassed: results.every((r) => r.success),
      totalDurationMs: Date.now() - startTime,
      timestamp: this.getTimestamp(),
      folderTree,
      authResult,
    };

    // Generate HTML report in reports folder
    this.generateHtmlReport(reportsDir, summary, provider, model, folderPath);

    return summary;
  }

  /**
   * Run a single spec file and return the result
   */
  private async runSingleSpec(
    filePath: string,
    baseUrl: string,
    provider: LLMProvider,
    model: string | undefined,
    headless: boolean,
    imagesDir: string
  ): Promise<TestResult> {
    const specName = basename(filePath);
    const screenshotName = this.getScreenshotName(specName);
    const screenshotFullPath = join(imagesDir, screenshotName);
    console.log(`Running: ${specName}...`);

    const specStartTime = Date.now();

    try {
      const markdown = readFileSync(filePath, 'utf-8');
      // Pass absolute path - Playwright MCP should save directly there
      const agentResult = await runSpec(markdown, baseUrl, specName, provider, model, headless, screenshotFullPath);

      const result: TestResult = {
        specName,
        specPath: filePath,
        success: agentResult.success,
        details: this.buildDetailsString(agentResult),
        durationMs: Date.now() - specStartTime,
        isToolingError: agentResult.isToolingError,
        toolingErrorMessage: agentResult.toolingErrorMessage,
        criteria: agentResult.criteria,
        screenshotPath: existsSync(screenshotFullPath) ? `images/${screenshotName}` : undefined,
      };

      const status = result.success ? '✓ PASS' : '✗ FAIL';
      console.log(`  ${status} ${specName} (${(result.durationMs / 1000).toFixed(2)}s)`);

      if (!result.success) {
        console.log(`  Details: ${result.details.slice(0, 200)}${result.details.length > 200 ? '...' : ''}`);
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      const result: TestResult = {
        specName,
        specPath: filePath,
        success: false,
        details: `Agent error: ${errorMessage}`,
        durationMs: Date.now() - specStartTime,
        screenshotPath: existsSync(screenshotFullPath) ? `images/${screenshotName}` : undefined,
      };

      console.log(`  ✗ ERROR ${specName} (${(result.durationMs / 1000).toFixed(2)}s)`);
      console.log(`  Details: ${errorMessage.slice(0, 200)}`);

      return result;
    }
  }

  /**
   * Run specs in parallel using a pool of isolated MCP clients
   */
  private async runSpecsInParallel(
    files: string[],
    baseUrl: string,
    provider: LLMProvider,
    model: string | undefined,
    headless: boolean,
    concurrency: number,
    imagesDir: string,
    storageStatePath?: string
  ): Promise<TestResult[]> {
    if (files.length === 0) {
      return [];
    }
    
    // Create pool with the requested concurrency (limited by number of files)
    const poolSize = Math.min(concurrency, files.length);
    const pool = new MCPPool(headless, storageStatePath);
    
    try {
      await pool.initialize(poolSize);

      const results: TestResult[] = [];
      const queue = [...files];
      const running: Promise<void>[] = [];

      const runNext = async (): Promise<void> => {
        const filePath = queue.shift();
        if (!filePath) return;

        const result = await this.runSpecWithPool(pool, filePath, baseUrl, provider, model, imagesDir);
        results.push(result);

        // Continue with next file if any
        if (queue.length > 0) {
          await runNext();
        }
      };

      // Start initial batch of concurrent tasks
      const initialBatch = Math.min(poolSize, queue.length);
      for (let i = 0; i < initialBatch; i++) {
        running.push(runNext());
      }

      // Wait for all to complete
      await Promise.all(running);

      // Sort results to maintain original file order
      const fileOrder = new Map(files.map((f, i) => [f, i]));
      results.sort((a, b) => (fileOrder.get(a.specPath) ?? 0) - (fileOrder.get(b.specPath) ?? 0));

      return results;
    } finally {
      // Always clean up the pool
      await pool.close();
    }
  }

  /**
   * Run a single spec using the MCP pool
   */
  private async runSpecWithPool(
    pool: MCPPool,
    filePath: string,
    baseUrl: string,
    provider: LLMProvider,
    model: string | undefined,
    imagesDir: string
  ): Promise<TestResult> {
    const specName = basename(filePath);
    const screenshotName = this.getScreenshotName(specName);
    const screenshotFullPath = join(imagesDir, screenshotName);
    const { client, id } = await pool.acquire();
    
    console.log(`Running: ${specName} (worker ${id})...`);
    const specStartTime = Date.now();

    try {
      const markdown = readFileSync(filePath, 'utf-8');
      // Pass absolute path - Playwright MCP should save directly there
      const agentResult = await runSpecWithClient(client, markdown, baseUrl, specName, provider, model, screenshotFullPath);

      const result: TestResult = {
        specName,
        specPath: filePath,
        success: agentResult.success,
        details: this.buildDetailsString(agentResult),
        durationMs: Date.now() - specStartTime,
        isToolingError: agentResult.isToolingError,
        toolingErrorMessage: agentResult.toolingErrorMessage,
        criteria: agentResult.criteria,
        screenshotPath: existsSync(screenshotFullPath) ? `images/${screenshotName}` : undefined,
      };

      const status = result.success ? '✓ PASS' : '✗ FAIL';
      console.log(`  ${status} ${specName} (${(result.durationMs / 1000).toFixed(2)}s) [worker ${id}]`);

      if (!result.success) {
        console.log(`  Details: ${result.details.slice(0, 200)}${result.details.length > 200 ? '...' : ''}`);
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      const result: TestResult = {
        specName,
        specPath: filePath,
        success: false,
        details: `Agent error: ${errorMessage}`,
        durationMs: Date.now() - specStartTime,
        screenshotPath: existsSync(screenshotFullPath) ? `images/${screenshotName}` : undefined,
      };

      console.log(`  ✗ ERROR ${specName} (${(result.durationMs / 1000).toFixed(2)}s) [worker ${id}]`);
      console.log(`  Details: ${errorMessage.slice(0, 200)}`);

      return result;
    } finally {
      // Return client to pool
      pool.release(id, client);
    }
  }

  /**
   * Find all .md files recursively, excluding AUTH_LOGIN.md and reports folder
   */
  private findMarkdownFilesRecursive(folderPath: string, rootPath: string): string[] {
    const results: string[] = [];
    const entries = readdirSync(folderPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(folderPath, entry.name);
      
      if (entry.isDirectory()) {
        // Skip reports folder
        if (entry.name === 'reports') continue;
        // Recurse into subdirectories
        results.push(...this.findMarkdownFilesRecursive(fullPath, rootPath));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        // Skip AUTH_LOGIN.md
        if (entry.name === AUTH_SPEC_NAME) continue;
        results.push(fullPath);
      }
    }

    return results.sort();
  }

  /**
   * Build a hierarchical folder tree from test results
   */
  private buildFolderTree(results: TestResult[], rootPath: string): FolderNode {
    const root: FolderNode = {
      name: basename(rootPath) || 'specs',
      relativePath: '',
      children: [],
      specs: [],
      summary: { total: 0, passed: 0, failed: 0, durationMs: 0 },
    };

    // Group results by their relative folder path
    const folderMap = new Map<string, FolderNode>();
    folderMap.set('', root);

    for (const result of results) {
      const relativePath = relative(rootPath, result.specPath);
      const folderPath = relativePath.split(sep).slice(0, -1).join(sep);
      
      // Ensure all parent folders exist
      this.ensureFolderPath(root, folderPath, folderMap);
      
      // Add spec to its folder
      const folder = folderMap.get(folderPath)!;
      folder.specs.push(result);
    }

    // Calculate summaries bottom-up
    this.calculateFolderSummary(root);

    return root;
  }

  /**
   * Ensure all folders in a path exist in the tree
   */
  private ensureFolderPath(
    root: FolderNode,
    folderPath: string,
    folderMap: Map<string, FolderNode>
  ): void {
    if (folderPath === '' || folderMap.has(folderPath)) return;

    const parts = folderPath.split(sep);
    let currentPath = '';
    let currentNode = root;

    for (const part of parts) {
      const parentPath = currentPath;
      currentPath = currentPath ? `${currentPath}${sep}${part}` : part;

      if (!folderMap.has(currentPath)) {
        const newFolder: FolderNode = {
          name: part,
          relativePath: currentPath,
          children: [],
          specs: [],
          summary: { total: 0, passed: 0, failed: 0, durationMs: 0 },
        };
        currentNode.children.push(newFolder);
        folderMap.set(currentPath, newFolder);
      }

      currentNode = folderMap.get(currentPath)!;
    }
  }

  /**
   * Calculate summary statistics for a folder and all its descendants
   */
  private calculateFolderSummary(folder: FolderNode): FolderSummary {
    let total = folder.specs.length;
    let passed = folder.specs.filter(s => s.success).length;
    let failed = folder.specs.filter(s => !s.success).length;
    let durationMs = folder.specs.reduce((sum, s) => sum + s.durationMs, 0);

    // Add child folder summaries
    for (const child of folder.children) {
      const childSummary = this.calculateFolderSummary(child);
      total += childSummary.total;
      passed += childSummary.passed;
      failed += childSummary.failed;
      durationMs += childSummary.durationMs;
    }

    folder.summary = { total, passed, failed, durationMs };
    return folder.summary;
  }

  /**
   * Get formatted timestamp
   */
  private getTimestamp(): string {
    return new Date().toLocaleString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  /**
   * Generate screenshot filename from spec name (e.g., "homepage-smoke.md" -> "homepage-smoke.jpg")
   */
  private getScreenshotName(specName: string): string {
    // @playwright/mcp's `browser_take_screenshot` returns a JPEG image.
    return specName.replace(/\.md$/i, '.jpg');
  }

  /**
   * Generate an HTML report of the test results with folder tree view
   */
  private generateHtmlReport(
    reportsDir: string,
    summary: RunSummary,
    provider: LLMProvider,
    model?: string,
    specsRootPath?: string
  ): void {
    const passCount = summary.results.filter((r) => r.success).length;
    const failCount = summary.results.filter((r) => !r.success).length;

    // Render auth status if applicable
    const authScreenshotBtn = summary.authResult?.screenshotPath
      ? `<button class="screenshot-btn auth-screenshot-btn" onclick="showScreenshot('${summary.authResult.screenshotPath}', event)">📷 View Screenshot</button>`
      : '';
    
    const authHtml = summary.authResult
      ? `<div class="auth-status ${summary.authResult.success ? 'auth-pass' : 'auth-fail'}">
          <span class="auth-icon">${summary.authResult.success ? '🔓' : '🔒'}</span>
          <span class="auth-text">Authentication: ${summary.authResult.success ? 'Successful' : 'Failed'}</span>
          <span class="auth-duration">${(summary.authResult.durationMs / 1000).toFixed(2)}s</span>
          ${authScreenshotBtn}
          ${summary.authResult.error ? `<div class="auth-error">${this.escapeHtml(summary.authResult.error)}</div>` : ''}
        </div>`
      : '';

    // Render folder tree or flat list
    const resultsHtml = summary.folderTree
      ? this.renderFolderTree(summary.folderTree)
      : summary.results.map((r) => this.renderResultCard(r)).join('');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Testinator Report</title>
  <style>
    :root {
      --bg: #0d1117;
      --surface: #161b22;
      --surface-hover: #1c2128;
      --border: #30363d;
      --text: #c9d1d9;
      --text-muted: #8b949e;
      --pass: #3fb950;
      --fail: #f85149;
      --accent: #58a6ff;
      --folder-bg: #21262d;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      padding: 2rem;
    }
    .container { max-width: 1000px; margin: 0 auto; }
    header {
      text-align: center;
      margin-bottom: 2rem;
      padding-bottom: 1.5rem;
      border-bottom: 1px solid var(--border);
    }
    h1 {
      font-size: 2rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
      background: linear-gradient(135deg, var(--accent), #a371f7);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .meta { color: var(--text-muted); font-size: 0.875rem; }
    .meta span { margin: 0 0.5rem; }
    
    /* Auth Status */
    .auth-status {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.75rem;
      padding: 0.75rem 1rem;
      border-radius: 8px;
      margin-bottom: 1.5rem;
      font-weight: 500;
    }
    .auth-pass { background: rgba(63, 185, 80, 0.15); border: 1px solid var(--pass); }
    .auth-fail { background: rgba(248, 81, 73, 0.15); border: 1px solid var(--fail); }
    .auth-icon { font-size: 1.25rem; }
    .auth-text { flex: 1; }
    .auth-duration { color: var(--text-muted); font-size: 0.875rem; }
    .auth-screenshot-btn { margin-left: auto; }
    .auth-error { width: 100%; margin-top: 0.5rem; color: var(--fail); font-size: 0.875rem; }
    
    /* Summary Stats */
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .stat {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1.25rem;
      text-align: center;
    }
    .stat-value {
      font-size: 2rem;
      font-weight: 700;
      margin-bottom: 0.25rem;
    }
    .stat-label { color: var(--text-muted); font-size: 0.875rem; }
    .stat-pass .stat-value { color: var(--pass); }
    .stat-fail .stat-value { color: var(--fail); }
    
    /* Folder Tree */
    .folder-tree { display: flex; flex-direction: column; gap: 0.5rem; }
    .folder {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
    }
    .folder-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem 1rem;
      cursor: pointer;
      user-select: none;
      transition: background 0.15s;
    }
    .folder-header:hover { background: var(--surface-hover); }
    .folder-toggle {
      width: 1.25rem;
      height: 1.25rem;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-muted);
      transition: transform 0.2s;
    }
    .folder.collapsed .folder-toggle { transform: rotate(-90deg); }
    .folder-icon { font-size: 1rem; }
    .folder-name { font-weight: 500; flex: 1; }
    .folder-summary {
      font-size: 0.8rem;
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      background: var(--folder-bg);
    }
    .folder-summary.all-pass { color: var(--pass); }
    .folder-summary.has-fail { color: var(--fail); }
    .folder-duration { color: var(--text-muted); font-size: 0.8rem; }
    .folder-content {
      border-top: 1px solid var(--border);
      padding: 0.5rem;
    }
    .folder.collapsed .folder-content { display: none; }
    .folder-children { margin-left: 1rem; display: flex; flex-direction: column; gap: 0.5rem; }
    .folder-specs { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 0.5rem; }
    
    /* Result Cards */
    .results { display: flex; flex-direction: column; gap: 1rem; }
    .result-card {
      background: var(--folder-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
    }
    .result-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem 1rem;
      cursor: pointer;
      transition: background 0.15s;
    }
    .result-header:hover { background: var(--surface-hover); }
    .status-badge {
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
    }
    .status-pass { background: rgba(63, 185, 80, 0.2); color: var(--pass); }
    .status-fail { background: rgba(248, 81, 73, 0.2); color: var(--fail); }
    .spec-name { font-weight: 500; flex: 1; font-size: 0.9rem; }
    .duration { color: var(--text-muted); font-size: 0.8rem; }
    .result-details {
      padding: 0.75rem 1rem;
      color: var(--text-muted);
      font-size: 0.85rem;
      border-top: 1px solid var(--border);
      display: none;
    }
    .result-card.expanded .result-details { display: block; }
    .tooling-error {
      background: rgba(248, 81, 73, 0.15);
      border: 1px solid var(--fail);
      border-radius: 6px;
      padding: 0.5rem 0.75rem;
      margin-bottom: 0.5rem;
      color: var(--fail);
      font-weight: 500;
    }
    .criteria-list { list-style: none; }
    .criteria-list li {
      display: flex;
      align-items: flex-start;
      gap: 0.5rem;
      padding: 0.2rem 0;
    }
    .criteria-icon { flex-shrink: 0; width: 1rem; text-align: center; }
    .criteria-icon.pass { color: var(--pass); }
    .criteria-icon.fail { color: var(--fail); }
    .criteria-name { color: var(--text); }
    .criteria-reason { color: var(--text-muted); }
    .fallback-details { white-space: pre-wrap; word-break: break-word; }
    .screenshot-container { margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid var(--border); }
    .screenshot-btn {
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 0.4rem 0.75rem;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.8rem;
      transition: background 0.2s, border-color 0.2s;
    }
    .screenshot-btn:hover { background: var(--surface-hover); border-color: var(--text-muted); }
    
    /* Modal */
    .modal {
      display: none;
      position: fixed;
      z-index: 1000;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      background-color: rgba(0,0,0,0.8);
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }
    .modal.show { display: flex; }
    .modal-content {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      max-width: 90vw;
      max-height: 90vh;
      overflow: auto;
      position: relative;
      padding: 1rem;
    }
    .modal-img { display: block; max-width: 100%; height: auto; border-radius: 4px; }
    .modal-close {
      position: absolute;
      top: 0.5rem;
      right: 0.5rem;
      background: rgba(0,0,0,0.5);
      color: white;
      border: none;
      border-radius: 50%;
      width: 2rem;
      height: 2rem;
      font-size: 1.25rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .modal-close:hover { background: rgba(0,0,0,0.8); }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Testinator Report</h1>
      <p class="meta">
        <span>Provider: ${this.escapeHtml(provider)}</span>
        <span>|</span>
        <span>Model: ${this.escapeHtml(model || 'default')}</span>
        <span>|</span>
        <span>${this.escapeHtml(summary.timestamp)}</span>
      </p>
    </header>
    
    ${authHtml}
    
    <div class="summary">
      <div class="stat">
        <div class="stat-value">${summary.results.length}</div>
        <div class="stat-label">Total Tests</div>
      </div>
      <div class="stat stat-pass">
        <div class="stat-value">${passCount}</div>
        <div class="stat-label">Passed</div>
      </div>
      <div class="stat stat-fail">
        <div class="stat-value">${failCount}</div>
        <div class="stat-label">Failed</div>
      </div>
      <div class="stat">
        <div class="stat-value">${(summary.totalDurationMs / 1000).toFixed(1)}s</div>
        <div class="stat-label">Duration</div>
      </div>
    </div>
    
    <div class="folder-tree">
      ${resultsHtml}
    </div>
  </div>

  <!-- Modal -->
  <div id="screenshotModal" class="modal" onclick="closeModal()">
    <div class="modal-content" onclick="event.stopPropagation()">
      <button class="modal-close" onclick="closeModal()">×</button>
      <img id="modalImage" class="modal-img" src="" alt="Screenshot" />
    </div>
  </div>

  <script>
    function toggleFolder(el) {
      el.closest('.folder').classList.toggle('collapsed');
    }
    
    function toggleResult(el) {
      el.closest('.result-card').classList.toggle('expanded');
    }
    
    function showScreenshot(path, event) {
      event.stopPropagation();
      const modal = document.getElementById('screenshotModal');
      const img = document.getElementById('modalImage');
      img.src = path;
      modal.classList.add('show');
    }

    function closeModal() {
      const modal = document.getElementById('screenshotModal');
      modal.classList.remove('show');
      const img = document.getElementById('modalImage');
      img.src = '';
    }

    document.addEventListener('keydown', function(event) {
      if (event.key === 'Escape') closeModal();
    });
  </script>
</body>
</html>`;

    const reportPath = join(reportsDir, 'index.html');
    writeFileSync(reportPath, html, 'utf-8');
    console.log(`HTML report written to: ${reportPath}`);
  }

  /**
   * Render a folder node and its contents recursively
   */
  private renderFolderTree(folder: FolderNode): string {
    const hasFailures = folder.summary.failed > 0;
    const summaryClass = hasFailures ? 'has-fail' : 'all-pass';
    const summaryText = `${folder.summary.passed}/${folder.summary.total} passed`;
    const folderIcon = folder.relativePath === '' ? '📁' : '📂';
    
    // Render child folders
    const childrenHtml = folder.children.length > 0
      ? `<div class="folder-children">${folder.children.map(c => this.renderFolderTree(c)).join('')}</div>`
      : '';
    
    // Render specs in this folder
    const specsHtml = folder.specs.length > 0
      ? `<div class="folder-specs">${folder.specs.map(s => this.renderResultCard(s)).join('')}</div>`
      : '';
    
    // If root folder with no direct specs and only one child, simplify
    const hasContent = folder.specs.length > 0 || folder.children.length > 0;
    
    if (!hasContent) {
      return '';
    }
    
    return `
      <div class="folder">
        <div class="folder-header" onclick="toggleFolder(this)">
          <span class="folder-toggle">▼</span>
          <span class="folder-icon">${folderIcon}</span>
          <span class="folder-name">${this.escapeHtml(folder.name)}</span>
          <span class="folder-summary ${summaryClass}">${summaryText}</span>
          <span class="folder-duration">${(folder.summary.durationMs / 1000).toFixed(1)}s</span>
        </div>
        <div class="folder-content">
          ${childrenHtml}
          ${specsHtml}
        </div>
      </div>`;
  }

  /**
   * Render a single result card for the HTML report
   */
  private renderResultCard(r: TestResult): string {
    const hasToolingError = r.isToolingError && r.toolingErrorMessage && r.toolingErrorMessage.length > 0;
    const toolingErrorHtml = hasToolingError
      ? `<div class="tooling-error">⚠ Tooling Error: ${this.escapeHtml(r.toolingErrorMessage!)}</div>`
      : '';

    let detailsContent: string;
    if (r.criteria && r.criteria.length > 0) {
      const criteriaItems = r.criteria.map((c) => {
        const iconClass = c.passed ? 'pass' : 'fail';
        const icon = c.passed ? '✓' : '✗';
        return `<li><span class="criteria-icon ${iconClass}">${icon}</span><span class="criteria-name">${this.escapeHtml(c.criterion)}:</span> <span class="criteria-reason">${this.escapeHtml(c.reason)}</span></li>`;
      }).join('');
      detailsContent = `<ul class="criteria-list">${criteriaItems}</ul>`;
    } else {
      detailsContent = `<div class="fallback-details">${this.escapeHtml(r.details)}</div>`;
    }

    const screenshotHtml = r.screenshotPath
      ? `<div class="screenshot-container">
          <button onclick="showScreenshot('${this.escapeHtml(r.screenshotPath)}', event)" class="screenshot-btn">📷 Show Final Screenshot</button>
        </div>`
      : '';

    return `
      <div class="result-card">
        <div class="result-header" onclick="toggleResult(this)">
          <span class="status-badge ${r.success ? 'status-pass' : 'status-fail'}">${r.success ? 'Pass' : 'Fail'}</span>
          <span class="spec-name">${this.escapeHtml(r.specName)}</span>
          <span class="duration">${(r.durationMs / 1000).toFixed(2)}s</span>
        </div>
        <div class="result-details">
          ${toolingErrorHtml}
          ${detailsContent}
          ${screenshotHtml}
        </div>
      </div>`;
  }

  /**
   * Escape HTML special characters
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * Build a fallback details string from structured AgentResult
   */
  private buildDetailsString(result: AgentResult): string {
    const lines: string[] = [];
    if (result.isToolingError && result.toolingErrorMessage.length > 0) {
      lines.push(`Tooling Error: ${result.toolingErrorMessage}`);
    }
    for (const c of result.criteria) {
      const icon = c.passed ? '✓' : '✗';
      lines.push(`${icon} ${c.criterion}: ${c.reason}`);
    }
    return lines.join('\n');
  }
}
