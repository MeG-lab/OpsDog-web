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
      intentHints: Array.isArray(server.capabilities?.intentHints)
        ? server.capabilities.intentHints
        : [],
      skillPackageId: typeof server.capabilities?.skillPackageId === 'string'
        ? server.capabilities.skillPackageId
        : undefined,
      skillPackageKind: server.capabilities?.skillPackageKind === 'instruction-only' || server.capabilities?.skillPackageKind === 'executable'
        ? server.capabilities.skillPackageKind
        : undefined,
    })));
