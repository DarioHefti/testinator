import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { RunSummary, TestResult, LLMProvider } from './types.js';
import { runSpec, checkLLMConnection } from './agent.js';

export class Main {
  /**
   * Run all markdown specs in the given folder
   */
  async run(
    folderPath: string,
    baseUrl: string,
    provider: LLMProvider = 'openai',
    model?: string
  ): Promise<RunSummary> {
    const startTime = Date.now();
    const results: TestResult[] = [];

    // Quick check to verify LLM connection before running tests
    await checkLLMConnection(provider, model);

    // Find all .md files in the folder
    const mdFiles = this.findMarkdownFiles(folderPath);

    if (mdFiles.length === 0) {
      console.warn(`Warning: No .md files found in ${folderPath}`);
    }

    console.log(`Found ${mdFiles.length} spec file(s) to run\n`);

    // Run each spec sequentially
    for (const filePath of mdFiles) {
      const specName = basename(filePath);
      console.log(`Running: ${specName}...`);

      const specStartTime = Date.now();

      try {
        const markdown = readFileSync(filePath, 'utf-8');
        const agentResult = await runSpec(markdown, baseUrl, specName, provider, model);

        const result: TestResult = {
          specName,
          specPath: filePath,
          success: agentResult.success,
          details: agentResult.details,
          durationMs: Date.now() - specStartTime,
        };

        results.push(result);

        const status = result.success ? '✓ PASS' : '✗ FAIL';
        console.log(`  ${status} (${(result.durationMs / 1000).toFixed(2)}s)`);

        if (!result.success) {
          console.log(`  Details: ${result.details.slice(0, 200)}${result.details.length > 200 ? '...' : ''}`);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        const result: TestResult = {
          specName,
          specPath: filePath,
          success: false,
          details: `Agent error: ${errorMessage}`,
          durationMs: Date.now() - specStartTime,
        };

        results.push(result);
        console.log(`  ✗ ERROR (${(result.durationMs / 1000).toFixed(2)}s)`);
        console.log(`  Details: ${errorMessage.slice(0, 200)}`);
      }

      console.log('');
    }

    const summary: RunSummary = {
      results,
      allPassed: results.every((r) => r.success),
      totalDurationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };

    // Generate HTML report
    this.generateHtmlReport(folderPath, summary, provider, model);

    return summary;
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
   * Generate an HTML report of the test results
   */
  private generateHtmlReport(
    folderPath: string,
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
      white-space: pre-wrap;
      word-break: break-word;
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
      ${summary.results
        .map(
          (r) => `
      <div class="result-card">
        <div class="result-header">
          <span class="status-badge ${r.success ? 'status-pass' : 'status-fail'}">${r.success ? 'Pass' : 'Fail'}</span>
          <span class="spec-name">${this.escapeHtml(r.specName)}</span>
          <span class="duration">${(r.durationMs / 1000).toFixed(2)}s</span>
        </div>
        <div class="result-details">${this.escapeHtml(r.details)}</div>
      </div>`
        )
        .join('')}
    </div>
  </div>
</body>
</html>`;

    const reportPath = join(folderPath, 'index.html');
    writeFileSync(reportPath, html, 'utf-8');
    console.log(`HTML report written to: ${reportPath}`);
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
}
