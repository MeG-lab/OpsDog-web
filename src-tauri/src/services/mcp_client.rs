//! MCP (Model Context Protocol) Client
//!
//! Supports stdio transport for local MCP servers.
//! Implements JSON-RPC 2.0 over stdin/stdout.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, oneshot};

// ── JSON-RPC Types ──

#[derive(Debug, Serialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    id: u64,
    method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcResponse {
    #[allow(dead_code)]
    jsonrpc: String,
    id: Option<u64>,
    result: Option<serde_json::Value>,
    error: Option<JsonRpcError>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcError {
    code: i64,
    message: String,
}

// ── MCP Tool Types ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MCPTool {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(rename = "inputSchema", default)]
    pub input_schema: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MCPToolResult {
    pub content: Vec<MCPToolContent>,
    #[serde(rename = "isError", default)]
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MCPToolContent {
    #[serde(rename = "type")]
    pub content_type: String,
    #[serde(default)]
    pub text: Option<String>,
}

// ── MCP Server Config ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MCPServerConfig {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default, alias = "riskLevel")]
    pub risk_level: Option<String>,
    #[serde(default, alias = "toolRiskOverrides")]
    pub tool_risk_overrides: HashMap<String, String>,
}

// ── MCP Client ──

pub struct MCPClient {
    config: MCPServerConfig,
    child: Option<Child>,
    stdin: Option<Arc<Mutex<tokio::process::ChildStdin>>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<serde_json::Value, String>>>>>,
    next_id: Arc<Mutex<u64>>,
    tools: Arc<Mutex<Vec<MCPTool>>>,
}

impl MCPClient {
    pub fn new(config: MCPServerConfig) -> Self {
        Self {
            config,
            child: None,
            stdin: None,
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: Arc::new(Mutex::new(1)),
            tools: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Start the MCP server process and initialize the connection
    pub async fn connect(&mut self) -> Result<(), String> {
        log::info!("Starting MCP server: {} {:?}", self.config.command, self.config.args);

        let mut cmd = Command::new(&self.config.command);
        cmd.args(&self.config.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Set environment variables
        for (key, value) in &self.config.env {
            cmd.env(key, value);
        }

        let mut child = cmd.spawn().map_err(|e| format!("Failed to start MCP server: {}", e))?;

        let stdin = child.stdin.take().ok_or("Failed to get stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to get stdout")?;

        self.stdin = Some(Arc::new(Mutex::new(stdin)));
        self.child = Some(child);

        // Spawn stdout reader task
        let pending = self.pending.clone();
        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut reader = reader;

            loop {
                match read_json_rpc_message(&mut reader).await {
                    Ok(Some(response)) => {
                        if let Some(id) = response.id {
                            let mut pending = pending.lock().await;
                            if let Some(sender) = pending.remove(&id) {
                                if let Some(error) = response.error {
                                    let _ = sender.send(Err(format!(
                                        "MCP error {}: {}",
                                        error.code, error.message
                                    )));
                                } else {
                                    let _ = sender.send(Ok(
                                        response.result.unwrap_or(serde_json::Value::Null)
                                    ));
                                }
                            }
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        log::warn!("Failed to read MCP message: {}", error);
                    }
                }
            }

            log::info!("MCP server stdout reader ended");
        });

        // Send initialize request
        let init_result = self
            .send_request(
                "initialize",
                Some(serde_json::json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {
                        "name": "AIops",
                        "version": "0.1.0"
                    }
                })),
            )
            .await?;

        log::info!("MCP initialize response: {:?}", init_result);

        // Send initialized notification
        self.send_notification("notifications/initialized", None).await?;

        // Discover available tools
        self.refresh_tools().await?;

        Ok(())
    }

    /// Refresh the list of available tools from the server
    pub async fn refresh_tools(&self) -> Result<Vec<MCPTool>, String> {
        let result = self.send_request("tools/list", None).await?;

        let tools_value = result
            .get("tools")
            .cloned()
            .unwrap_or(serde_json::Value::Array(vec![]));

        let tools: Vec<MCPTool> = serde_json::from_value(tools_value)
            .map_err(|e| format!("Failed to parse tools: {}", e))?;

        log::info!("Discovered {} MCP tools", tools.len());
        for tool in &tools {
            log::info!("  - {} : {}", tool.name, tool.description);
        }

        *self.tools.lock().await = tools.clone();
        Ok(tools)
    }

    /// Get the current list of tools
    pub async fn get_tools(&self) -> Vec<MCPTool> {
        self.tools.lock().await.clone()
    }

    pub fn explicit_tool_risk_level(&self, tool_name: &str) -> Option<String> {
        self.config.tool_risk_overrides.get(tool_name).cloned()
    }

    /// Call a tool on the MCP server
    pub async fn call_tool(
        &self,
        name: &str,
        arguments: serde_json::Value,
    ) -> Result<MCPToolResult, String> {
        let result = self
            .send_request(
                "tools/call",
                Some(serde_json::json!({
                    "name": name,
                    "arguments": arguments
                })),
            )
            .await?;

        serde_json::from_value(result)
            .map_err(|e| format!("Failed to parse tool result: {}", e))
    }

    /// Disconnect from the MCP server
    pub async fn disconnect(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill().await;
        }
        self.stdin = None;
    }

    // ── Private Methods ──

    async fn send_request(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        let id = {
            let mut next_id = self.next_id.lock().await;
            let id = *next_id;
            *next_id += 1;
            id
        };

        let request = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id,
            method: method.to_string(),
            params,
        };

        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let request_str = serde_json::to_string(&request)
            .map_err(|e| format!("Failed to serialize request: {}", e))?;

        if let Some(stdin) = &self.stdin {
            let mut stdin = stdin.lock().await;
            let frame = format!("Content-Length: {}\r\n\r\n{}", request_str.len(), request_str);
            stdin
                .write_all(frame.as_bytes())
                .await
                .map_err(|e| format!("Failed to write to stdin: {}", e))?;
            stdin
                .flush()
                .await
                .map_err(|e| format!("Failed to flush stdin: {}", e))?;
        } else {
            return Err("Not connected to MCP server".to_string());
        }

        // Wait for response with timeout
        match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Response channel closed".to_string()),
            Err(_) => Err("Request timed out after 30 seconds".to_string()),
        }
    }

    async fn send_notification(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> Result<(), String> {
        let notification = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params.unwrap_or(serde_json::json!({}))
        });

        let notification_str = serde_json::to_string(&notification)
            .map_err(|e| format!("Failed to serialize notification: {}", e))?;

        if let Some(stdin) = &self.stdin {
            let mut stdin = stdin.lock().await;
            let frame = format!(
                "Content-Length: {}\r\n\r\n{}",
                notification_str.len(),
                notification_str
            );
            stdin
                .write_all(frame.as_bytes())
                .await
                .map_err(|e| format!("Failed to write notification: {}", e))?;
            stdin
                .flush()
                .await
                .map_err(|e| format!("Failed to flush notification: {}", e))?;
        }

        Ok(())
    }
}

async fn read_json_rpc_message(
    reader: &mut BufReader<tokio::process::ChildStdout>,
) -> Result<Option<JsonRpcResponse>, String> {
    let mut first_line = String::new();
    let bytes = reader
        .read_line(&mut first_line)
        .await
        .map_err(|e| format!("Failed to read from MCP stdout: {}", e))?;

    if bytes == 0 {
        return Ok(None);
    }

    let trimmed = first_line.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    if trimmed.starts_with('{') {
        return serde_json::from_str::<JsonRpcResponse>(trimmed)
            .map(Some)
            .map_err(|e| format!("Failed to parse JSON-RPC line: {}", e));
    }

    let mut content_length = None;
    parse_header_line(trimmed, &mut content_length);

    loop {
        let mut line = String::new();
        let read = reader
            .read_line(&mut line)
            .await
            .map_err(|e| format!("Failed to read MCP header: {}", e))?;

        if read == 0 {
            break;
        }

        let trimmed_line = line.trim();
        if trimmed_line.is_empty() {
            break;
        }

        parse_header_line(trimmed_line, &mut content_length);
    }

    let length = content_length.ok_or("Missing Content-Length header".to_string())?;
    let mut body = vec![0_u8; length];
    reader
        .read_exact(&mut body)
        .await
        .map_err(|e| format!("Failed to read MCP message body: {}", e))?;

    serde_json::from_slice::<JsonRpcResponse>(&body)
        .map(Some)
        .map_err(|e| format!("Failed to parse JSON-RPC body: {}", e))
}

fn parse_header_line(line: &str, content_length: &mut Option<usize>) {
    if let Some((key, value)) = line.split_once(':') {
        if key.eq_ignore_ascii_case("content-length") {
            if let Ok(length) = value.trim().parse::<usize>() {
                *content_length = Some(length);
            }
        }
    }
}

impl Drop for MCPClient {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
        }
    }
}
