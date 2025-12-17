import { type LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { type LLMProvider, DEFAULT_MODELS } from './types.js';

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
      const resourceOrUrl = process.env.AZURE_OPENAI_BASE_URL || process.env.AZURE_OPENAI_RESOURCE_NAME || '';
      
      // Extract resource name from full URL if provided (e.g., https://my-resource.openai.azure.com -> my-resource)
      let resourceName: string;
      if (resourceOrUrl.includes('.openai.azure.com') || resourceOrUrl.includes('.cognitiveservices.azure.com')) {
        const match = resourceOrUrl.match(/https?:\/\/([^.]+)\./);
        resourceName = match ? match[1] : resourceOrUrl;
      } else {
        resourceName = resourceOrUrl;
      }
      
      console.log(`    [Azure] Using resource: ${resourceName}, deployment: ${modelName}`);
      
      const azure = createAzure({
        apiKey: process.env.AZURE_OPENAI_API_KEY,
        resourceName,
      });
      return azure(modelName);
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
