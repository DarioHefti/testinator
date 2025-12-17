#!/usr/bin/env node

import 'dotenv/config';
import { existsSync, statSync } from 'node:fs';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { Main } from './main.js';
import { type LLMProvider, DEFAULT_MODELS } from './types.js';

interface CliArgs {
  specFolder: string;
  baseUrl: string;
  provider: LLMProvider;
  model?: string;
  headless: boolean;
  concurrency: number;
}

const VALID_PROVIDERS = ['openai', 'anthropic', 'azure', 'google'] as const;

function printUsage(): void {
  console.log(`
Usage: testinator <spec-folder> --base-url <url> [options]

Arguments:
  <spec-folder>           Path to folder containing .md spec files

Required:
  --base-url <url>        Base URL of the application under test

Options:
  --provider <provider>   LLM provider: openai, anthropic, azure, google (default: openai)
  --model <model>         Model name (defaults to provider's recommended model)
  --headed                Run browser in headed mode (visible browser window)
  --sequential            Run specs one at a time (default: parallel with CPU core count)
  --help, -h              Show this help message

Environment Variables:
  TESTINATOR_PROVIDER     Default LLM provider (overridden by --provider)
  TESTINATOR_MODEL        Default model name (overridden by --model)
  
  OPENAI_API_KEY          Required for OpenAI provider
  ANTHROPIC_API_KEY       Required for Anthropic provider
  AZURE_OPENAI_API_KEY    Required for Azure provider
  AZURE_OPENAI_RESOURCE_NAME  Required for Azure provider
  GOOGLE_API_KEY          Required for Google provider

Default Models:
  openai:    ${DEFAULT_MODELS.openai}
  anthropic: ${DEFAULT_MODELS.anthropic}
  azure:     ${DEFAULT_MODELS.azure}
  google:    ${DEFAULT_MODELS.google}

Examples:
  testinator ./specs --base-url https://example.com
  testinator ./specs --base-url https://example.com --provider anthropic
  testinator ./specs --base-url https://example.com --provider openai --model gpt-4-turbo
  testinator ./specs --base-url https://example.com --headed
  testinator ./specs --base-url https://example.com --sequential
`);
}

function parseArgs(argv: string[]): CliArgs | null {
  const args = argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    return null;
  }

  let specFolder: string | undefined;
  let baseUrl: string | undefined;
  
  // Start with env var defaults, CLI args will override
  let provider: LLMProvider = 'openai';
  let model: string | undefined = process.env.TESTINATOR_MODEL;
  let headless = true;
  let concurrency = cpus().length;

  // Check TESTINATOR_PROVIDER env var
  const envProvider = process.env.TESTINATOR_PROVIDER;
  if (envProvider) {
    if (!VALID_PROVIDERS.includes(envProvider as typeof VALID_PROVIDERS[number])) {
      console.error(`Error: Invalid TESTINATOR_PROVIDER "${envProvider}". Must be one of: ${VALID_PROVIDERS.join(', ')}`);
      return null;
    }
    provider = envProvider as LLMProvider;
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--base-url') {
      baseUrl = args[++i];
    } else if (arg === '--provider') {
      const p = args[++i];
      if (!VALID_PROVIDERS.includes(p as typeof VALID_PROVIDERS[number])) {
        console.error(`Error: Invalid provider "${p}". Must be one of: ${VALID_PROVIDERS.join(', ')}`);
        return null;
      }
      provider = p as LLMProvider;
    } else if (arg === '--model') {
      model = args[++i];
    } else if (arg === '--headed') {
      headless = false;
    } else if (arg === '--sequential') {
      concurrency = 1;
    } else if (!arg.startsWith('-')) {
      specFolder = arg;
    }
  }

  if (!specFolder) {
    console.error('Error: Missing required argument <spec-folder>');
    printUsage();
    return null;
  }

  if (!baseUrl) {
    console.error('Error: Missing required argument --base-url');
    printUsage();
    return null;
  }

  // Validate base URL format
  try {
    new URL(baseUrl);
  } catch {
    console.error(`Error: Invalid URL format for --base-url: ${baseUrl}`);
    return null;
  }

  // Resolve and validate folder path
  const resolvedFolder = resolve(process.cwd(), specFolder);

  if (!existsSync(resolvedFolder)) {
    console.error(`Error: Spec folder does not exist: ${resolvedFolder}`);
    return null;
  }

  if (!statSync(resolvedFolder).isDirectory()) {
    console.error(`Error: Spec folder is not a directory: ${resolvedFolder}`);
    return null;
  }

  // Validate required environment variables for the provider
  const envErrors = validateProviderEnv(provider);
  if (envErrors.length > 0) {
    console.error(`Error: Missing environment variables for ${provider} provider:`);
    envErrors.forEach((e) => console.error(`  - ${e}`));
    return null;
  }

  return {
    specFolder: resolvedFolder,
    baseUrl,
    provider,
    model,
    headless,
    concurrency,
  };
}

function validateProviderEnv(provider: LLMProvider): string[] {
  const errors: string[] = [];

  switch (provider) {
    case 'openai':
      if (!process.env.OPENAI_API_KEY) errors.push('OPENAI_API_KEY');
      break;
    case 'anthropic':
      if (!process.env.ANTHROPIC_API_KEY) errors.push('ANTHROPIC_API_KEY');
      break;
    case 'azure':
      if (!process.env.AZURE_OPENAI_API_KEY) errors.push('AZURE_OPENAI_API_KEY');
      if (!process.env.AZURE_OPENAI_RESOURCE_NAME) errors.push('AZURE_OPENAI_RESOURCE_NAME');
      break;
    case 'google':
      if (!process.env.GOOGLE_API_KEY) errors.push('GOOGLE_API_KEY');
      break;
  }

  return errors;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (!args) {
    process.exit(1);
  }

  const modelDisplay = args.model || DEFAULT_MODELS[args.provider];

  console.log(`\n🧪 Testinator - AI E2E Testing Agent`);
  console.log(`   Spec folder: ${args.specFolder}`);
  console.log(`   Base URL: ${args.baseUrl}`);
  console.log(`   Provider: ${args.provider}`);
  console.log(`   Model: ${modelDisplay}`);
  console.log(`   Browser: ${args.headless ? 'headless' : 'headed'}`);
  console.log(`   Concurrency: ${args.concurrency === 1 ? 'sequential' : args.concurrency}\n`);

  try {
    const runner = new Main();
    const summary = await runner.run(args.specFolder, args.baseUrl, args.provider, args.model, args.headless, args.concurrency);

    // Print summary to console
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Test Summary:`);
    console.log(`  Total: ${summary.results.length}`);
    console.log(`  Passed: ${summary.results.filter((r) => r.success).length}`);
    console.log(`  Failed: ${summary.results.filter((r) => !r.success).length}`);
    console.log(`  Duration: ${(summary.totalDurationMs / 1000).toFixed(2)}s`);
    console.log(`${'='.repeat(60)}\n`);

    // Exit with appropriate code
    process.exit(summary.allPassed ? 0 : 1);
  } catch (error) {
    console.error('Fatal error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
