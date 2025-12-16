# Testinator

AI-powered E2E testing agent using Playwright MCP.

## Quick Start

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

