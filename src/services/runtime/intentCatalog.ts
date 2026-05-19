import type { ServerDefinition } from '../../types';
import type { IntentToolCandidate } from './types';

export const buildIntentToolCatalog = (servers: ServerDefinition[]): IntentToolCandidate[] =>
  servers
    .filter((server) => server.enabled !== false)
    .flatMap((server) => (server.capabilities?.tools || []).map((tool) => ({
      serverId: server.id,
      serverName: server.name,
      category: server.category,
      serverDescription: server.description || '',
      toolName: tool.name,
      toolDescription: tool.description || '',
      inputSchema: tool.inputSchema || server.capabilities?.inputSchema,
      execution: tool.execution,
      outputMode: tool.outputMode,
      usageExamples: Array.isArray(server.capabilities?.usageExamples)
        ? server.capabilities.usageExamples
        : [],
      legacyIntentHints: Array.isArray(server.capabilities?.legacyIntentHints)
        ? server.capabilities.legacyIntentHints
        : [],
      defaultArgs: Array.isArray(server.capabilities?.defaultArgs)
        ? server.capabilities.defaultArgs
        : [],
    })));
