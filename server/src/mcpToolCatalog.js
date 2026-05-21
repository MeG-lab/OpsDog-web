export const MCP_RISK_LEVELS = new Set(['read-only', 'state-change', 'destructive']);

export const normalizeMcpRiskLevel = (value, fallback = 'read-only') =>
  MCP_RISK_LEVELS.has(value) ? value : fallback;

export const getMcpRequiredFields = (schema) => {
  const required = schema && typeof schema === 'object' ? schema.required : null;
  return Array.isArray(required) ? required.map((item) => String(item)).filter(Boolean) : [];
};

export const normalizeMcpTool = (server, tool) => {
  const serverName = String(server?.name || tool?.serverName || '').trim();
  const toolName = String(tool?.name || '').trim();
  const inputSchema = tool?.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : {};
  const toolEnabledOverrides = server?.toolEnabledOverrides || {};
  const hasEnabledOverride = Object.prototype.hasOwnProperty.call(toolEnabledOverrides, toolName);
  const enabled = hasEnabledOverride ? toolEnabledOverrides[toolName] !== false : tool?.enabled !== false;
  const riskLevel = normalizeMcpRiskLevel(
    server?.toolRiskOverrides?.[toolName] || tool?.riskLevel || server?.riskLevel,
  );

  return {
    id: `${serverName}/${toolName}`,
    name: toolName,
    description: String(tool?.description || ''),
    inputSchema,
    serverName,
    transport: server?.transport || tool?.transport || 'stdio',
    riskLevel,
    enabled,
    requiredFields: getMcpRequiredFields(inputSchema),
  };
};

export const normalizeMcpTools = (server, tools = []) =>
  (Array.isArray(tools) ? tools : [])
    .map((tool) => normalizeMcpTool(server, tool))
    .filter((tool) => tool.name && tool.serverName);

export const buildMcpToolCatalog = (records = []) =>
  records
    .filter((record) => record.connected && record.enabled !== false && record.capabilityEnabled !== false)
    .flatMap((record) => normalizeMcpTools(record, record.tools).filter((tool) => tool.enabled !== false));
