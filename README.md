# Testinator

Spec Driven E2E Testing via AI Agent steering playwright

## Setup

For an Azure OpenAI-compatible endpoint with `gpt-6-luna`, configure:

```env
TESTINATOR_PROVIDER=azure-openai
TESTINATOR_MODEL=gpt-6-luna
AZURE_BASE_URL=https://your-endpoint/openai/v1
```

Provide `AZURE_API_KEY` through the process environment or a secret manager before running the CLI. Keep the key out of version control.

GPT-6 runs through Azure AI Foundry's Responses API so it can use browser function tools with `xhigh` reasoning.

## RUN IT

```bash
npm ci
npm run build
```
```bash
npx testinator ./specs --base-url https://your-app.com
```
or
```bash
 node dist/cli.js ./examples/specs --base-url https://maps.google.com
```

### Report output

Each run writes a fresh report folder inside your spec folder:

- `./specs/reports/index.html` (summary report)
- `./specs/reports/images/*.jpg` (final-state screenshots, one per spec)

### Options

- `--provider <provider>` - LLM provider: openai, anthropic, azure, azure-openai, google (default: openai unless set in `.env`)
- `--model <model>` - Model name (defaults to provider's recommended model)
- `--headed` - Run browser in headed mode (visible browser window)
- `--sequential` - Run specs one at a time (default: parallel with CPU core count)

| Provider | Required Env Vars |
|----------|-------------------|
| `openai` | `OPENAI_API_KEY` |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `azure` | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_RESOURCE_NAME` |
| `azure-openai` | `AZURE_API_KEY`, `AZURE_BASE_URL` |
| `google` | `GOOGLE_API_KEY` |
