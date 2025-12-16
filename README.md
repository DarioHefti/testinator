# Testinator

AI-powered E2E testing agent using Playwright MCP.

## Setup

Create a `.env` file:

```env
# Required: API key for your provider
OPENAI_API_KEY=sk-...
# or
ANTHROPIC_API_KEY=sk-ant-...
# or
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_RESOURCE_NAME=your-resource
# or
GOOGLE_API_KEY=...

# Optional: Set defaults (CLI args override these)
TESTINATOR_PROVIDER=openai
TESTINATOR_MODEL=gpt-4o
```

## RUN IT

```bash
npm run build
```
```bash
npx testinator ./specs --base-url https://your-app.com
```

| Provider | Required Env Vars |
|----------|-------------------|
| `openai` | `OPENAI_API_KEY` |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `azure` | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_RESOURCE_NAME` |
| `google` | `GOOGLE_API_KEY` |