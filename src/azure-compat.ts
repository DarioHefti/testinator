import { type Tool } from 'ai';

/**
 * Normalize tool schemas for Azure OpenAI compatibility.
 * Azure requires all properties to be in the 'required' array.
 * Single responsibility: Azure-specific schema normalization.
 */
export function normalizeToolsForAzure(tools: Record<string, Tool>): Record<string, Tool> {
  for (const toolDef of Object.values(tools)) {
    const tool = toolDef as Record<string, unknown>;
    
    // Try different possible schema locations
    if (tool.parameters) {
      const params = tool.parameters as Record<string, unknown>;
      
      // Check for jsonSchema wrapper (MCP tools)
      if ('jsonSchema' in params && params.jsonSchema) {
        normalizeSchema(params.jsonSchema as Record<string, unknown>);
      }
      // Check for direct schema properties
      else if (params.type === 'object' && params.properties) {
        normalizeSchema(params);
      }
    }
  }
  
  return tools;
}

/**
 * Adapt the legacy OpenAI SDK request shape for GPT-6 reasoning models.
 * The Responses API expects reasoning effort in a nested object and default-only sampling.
 */
export function adaptGpt6ResponsesBody(body: string): string {
  let parsedBody: unknown;

  try {
    parsedBody = JSON.parse(body);
  } catch {
    return body;
  }

  if (!isRecord(parsedBody) || parsedBody.model !== 'gpt-6-luna') {
    return body;
  }

  const compatibleBody = { ...parsedBody };
  const maxTokens = compatibleBody.max_tokens;

  if (typeof maxTokens === 'number') {
    delete compatibleBody.max_tokens;
    compatibleBody.max_output_tokens ??= maxTokens;
  }

  for (const parameter of [
    'temperature',
    'top_p',
    'frequency_penalty',
    'presence_penalty',
    'logit_bias',
    'logprobs',
    'top_logprobs',
    'reasoning_effort',
  ]) {
    delete compatibleBody[parameter];
  }

  const reasoning = isRecord(compatibleBody.reasoning) ? compatibleBody.reasoning : {};
  compatibleBody.reasoning = { ...reasoning, effort: 'xhigh' };

  for (const promptField of ['input', 'messages']) {
    const prompt = compatibleBody[promptField];
    if (Array.isArray(prompt)) {
      compatibleBody[promptField] = (prompt as unknown[]).map((message: unknown) => {
        if (!isRecord(message) || message.role !== 'system') {
          return message;
        }

        return { ...message, role: 'developer' };
      });
    }
  }

  return JSON.stringify(compatibleBody);
}

/**
 * Recursively normalize a JSON schema to ensure all properties are required.
 */
function normalizeSchema(schema: Record<string, unknown>): void {
  if (!schema || typeof schema !== 'object') return;
  
  if (schema.type === 'object' && schema.properties) {
    const props = schema.properties as Record<string, unknown>;
    const propNames = Object.keys(props);
    
    // Make all properties required
    if (propNames.length > 0) {
      schema.required = propNames;
    }
    
    // Recursively normalize nested objects
    for (const prop of Object.values(props)) {
      if (prop && typeof prop === 'object') {
        normalizeSchema(prop as Record<string, unknown>);
      }
    }
  }
  
  // Handle arrays with items
  if (schema.type === 'array' && schema.items && typeof schema.items === 'object') {
    normalizeSchema(schema.items as Record<string, unknown>);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
