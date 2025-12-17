import { type CoreTool } from 'ai';

/**
 * Normalize tool schemas for Azure OpenAI compatibility.
 * Azure requires all properties to be in the 'required' array.
 * Single responsibility: Azure-specific schema normalization.
 */
export function normalizeToolsForAzure(tools: Record<string, CoreTool>): Record<string, CoreTool> {
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
