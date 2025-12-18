### Testinator (extended)

Testinator is a **Node/TypeScript CLI** that runs **Markdown-written E2E specs** by handing them to an LLM that can **call Playwright browser actions via MCP (Model Context Protocol)**. The LLM drives a real headless browser and then returns a structured pass/fail result.

### Repo map (the important files)

- **CLI entrypoint**: `src/cli.ts`
  - Parses arguments, loads `.env`, validates provider env vars, and calls the runner.
- **Runner + report generator**: `src/main.ts`
  - Finds `*.md` specs in a folder, runs them sequentially, and writes an HTML report.
- **Agent (LLM + Playwright MCP bridge)**: `src/agent.ts`
  - Spawns Playwright MCP as a subprocess, exposes MCP tools to the model, and extracts `report_result`.
- **LLM Provider Factory**: `src/llm-providers.ts`
  - Creates language model instances for each supported provider (OpenAI, Anthropic, Azure, Google).
- **Azure Compatibility**: `src/azure-compat.ts`
  - Normalizes tool schemas for Azure OpenAI's stricter requirements.
- **Prompt Builder**: `src/prompt-builder.ts`
  - Constructs the system prompt for the E2E testing agent.
- **Browser Manager**: `src/browser-setup.ts`
  - Singleton class managing browser detection and Playwright installation.
- **Types + defaults**: `src/types.ts`
  - Defines the result schema and the default model per provider.
- **Example spec**: `examples/specs/homepage-smoke.md`
  - Example of the markdown “spec language” (it’s instructions, not a parsed DSL).

### High-level lifecycle of a test run

1. You run the CLI (e.g. `testinator ./specs --base-url https://your-app.com`).
2. The CLI validates inputs and environment variables.
3. The runner (`Main.run`) performs a quick LLM connectivity check.
4. The runner finds `*.md` files in the specified folder (recursive), excluding `reports/` and `AUTH_LOGIN.md`.
5. For each spec file, the runner calls the agent (`runSpec`).
6. The agent starts Playwright MCP (headless) and asks the LLM to execute the markdown spec using MCP browser tools.
7. The LLM is expected to call `report_result { success, details }` at the end.
8. The runner writes report artifacts to `<specFolder>/reports/`:
   - `index.html` (static shell)
   - `summary.js` (data loaded by `index.html`, compatible with file:// double-click open)
   - `images/*.jpg` (final-state screenshots, one per spec)
   The runner updates `summary.js` (and rewrites `index.html`) as specs complete, so the report can be generated “on the fly”.
9. The CLI exits with `0` if all passed, otherwise `1`.

---

### Step-by-step: CLI → Runner

#### 1) Environment loading

The CLI begins with:

- `import 'dotenv/config';`

This loads environment variables from a `.env` file in the current working directory (standard `dotenv` behavior).

#### 2) Argument parsing and validation

`src/cli.ts` accepts:

- **Positional**: `<spec-folder>` (path to folder containing `.md` specs)
- **Required flag**: `--base-url <url>`
- **Optional flags**:
  - `--provider <openai|anthropic|azure|google>`
  - `--model <modelName>`

Defaults:

- Provider defaults to `openai` unless overridden by:
  - `TESTINATOR_PROVIDER`, or
  - `--provider`
- Model defaults to:
  - `TESTINATOR_MODEL`, or
  - the provider’s default from `DEFAULT_MODELS` (in `src/types.ts`)

Validation performed by the CLI:

- Spec folder exists and is a directory
- `--base-url` parses as a valid URL
- Provider is one of `openai`, `anthropic`, `azure`, `google`
- Provider-required environment variables are present:
  - `openai`: `OPENAI_API_KEY`
  - `anthropic`: `ANTHROPIC_API_KEY`
  - `azure`: `AZURE_OPENAI_API_KEY` and `AZURE_OPENAI_RESOURCE_NAME`
  - `google`: `GOOGLE_API_KEY`

If any required input is missing, it prints usage and exits non-zero.

#### 3) Calling the runner

Once inputs are valid, the CLI instantiates the runner:

- `const runner = new Main();`
- `await runner.run(specFolder, baseUrl, provider, model);`

After the run finishes, it prints a summary and exits with:

- `0` if all passed
- `1` if any failed or fatal error occurs

---

### Step-by-step: Runner (`Main.run`) → Spec execution → HTML report

#### 1) Connectivity check

Before running any tests, `src/main.ts` calls:

- `checkLLMConnection(provider, model)`

This sends a tiny prompt ("Reply with just \"ok\"") to ensure the chosen provider/model is reachable.

#### 2) Spec discovery (recursive)

The runner lists directory entries and selects files that:

- are regular files
- end with `.md` (case-insensitive)

Important behavior:

- **Recursive**: scans subfolders too.
- Skips the `reports/` folder.
- Skips `AUTH_LOGIN.md`.
- Sorted by path.

#### 3) Spec execution

For each `.md` file:

- Reads markdown text from disk
- Calls `runSpec(markdown, baseUrl, specName, provider, model)`
- Records a `TestResult`:
  - `success` (boolean)
  - `details` (string)
  - `durationMs`

Specs run in **parallel by default** using a pool of isolated MCP clients (configurable concurrency).

#### 4) Report output (`reports/`)

The runner writes:

- `<specFolder>/reports/index.html` (static report shell)
- `<specFolder>/reports/summary.js` (report data loaded by `index.html`)
- `<specFolder>/reports/images/*.jpg` (final-state screenshot per spec)

The report includes:

- Total/passed/failed counts
- Per-spec cards showing:
  - pass/fail badge
  - duration
  - `details` text (pre-wrapped)

This is a standalone static HTML report that references images from the `reports/images/` folder and loads its data from `summary.js` (so it works when opened via file://).

---

### Step-by-step: Agent (`runSpec`) and the Playwright MCP bridge

`src/agent.ts` is where “AI E2E testing” actually happens.

#### 1) Browser availability (system Chromium first, then Playwright install)

Before starting MCP, the agent calls `ensurePlaywrightBrowsers()` once per process.

It:

- Attempts to locate **system-installed Chrome/Chromium** (OS-specific candidate paths).
- On Linux/macOS it also tries `which chromium`, `which chromium-browser`, `which google-chrome`.
- If a system browser is found, it stores the path in `chromiumPath`.

If no system browser is found:

- It runs `npx playwright install chromium`.
  - On Windows it spawns via `cmd.exe /c npx playwright install chromium`.

Notes:

- This code marks browsers as “ensured” even if the install fails (it warns but resolves), which means later runs won’t retry within the same process.

#### 2) Spawning the Playwright MCP server

The agent does **not** import Playwright directly. Instead it spawns an MCP server:

- `npx @playwright/mcp@latest --headless`
- If `chromiumPath` exists, it also includes:
  - `--executable-path <chromiumPath>`

Transport:

- Uses an stdio transport (`Experimental_StdioMCPTransport`) to communicate with the MCP subprocess.
- On Windows, it spawns `cmd.exe` to properly resolve `npx`.

Then it creates an MCP client:

- `experimental_createMCPClient({ transport })`

This MCP client can ask the server what tools it provides.

#### 3) Creating the toolset for the model

The agent collects Playwright tools by calling:

- `const mcpTools = await mcpClient.tools();`

Those tools are functions like “navigate”, “click”, “type”, “screenshot”, etc. (whatever `@playwright/mcp` exposes).

Then it defines an extra local tool:

- `report_result`

This is the tool the model must call at the end to produce structured output. Its schema is defined by `AgentResultSchema`:

- `success: boolean`
- `details: string`

All tools passed to the model are:

- `...mcpTools`
- `report_result`

Azure-specific handling:

- If provider is `azure`, tool schemas are normalized to satisfy Azure OpenAI’s stricter function schema requirements.
- The normalization forces object properties to appear in `required` recursively.

#### 4) The system prompt (what the LLM is told to do)

The system prompt is built by `buildSystemPrompt(baseUrl, specName)`.

Key instructions it gives the model:

- You are an automated E2E test runner.
- Base URL and current spec name are provided.
- Read the markdown spec.
- Use Playwright browser tools to navigate and interact.
- If anything required cannot be found or fails, the test should fail.
- When finished, call `report_result` with:
  - `success: true` only if all requirements were met
  - `details`: factual summary (pages visited, elements checked, errors)

The markdown spec file is passed as the *user* prompt (raw markdown content).

#### 5) The LLM tool-calling loop

The agent calls `generateText(...)` from the `ai` SDK:

- `system`: the E2E runner instructions
- `prompt`: markdown spec content
- `tools`: MCP tools + `report_result`
- `maxSteps: 50`

During execution:

- The model alternates between reasoning and tool calls.
- Tool calls are executed by the SDK; MCP tool calls are sent to the Playwright MCP server.
- The Playwright MCP server drives a real headless browser and returns results.
- The agent logs tool usage per step via `onStepFinish`.

#### 6) Extracting the final result

After the run finishes, the agent:

- Scans `result.steps` for a `report_result` tool call.
- If found, it returns the parsed `{ success, details }` object.

Fallback behavior if the model never calls `report_result`:

- It inspects `result.text` and heuristically sets success if the text contains “pass” and not “fail”.
- Otherwise, it returns `success: false` with a default message.

Finally:

- It closes the MCP client (`await mcpClient.close()`), which shuts down the MCP subprocess.

---

### What “Markdown specs” really are in this tool

Specs are **not** parsed into a formal test language. The markdown file is simply sent to the model as instructions.

That means:

- The “test runner logic” (how to interpret requirements like “verify HTTP 200”) is mostly delegated to the model.
- The quality and clarity of the markdown spec can significantly affect reliability.

Example (`examples/specs/homepage-smoke.md`) includes checks like:

- navigate to homepage
- verify HTTP 200
- visible title/heading
- no JS console errors

Whether those are all possible depends on what tools Playwright MCP exposes (e.g. console capture, response status, etc.) and how the model chooses to verify them.

---

### Practical implications / constraints

- **Non-determinism**: outcomes can vary across models and runs because the model decides what actions to take.
- **Sequential execution**: specs run one-by-one; long runs can be slow.
- **Folder scan is non-recursive**: nested spec folders won’t be picked up.
- **Reporting is simple**: each spec produces only `{ success, details }`; the HTML report renders those strings.
- **Browser install behavior**: if Playwright browser install fails, the tool continues (it warns) and may fail later when MCP tries to run.
- **Azure schema normalization**: special casing exists because Azure can reject tool schemas unless required fields are specified in a particular way.

---

### Quick “mental model” summary

- The CLI is a thin wrapper around `Main.run`.
- `Main.run` is a sequential spec runner + HTML report generator.
- `runSpec` is the core: it starts Playwright MCP, gives the model MCP tools, and the model “drives the browser” to satisfy the markdown.
- The only structured output is the model’s call to `report_result`.
