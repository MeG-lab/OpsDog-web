use crate::services::mcp_client::{MCPClient, MCPServerConfig, MCPTool, MCPToolResult};
use crate::services::audit::append_audit_event;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;

/// Shared MCP state — holds all active MCP client connections
pub struct MCPState {
    pub clients: Arc<Mutex<HashMap<String, MCPClient>>>,
}

impl MCPState {
    pub fn new() -> Self {
        Self {
            clients: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

/// Connect to an MCP server
#[tauri::command]
pub async fn connect_mcp_server(
    state: State<'_, MCPState>,
    server_config: MCPServerConfig,
) -> Result<Vec<MCPTool>, String> {
    let name = server_config.name.clone();
    let command = server_config.command.clone();
    log::info!("Connecting to MCP server: {}", name);

    let mut client = MCPClient::new(server_config);
    client.connect().await?;

    let tools = client.get_tools().await;
    state.clients.lock().await.insert(name.clone(), client);
    let _ = append_audit_event("mcp_connect", json!({
        "serverName": name,
        "command": command,
        "toolCount": tools.len(),
    }));

    Ok(tools)
}

/// Disconnect from an MCP server
#[tauri::command]
pub async fn disconnect_mcp_server(
    state: State<'_, MCPState>,
    server_name: String,
) -> Result<(), String> {
    let mut clients = state.clients.lock().await;
    if let Some(mut client) = clients.remove(&server_name) {
        client.disconnect().await;
        log::info!("Disconnected from MCP server: {}", server_name);
        let _ = append_audit_event("mcp_disconnect", json!({
            "serverName": server_name,
        }));
    }
    Ok(())
}

/// List all tools from all connected MCP servers
#[tauri::command]
pub async fn list_mcp_tools(
    state: State<'_, MCPState>,
) -> Result<Vec<MCPToolWithServer>, String> {
    let clients = state.clients.lock().await;
    let mut all_tools = Vec::new();

    for (server_name, client) in clients.iter() {
        let tools = client.get_tools().await;
        for tool in tools {
            let risk_level = client
                .explicit_tool_risk_level(&tool.name)
                .unwrap_or_else(|| infer_tool_risk_level(&tool.name, &tool.description));
            all_tools.push(MCPToolWithServer {
                name: tool.name,
                description: tool.description,
                input_schema: tool.input_schema,
                server_name: server_name.clone(),
                risk_level,
            });
        }
    }

    Ok(all_tools)
}

/// Call a tool on a connected MCP server
#[tauri::command]
pub async fn call_mcp_tool(
    state: State<'_, MCPState>,
    server_name: String,
    tool_name: String,
    arguments: serde_json::Value,
) -> Result<MCPToolResult, String> {
    let clients = state.clients.lock().await;
    let client = clients
        .get(&server_name)
        .ok_or(format!("MCP server '{}' not connected", server_name))?;

    let result = client.call_tool(&tool_name, arguments.clone()).await;
    if let Ok(tool_result) = &result {
        let _ = append_audit_event("mcp_tool_call", json!({
            "serverName": server_name,
            "toolName": tool_name,
            "arguments": arguments,
            "isError": tool_result.is_error,
        }));
    }
    result
}

/// Get connection status of all MCP servers
#[tauri::command]
pub async fn get_mcp_status(
    state: State<'_, MCPState>,
) -> Result<Vec<MCPServerStatus>, String> {
    let clients = state.clients.lock().await;
    let mut statuses = Vec::new();

    for (name, client) in clients.iter() {
        let tools = client.get_tools().await;
        statuses.push(MCPServerStatus {
            name: name.clone(),
            connected: true,
            tool_count: tools.len(),
        });
    }

    Ok(statuses)
}

// ── Helper Types ──

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MCPToolWithServer {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
    pub server_name: String,
    pub risk_level: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MCPServerStatus {
    pub name: String,
    pub connected: bool,
    pub tool_count: usize,
}

fn infer_tool_risk_level(name: &str, description: &str) -> String {
    let joined = format!("{} {}", name.to_lowercase(), description.to_lowercase());
    let destructive_hints = [
        "delete", "remove", "drop", "destroy", "truncate", "kill", "shutdown", "reboot",
        "unlink", "rename", "move", "chmod", "write_file", "write-file", "overwrite",
        "清空", "删除", "移除", "销毁", "重启", "关闭", "卸载",
    ];
    if destructive_hints.iter().any(|hint| joined.contains(hint)) {
        return "destructive".to_string();
    }

    let state_change_hints = [
        "create", "update", "edit", "patch", "apply", "insert", "write", "save", "start",
        "stop", "restart", "修改", "更新", "写入", "保存", "创建", "启动", "停止",
    ];
    if state_change_hints.iter().any(|hint| joined.contains(hint)) {
        return "state-change".to_string();
    }

    "read-only".to_string()
}
