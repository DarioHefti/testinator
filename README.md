# Testinator

Spec Driven E2E Testing via AI Agent steering playwright

## Setup

Create a `.env` file:

```env
# Required: API key for your provider
OPENAI_API_KEY=sk-...
# or
ANTHROPIC_API_KEY=sk-ant-...
# or
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_RESOURCE_NAME=your-resource-name-or-full-url
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
or
```bash
node dist/ ./specs --base-url https://your-app.com
```

### Options

- `--provider <provider>` - LLM provider: openai, anthropic, azure, google (default: openai)
- `--model <model>` - Model name (defaults to provider's recommended model)
- `--headed` - Run browser in headed mode (visible browser window)
- `--sequential` - Run specs one at a time (default: parallel with CPU core count)

| Provider | Required Env Vars |
|----------|-------------------|
| `openai` | `OPENAI_API_KEY` |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `azure` | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_RESOURCE_NAME` |
| `google` | `GOOGLE_API_KEY` |