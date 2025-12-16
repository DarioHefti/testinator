# Testinator

AI-powered E2E testing agent using Playwright MCP.

## Quick Start (npx)

Run directly without installation:

```bash
npx testinator ./specs --base-url https://your-app.com
```

## CI/CD Usage

```yaml
# GitHub Actions example
- name: Run E2E Tests
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
  run: npx testinator ./specs --base-url https://your-app.com
```

```yaml
# With Azure OpenAI
- name: Run E2E Tests
  env:
    AZURE_OPENAI_API_KEY: ${{ secrets.AZURE_OPENAI_API_KEY }}
    AZURE_OPENAI_RESOURCE_NAME: ${{ secrets.AZURE_OPENAI_RESOURCE_NAME }}
  run: npx testinator ./specs --base-url https://your-app.com --provider azure
```

## Local Development

```powershell
# Install
npm install

# Build
npm run build

# Option 1: Use .env file (recommended)
# Create .env file in the project root (same directory as package.json):
# AZURE_OPENAI_API_KEY=your-api-key
# AZURE_OPENAI_RESOURCE_NAME=your-resource-name

# Option 2: Set environment variables in PowerShell
$env:AZURE_OPENAI_API_KEY = "your-api-key"
$env:AZURE_OPENAI_RESOURCE_NAME = "your-resource-name"

# Run with Azure OpenAI GPT-5.1
node dist/cli.js .\examples\specs --base-url https://cv-forger.erninet.ch --provider azure --model gpt-5.1
```

## CLI Options

```
Usage: testinator <spec-folder> --base-url <url> [options]

Arguments:
  <spec-folder>           Path to folder containing .md spec files

Required:
  --base-url <url>        Base URL of the application under test

Options:
  --provider <provider>   LLM provider: openai, anthropic, azure, google (default: openai)
  --model <model>         Model name (defaults to provider's recommended model)
  --help, -h              Show this help message
```

## Environment Variables

Save your `.env` file in the **project root** (same directory as `package.json`):

```env
AZURE_OPENAI_API_KEY=your-api-key
AZURE_OPENAI_RESOURCE_NAME=your-resource-name
```

## Providers

| Provider | Env Vars |
|----------|----------|
| `openai` | `OPENAI_API_KEY` |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `azure` | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_RESOURCE_NAME` |
| `google` | `GOOGLE_API_KEY` |

