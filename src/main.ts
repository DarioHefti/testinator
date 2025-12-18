import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, basename, relative, sep } from 'node:path';
import type { RunSummary, TestResult, LLMProvider, AgentResult, FolderNode, FolderSummary } from './types.js';
import { runSpec, runSpecWithClient, checkLLMConnection } from './agent.js';
import { MCPPool } from './mcp-pool.js';
import { runAuthentication } from './auth-runner.js';
import { buildHtmlReportPage } from './report-html-template.js';

/** Name of the authentication spec file */
const AUTH_SPEC_NAME = 'AUTH_LOGIN.md';

type ReportSummaryData = {
  provider: string;
  model?: string;
  timestamp: string;
  authHtml: string;
  resultsHtml: string;
  totalTests: number;
  passCount: number;
  failCount: number;
  totalDurationMs: number;
};

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
    const runTimestamp = this.getTimestamp();

    // Quick check to verify LLM connection before running tests
    await checkLLMConnection(provider, model);

    // Clean up and create fresh reports folder structure
    const reportsDir = join(folderPath, 'reports');
    const imagesDir = join(reportsDir, 'images');
    if (existsSync(reportsDir)) {
      rmSync(reportsDir, { recursive: true, force: true });
    }
    mkdirSync(imagesDir, { recursive: true });

    // Write an initial empty report shell (and summary.js) right away.
    // This ensures the user can open reports/index.html even while tests are running.
    const initialSummary: RunSummary = {
      results: [],
      allPassed: true,
      totalDurationMs: 0,
      timestamp: runTimestamp,
    };
    this.generateHtmlReport(reportsDir, initialSummary, provider, model, folderPath);

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

      // Update report with auth status as soon as it completes.
      const authOnlySummary: RunSummary = {
        results: [],
        allPassed: result.success,
        totalDurationMs: Date.now() - startTime,
        timestamp: runTimestamp,
        authResult,
      };
      this.generateHtmlReport(reportsDir, authOnlySummary, provider, model, folderPath);
      
      if (!result.success) {
        // Auth failed - abort test run
        const summary: RunSummary = {
          results: [],
          allPassed: false,
          totalDurationMs: Date.now() - startTime,
          timestamp: runTimestamp,
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
    let reportWriteChain: Promise<void> = Promise.resolve();
    let reportWriteTimer: NodeJS.Timeout | undefined;
    let latestProgressResults: TestResult[] = [];
    const progressDebounceMs = 200;

    const scheduleProgressReportWrite = (orderedResults: TestResult[]): void => {
      latestProgressResults = orderedResults;
      if (reportWriteTimer) return;
      reportWriteTimer = setTimeout(() => {
        reportWriteTimer = undefined;
        const snapshot = latestProgressResults;
        const folderTree = this.buildFolderTree(snapshot, folderPath);
        const progressSummary: RunSummary = {
          results: snapshot,
          allPassed: snapshot.every((r) => r.success),
          totalDurationMs: Date.now() - startTime,
          timestamp: runTimestamp,
          folderTree,
          authResult,
        };
        reportWriteChain = reportWriteChain.then(() => {
          this.generateHtmlReport(reportsDir, progressSummary, provider, model, folderPath);
        });
      }, progressDebounceMs);
    };
    
    // Always run in parallel mode (using pool), pass storage state if available
    results = await this.runSpecsInParallel(
      mdFiles, 
      baseUrl, 
      provider, 
      model, 
      headless, 
      concurrency, 
      imagesDir,
      storageStatePath,
      scheduleProgressReportWrite
    );

    // Build folder tree for hierarchical report
    const folderTree = this.buildFolderTree(results, folderPath);

    const summary: RunSummary = {
      results,
      allPassed: results.every((r) => r.success),
      totalDurationMs: Date.now() - startTime,
      timestamp: runTimestamp,
      folderTree,
      authResult,
    };

    // Generate HTML report in reports folder
    if (reportWriteTimer) {
      clearTimeout(reportWriteTimer);
      reportWriteTimer = undefined;
    }
    await reportWriteChain;
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
      const agentResult = await runSpec(markdown, baseUrl, specName, provider, model, headless, screenshotFullPath, 'main');

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
    storageStatePath?: string,
    onResult?: (orderedResults: TestResult[]) => void
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
      const fileOrder = new Map(files.map((f, i) => [f, i]));

      const runNext = async (): Promise<void> => {
        const filePath = queue.shift();
        if (!filePath) return;

        const result = await this.runSpecWithPool(pool, filePath, baseUrl, provider, model, imagesDir);
        results.push(result);
        if (onResult) {
          const orderedSnapshot = [...results].sort(
            (a, b) => (fileOrder.get(a.specPath) ?? 0) - (fileOrder.get(b.specPath) ?? 0)
          );
          try {
            onResult(orderedSnapshot);
          } catch {
            // Ignore reporter errors so they don't impact the test run.
          }
        }

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
      const agentResult = await runSpecWithClient(client, markdown, baseUrl, specName, provider, model, screenshotFullPath, id);

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

    const reportData: ReportSummaryData = {
      provider,
      model,
      timestamp: summary.timestamp,
      authHtml,
      resultsHtml,
      passCount,
      failCount,
      totalDurationMs: summary.totalDurationMs,
      totalTests: summary.results.length,
    };

    this.writeReportSummaryJs(reportsDir, reportData);

    const html = buildHtmlReportPage({ provider, model, timestamp: summary.timestamp });
    const reportPath = join(reportsDir, 'index.html');
    writeFileSync(reportPath, html, 'utf-8');
    console.log(`HTML report written to: ${reportPath}`);
  }

  private writeReportSummaryJs(reportsDir: string, data: ReportSummaryData): void {
    const summaryPath = join(reportsDir, 'summary.js');
    const json = JSON.stringify(data)
      // Prevent U+2028/U+2029 from breaking JS parsing in string literals.
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029')
      // Defensive: avoid generating raw "<" sequences (e.g. "</script>") if this JS is ever embedded.
      .replace(/</g, '\\u003c');

    const contents = `// Auto-generated by Testinator. Do not edit.
// This file is loaded by reports/index.html via <script src="./summary.js"></script>
window.__TESTINATOR_RUN__ = ${json};
`;
    writeFileSync(summaryPath, contents, 'utf-8');
  }

  /**
   * Render a folder node and its contents recursively
   */
  private renderFolderTree(folder: FolderNode): string {
    const hasFailures = folder.summary.failed > 0;
    const summaryClass = hasFailures ? 'has-fail' : 'all-pass';
    const summaryText = `${folder.summary.passed}/${folder.summary.total} passed`;
    
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
