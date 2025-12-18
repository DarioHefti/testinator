export type EscapeHtml = (text: string) => string;

export interface HtmlReportTemplateParams {
  provider: string;
  model?: string;
  timestamp: string;
  authHtml: string;
  resultsHtml: string;
  totalTests: number;
  passCount: number;
  failCount: number;
  totalDurationMs: number;
  escapeHtml: EscapeHtml;
}

export function buildHtmlReportPage(params: HtmlReportTemplateParams): string {
  const {
    provider,
    model,
    timestamp,
    authHtml,
    resultsHtml,
    totalTests,
    passCount,
    failCount,
    totalDurationMs,
    escapeHtml,
  } = params;

  return `<!DOCTYPE html>
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
        <span>Provider: ${escapeHtml(provider)}</span>
        <span>|</span>
        <span>Model: ${escapeHtml(model ?? 'default')}</span>
        <span>|</span>
        <span>${escapeHtml(timestamp)}</span>
      </p>
    </header>

    ${authHtml}

    <div class="summary">
      <div class="stat">
        <div class="stat-value">${totalTests}</div>
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
        <div class="stat-value">${(totalDurationMs / 1000).toFixed(1)}s</div>
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
}
