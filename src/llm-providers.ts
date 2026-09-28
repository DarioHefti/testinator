import { type LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { type LLMProvider, DEFAULT_MODELS } from './types.js';
import { adaptGpt6ResponsesBody } from './azure-compat.js';

/**
 * Get the language model instance based on provider and model name.
 * Single responsibility: LLM provider factory.
 */
export function getLanguageModel(provider: LLMProvider, model?: string): LanguageModel {
  const modelName = model || DEFAULT_MODELS[provider];

  switch (provider) {
    case 'openai': {
      const openai = createOpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
      return openai(modelName);
    }
    case 'anthropic': {
      const anthropic = createAnthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
      });
      return anthropic(modelName);
    }
    case 'azure': {
      const resourceValue = process.env.AZURE_OPENAI_RESOURCE_NAME || '';
      
      // Extract resource name from full URL if provided (e.g., https://my-resource.openai.azure.com -> my-resource)
      let resourceName: string;
      if (resourceValue.includes('.openai.azure.com') || resourceValue.includes('.cognitiveservices.azure.com')) {
        const match = resourceValue.match(/https?:\/\/([^.]+)\./);
        resourceName = match ? match[1] : resourceValue;
      } else {
        resourceName = resourceValue;
      }
      
      const azure = createAzure({
        apiKey: process.env.AZURE_OPENAI_API_KEY,
        resourceName,
      });
      return azure(modelName);
    }
    case 'azure-openai': {
      const apiKey = process.env.AZURE_API_KEY;
      const baseURL = process.env.AZURE_BASE_URL;

      if (!apiKey) {
        throw new Error('AZURE_API_KEY is required for the azure-openai provider');
      }
      if (!baseURL) {
        throw new Error('AZURE_BASE_URL is required for the azure-openai provider');
      }

      const openai = createOpenAI({
        apiKey,
        baseURL,
        name: 'azure-openai',
        compatibility: 'compatible',
        fetch: (input, init) => {
          const body = init?.body;
          if (typeof body !== 'string') {
            return globalThis.fetch(input, init);
          }

          const compatibleBody = adaptGpt6ResponsesBody(body);
          return globalThis.fetch(input, compatibleBody === body ? init : { ...init, body: compatibleBody });
        },
      });

      if (modelName === 'gpt-6-luna') {
        return openai.responses(modelName);
      }

      return openai(modelName);
    }
    case 'google': {
      const google = createGoogleGenerativeAI({
        apiKey: process.env.GOOGLE_API_KEY,
      });
      return google(modelName);
    }
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}
