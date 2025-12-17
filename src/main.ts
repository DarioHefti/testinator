import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { RunSummary, TestResult, LLMProvider, AgentResult } from './types.js';
import { runSpec, runSpecWithClient, checkLLMConnection } from './agent.js';
import { MCPPool } from './mcp-pool.js';

export class Main {
  /**
   * Run all markdown specs in the given folder
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
    const results: TestResult[] = [];

    // Quick check to verify LLM connection before running tests
    await checkLLMConnection(provider, model);

    // Clean up and create fresh reports folder structure
    const reportsDir = join(folderPath, 'reports');
    const imagesDir = join(reportsDir, 'images');
    if (existsSync(reportsDir)) {
      rmSync(reportsDir, { recursive: true, force: true });
    }
    mkdirSync(imagesDir, { recursive: true });

    // Find all .md files in the folder
    const mdFiles = this.findMarkdownFiles(folderPath);

    if (mdFiles.length === 0) {
      console.warn(`Warning: No .md files found in ${folderPath}`);
    }

    console.log(`Found ${mdFiles.length} spec file(s) to run\n`);

    if (concurrency === 1) {
      // Run sequentially
      for (const filePath of mdFiles) {
        const result = await this.runSingleSpec(filePath, baseUrl, provider, model, headless, imagesDir);
        results.push(result);
      }
    } else {
      // Run in parallel with limited concurrency
      const allResults = await this.runSpecsInParallel(mdFiles, baseUrl, provider, model, headless, concurrency, imagesDir);
      results.push(...allResults);
    }

    const summary: RunSummary = {
      results,
      allPassed: results.every((r) => r.success),
      totalDurationMs: Date.now() - startTime,
      timestamp: new Date().toLocaleString(undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    };

    // Generate HTML report in reports folder
    this.generateHtmlReport(reportsDir, summary, provider, model);

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
    imagesDir: string
  ): Promise<TestResult[]> {
    // Create pool with the requested concurrency (limited by number of files)
    const poolSize = Math.min(concurrency, files.length);
    const pool = new MCPPool(headless);
    
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
   * Find all .md files in the given folder (non-recursive)
   */
  private findMarkdownFiles(folderPath: string): string[] {
    const entries = readdirSync(folderPath, { withFileTypes: true });

    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => join(folderPath, entry.name))
      .sort();
  }

  /**
   * Generate screenshot filename from spec name (e.g., "homepage-smoke.md" -> "homepage-smoke.jpg")
   */
  private getScreenshotName(specName: string): string {
    // @playwright/mcp's `browser_take_screenshot` returns a JPEG image.
    return specName.replace(/\.md$/i, '.jpg');
  }

  /**
   * Generate an HTML report of the test results
   */
  private generateHtmlReport(
    reportsDir: string,
    summary: RunSummary,
    provider: LLMProvider,
    model?: string
  ): void {
    const passCount = summary.results.filter((r) => r.success).length;
    const failCount = summary.results.filter((r) => !r.success).length;

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
      --border: #30363d;
      --text: #c9d1d9;
      --text-muted: #8b949e;
      --pass: #3fb950;
      --fail: #f85149;
      --accent: #58a6ff;
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
    .results { display: flex; flex-direction: column; gap: 1rem; }
    .result-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
    }
    .result-header {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 1rem 1.25rem;
      border-bottom: 1px solid var(--border);
    }
    .status-badge {
      padding: 0.25rem 0.75rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
    }
    .status-pass { background: rgba(63, 185, 80, 0.2); color: var(--pass); }
    .status-fail { background: rgba(248, 81, 73, 0.2); color: var(--fail); }
    .spec-name { font-weight: 500; flex: 1; }
    .duration { color: var(--text-muted); font-size: 0.875rem; }
    .result-details {
      padding: 1rem 1.25rem;
      color: var(--text-muted);
      font-size: 0.875rem;
    }
    .tooling-error {
      background: rgba(248, 81, 73, 0.15);
      border: 1px solid var(--fail);
      border-radius: 6px;
      padding: 0.75rem 1rem;
      margin-bottom: 0.75rem;
      color: var(--fail);
      font-weight: 500;
    }
    .criteria-list {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .criteria-list li {
      display: flex;
      align-items: flex-start;
      gap: 0.5rem;
      padding: 0.25rem 0;
    }
    .criteria-icon {
      flex-shrink: 0;
      width: 1rem;
      text-align: center;
    }
    .criteria-icon.pass { color: var(--pass); }
    .criteria-icon.fail { color: var(--fail); }
    .criteria-name { color: var(--text); }
    .criteria-reason { color: var(--text-muted); }
    .fallback-details {
      white-space: pre-wrap;
      word-break: break-word;
    }
    .screenshot-container {
      margin-top: 1rem;
      padding-top: 1rem;
      border-top: 1px solid var(--border);
    }
    .screenshot-btn {
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 0.5rem 1rem;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.875rem;
      transition: background 0.2s, border-color 0.2s;
    }
    .screenshot-btn:hover {
      background: #1f2937;
      border-color: var(--text-muted);
    }
    /* Modal styles */
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
    .modal.show {
      display: flex;
    }
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
    .modal-img {
      display: block;
      max-width: 100%;
      height: auto;
      border-radius: 4px;
    }
    .modal-close {
      position: absolute;
      top: 1rem;
      right: 1rem;
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
    .modal-close:hover {
      background: rgba(0,0,0,0.8);
    }
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
    
    <div class="results">
      ${summary.results.map((r) => this.renderResultCard(r)).join('')}
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
    function showScreenshot(path) {
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

    // Close on Escape key
    document.addEventListener('keydown', function(event) {
      if (event.key === 'Escape') {
        closeModal();
      }
    });
  </script>
</body>
</html>`;

    const reportPath = join(reportsDir, 'index.html');
    writeFileSync(reportPath, html, 'utf-8');
    console.log(`HTML report written to: ${reportPath}`);
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
          <button onclick="showScreenshot('${this.escapeHtml(r.screenshotPath)}')" class="screenshot-btn">📷 Show Final Screenshot</button>
        </div>`
      : '';

    return `
      <div class="result-card">
        <div class="result-header">
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
