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
 node dist/cli.js ./examples/specs --base-url https://maps.google.com
```

### Report output

Each run writes a fresh report folder inside your spec folder:

- `./specs/reports/index.html` (summary report)
- `./specs/reports/summary.js` (report data loaded by `index.html` for file:// compatibility)
- `./specs/reports/images/*.jpg` (final-state screenshots, one per spec)
- `./specs/reports/images/auth_login.jpg` (auth page screenshot, if using authentication)

### Authentication

If your app requires login, add an `AUTH_LOGIN.md` file to the root of your specs folder. The agent will run this spec first, capture the session, and use it for all subsequent tests.

Example `AUTH_LOGIN.md`:
```markdown
Go to the mainpage
Login as user

username:admin
password:admin123

You should see the main application with a logout button.
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