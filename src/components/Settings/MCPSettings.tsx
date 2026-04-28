import React from 'react';
import { Plus, Trash2, Wifi, WifiOff, Terminal as TerminalIcon, RefreshCw, Zap } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';

interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
  transport: 'stdio';
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  connecting: boolean;
}

interface MCPToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverName: string;
}

const MCPSettings: React.FC = () => {
  const [servers, setServers] = React.useState<MCPServerConfig[]>([
    {
      name: 'filesystem',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users'],
      transport: 'stdio',
      enabled: false,
      connected: false,
      toolCount: 0,
      connecting: false,
    },
  ]);
  const [tools, setTools] = React.useState<MCPToolInfo[]>([]);
  const [showAddForm, setShowAddForm] = React.useState(false);
  const [newServer, setNewServer] = React.useState({ name: '', command: '', args: '' });

  const handleConnect = async (index: number) => {
    const server = servers[index];
    const updated = [...servers];
    updated[index] = { ...updated[index], connecting: true };
    setServers(updated);

    try {
      const discoveredTools = await invoke<MCPToolInfo[]>('connect_mcp_server', {
        serverConfig: {
          name: server.name,
          command: server.command,
          args: server.args,
          env: {},
        },
      });

      updated[index] = {
        ...updated[index],
        connected: true,
        connecting: false,
        enabled: true,
        toolCount: discoveredTools.length,
      };
      setServers([...updated]);

      // Refresh tools list
      const allTools = await invoke<MCPToolInfo[]>('list_mcp_tools');
      setTools(allTools);
    } catch (error) {
      console.error('Failed to connect MCP server:', error);
      updated[index] = { ...updated[index], connecting: false };
      setServers([...updated]);
    }
  };

  const handleDisconnect = async (index: number) => {
    const server = servers[index];
    try {
      await invoke('disconnect_mcp_server', { serverName: server.name });
      const updated = [...servers];
      updated[index] = { ...updated[index], connected: false, enabled: false, toolCount: 0 };
      setServers(updated);
      setTools(tools.filter(t => t.serverName !== server.name));
    } catch (error) {
      console.error('Failed to disconnect:', error);
    }
  };

  const handleAddServer = () => {
    if (!newServer.name || !newServer.command) return;
    setServers([...servers, {
      name: newServer.name,
      command: newServer.command,
      args: newServer.args.split(' ').filter(Boolean),
      transport: 'stdio',
      enabled: false,
      connected: false,
      toolCount: 0,
      connecting: false,
    }]);
    setNewServer({ name: '', command: '', args: '' });
    setShowAddForm(false);
  };

  const inputStyle: React.CSSProperties = {
    backgroundColor: 'var(--color-bg-input)',
    border: '1px solid var(--color-border-light)',
    borderRadius: '10px',
    padding: '8px 12px',
    fontSize: '14px',
    color: 'var(--color-text-primary)',
    outline: 'none',
    width: '100%',
    fontFamily: 'var(--font-sans)',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '13px',
    fontWeight: 500,
    color: 'var(--color-text-secondary)',
    marginBottom: '4px',
    display: 'block',
  };

  return (
    <div>
      <h2 className="text-lg font-semibold mb-1" style={{ color: 'var(--color-text-primary)' }}>
        MCP Server 配置
      </h2>
      <p className="text-sm mb-6" style={{ color: 'var(--color-text-tertiary)' }}>
        配置 Model Context Protocol 服务器连接，扩展 AI 的工具调用能力
      </p>

      {/* Server List */}
      <div className="space-y-3 mb-6">
        {servers.map((server, index) => (
          <div
            key={index}
            className="rounded-2xl p-4"
            style={{
              backgroundColor: 'var(--color-bg-card)',
              border: `1px solid ${server.connected ? 'var(--color-accent-green)' : 'var(--color-border-light)'}`,
              boxShadow: 'var(--shadow-card)',
              opacity: server.connecting ? 0.8 : 1,
            }}
          >
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <TerminalIcon size={14} style={{ color: server.connected ? 'var(--color-accent-green)' : 'var(--color-accent-warm)' }} />
                <span className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>
                  {server.name}
                </span>
                <span className="text-xs px-2 py-0.5 rounded-md" style={{ backgroundColor: 'var(--color-bg-secondary)', color: 'var(--color-text-tertiary)' }}>
                  {server.transport}
                </span>
                {server.connected && (
                  <span className="text-xs px-2 py-0.5 rounded-md flex items-center gap-1" style={{ backgroundColor: 'rgba(143, 185, 150, 0.15)', color: 'var(--color-accent-green)' }}>
                    <Zap size={10} />
                    {server.toolCount} tools
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {server.connected ? (
                  <button
                    onClick={() => handleDisconnect(index)}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs transition-colors cursor-pointer"
                    style={{ color: 'var(--color-accent-green)', backgroundColor: 'rgba(143, 185, 150, 0.1)' }}
                    onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(143, 185, 150, 0.2)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'rgba(143, 185, 150, 0.1)'; }}
                  >
                    <Wifi size={12} /> 已连接
                  </button>
                ) : (
                  <button
                    onClick={() => handleConnect(index)}
                    disabled={server.connecting}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs transition-colors cursor-pointer"
                    style={{ color: 'var(--color-text-secondary)', backgroundColor: 'var(--color-bg-button)' }}
                    onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--color-bg-button-hover)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--color-bg-button)'; }}
                  >
                    {server.connecting ? (
                      <><RefreshCw size={12} className="animate-spin" /> 连接中...</>
                    ) : (
                      <><WifiOff size={12} /> 连接</>
                    )}
                  </button>
                )}
                <button
                  onClick={() => setServers(servers.filter((_, i) => i !== index))}
                  className="p-1.5 rounded-lg transition-colors cursor-pointer"
                  style={{ color: 'var(--color-text-tertiary)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-accent-red)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-tertiary)'; }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>

            <div className="text-xs font-mono px-3 py-2 rounded-lg" style={{ backgroundColor: 'var(--color-bg-secondary)', color: 'var(--color-text-secondary)' }}>
              {server.command} {server.args.join(' ')}
            </div>
          </div>
        ))}
      </div>

      {/* Connected Tools */}
      {tools.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--color-text-primary)' }}>
            🔧 已发现的工具 ({tools.length})
          </h3>
          <div className="space-y-2">
            {tools.map((tool, i) => (
              <div
                key={i}
                className="flex items-start gap-3 px-3 py-2.5 rounded-xl"
                style={{ backgroundColor: 'var(--color-bg-secondary)' }}
              >
                <Zap size={13} className="mt-0.5 shrink-0" style={{ color: 'var(--color-accent-warm)' }} />
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>{tool.name}</span>
                    <span className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>via {tool.serverName}</span>
                  </div>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-tertiary)' }}>{tool.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add Server Form */}
      {showAddForm ? (
        <div
          className="rounded-2xl p-5"
          style={{
            backgroundColor: 'var(--color-bg-card)',
            border: '1px solid var(--color-accent-blue)',
            boxShadow: 'var(--shadow-card), 0 0 0 2px rgba(141, 169, 196, 0.1)',
          }}
        >
          <h3 className="text-sm font-semibold mb-4" style={{ color: 'var(--color-text-primary)' }}>
            添加 MCP Server
          </h3>
          <div className="space-y-3 mb-4">
            <div>
              <label style={labelStyle}>名称</label>
              <input
                style={inputStyle}
                value={newServer.name}
                onChange={(e) => setNewServer({ ...newServer, name: e.target.value })}
                placeholder="例如: filesystem"
                onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--color-border-focus)'; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--color-border-light)'; }}
              />
            </div>
            <div>
              <label style={labelStyle}>命令</label>
              <input
                style={inputStyle}
                value={newServer.command}
                onChange={(e) => setNewServer({ ...newServer, command: e.target.value })}
                placeholder="例如: npx"
                onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--color-border-focus)'; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--color-border-light)'; }}
              />
            </div>
            <div>
              <label style={labelStyle}>参数（空格分隔）</label>
              <input
                style={inputStyle}
                value={newServer.args}
                onChange={(e) => setNewServer({ ...newServer, args: e.target.value })}
                placeholder="例如: -y @modelcontextprotocol/server-filesystem /Users"
                onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--color-border-focus)'; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--color-border-light)'; }}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowAddForm(false)}
              className="px-4 py-2 rounded-xl text-sm cursor-pointer"
              style={{ backgroundColor: 'var(--color-bg-button)', color: 'var(--color-text-secondary)' }}
            >
              取消
            </button>
            <button
              onClick={handleAddServer}
              disabled={!newServer.name || !newServer.command}
              className="px-4 py-2 rounded-xl text-sm font-medium cursor-pointer"
              style={{
                backgroundColor: (newServer.name && newServer.command) ? 'var(--color-accent-blue)' : 'var(--color-bg-button)',
                color: (newServer.name && newServer.command) ? 'white' : 'var(--color-text-tertiary)',
              }}
            >
              添加
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowAddForm(true)}
          className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl text-sm transition-all cursor-pointer"
          style={{ border: '2px dashed var(--color-border-light)', color: 'var(--color-text-tertiary)', backgroundColor: 'transparent' }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--color-accent-blue)'; e.currentTarget.style.color = 'var(--color-accent-blue)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--color-border-light)'; e.currentTarget.style.color = 'var(--color-text-tertiary)'; }}
        >
          <Plus size={16} />
          添加 MCP Server
        </button>
      )}
    </div>
  );
};

export default MCPSettings;
