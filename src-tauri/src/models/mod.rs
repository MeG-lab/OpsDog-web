use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// LLM Provider type
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LLMProvider {
    OpenAI,
    Anthropic,
    Google,
    Aliyun,
    Deepseek,
    Siliconflow,
    Volcengine,
    Zhipu,
    Moonshot,
    Custom,
}

/// LLM configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LLMConfig {
    pub id: String,
    pub provider: LLMProvider,
    pub name: String,
    #[serde(alias = "api_key")]
    pub api_key: String,
    #[serde(alias = "base_url")]
    pub base_url: Option<String>,
    #[serde(alias = "model_name")]
    pub model_name: String,
    #[serde(alias = "max_tokens")]
    pub max_tokens: u32,
    pub temperature: f32,
}

/// Chat message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Chat request from frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub messages: Vec<ChatMessage>,
    pub provider: String,
    #[serde(alias = "api_key")]
    pub api_key: String,
    #[serde(alias = "base_url")]
    pub base_url: Option<String>,
    #[serde(alias = "model_name")]
    pub model_name: String,
    #[serde(alias = "max_tokens")]
    pub max_tokens: u32,
    pub temperature: f32,
    #[serde(default)]
    pub tools: Vec<ChatToolDefinition>,
}

/// Tool definition for model tool calling
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatToolDefinition {
    #[serde(rename = "type")]
    pub tool_type: String,
    pub function: ChatToolFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatToolFunction {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// Model list request from frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelListRequest {
    pub provider: String,
    #[serde(alias = "api_key")]
    pub api_key: String,
    #[serde(alias = "base_url")]
    pub base_url: Option<String>,
}

/// Chat response to frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatResponse {
    pub content: String,
    #[serde(alias = "tool_calls")]
    pub tool_calls: Option<Vec<ToolCallInfo>>,
}

/// Tool call information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallInfo {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

/// Intent routing result for chat input
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRouteDecision {
    pub intent: String,
    pub blocked: bool,
    pub block_reason: Option<String>,
    pub local_only: bool,
    pub allow_mcp: bool,
    pub max_mcp_risk_level: String,
    pub explicit_tool_use: bool,
    pub requires_confirmation: bool,
    pub has_confirmation: bool,
    pub confirmation_token: Option<String>,
    pub confirmation_title: Option<String>,
    pub confirmation_summary: Option<String>,
    pub confidence: f32,
    pub reason_codes: Vec<String>,
}

/// Unified backend execution plan for a chat input
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatExecutionPlan {
    pub route: ChatRouteDecision,
    #[serde(default)]
    pub matched_skills: Vec<SkillRouteMatch>,
    #[serde(default)]
    pub executable_skills: Vec<SkillRouteMatch>,
}

/// Script execution result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptExecutionResult {
    #[serde(alias = "exit_code")]
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    #[serde(alias = "execution_time_ms")]
    pub execution_time_ms: u64,
    pub truncated: bool,
}

/// Python environment info
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PythonEnvInfo {
    pub available: bool,
    pub version: String,
    pub path: String,
}

/// Managed task snapshot returned to frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedTaskInfo {
    pub task_id: String,
    pub script_path: String,
    pub log_path: Option<String>,
    pub args: Vec<String>,
    pub status: String,
    pub pid: Option<u32>,
    pub started_at: Option<String>,
    pub stopped_at: Option<String>,
    pub last_output_at: Option<String>,
    pub last_level: Option<String>,
    pub exit_code: Option<i32>,
    pub recent_logs: Vec<String>,
}

/// Skill metadata (parsed from skill.yaml)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMeta {
    pub name: String,
    pub version: String,
    pub description: String,
    pub triggers: Vec<String>,
    #[serde(default = "default_task_kind", alias = "taskKind", alias = "task_kind")]
    pub task_kind: String,
    #[serde(alias = "entry_script")]
    pub entry_script: String,
    #[serde(alias = "timeout_seconds")]
    pub timeout_seconds: u64,
    #[serde(default)]
    pub dependencies: Vec<String>,
    #[serde(default, alias = "default_args")]
    pub default_args: Vec<String>,
    #[serde(default, alias = "args_schema")]
    pub args_schema: Vec<SkillArgSchemaField>,
    #[serde(default)]
    pub path: String,
}

fn default_task_kind() -> String {
    "instant".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillArgSchemaField {
    pub flag: String,
    #[serde(alias = "type")]
    pub arg_type: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub multiple: bool,
    #[serde(default)]
    pub pattern: Option<String>,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillArgsValidationResult {
    pub valid: bool,
    pub normalized_args: Vec<String>,
    pub errors: Vec<String>,
}

/// Skill routing match result for backend intent routing
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRouteMatch {
    pub skill_name: String,
    pub score: f32,
    pub matched_trigger: String,
}

/// Uploaded skill file from frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadedSkillFile {
    pub relative_path: String,
    pub bytes: Vec<u8>,
}

/// Persisted MCP server configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MCPServerConfigPersisted {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default, alias = "riskLevel")]
    pub risk_level: Option<String>,
    #[serde(default, alias = "toolRiskOverrides")]
    pub tool_risk_overrides: HashMap<String, String>,
}

/// System information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemInfo {
    pub os: String,
    pub arch: String,
    pub hostname: String,
}

/// App configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(alias = "llm_configs")]
    pub llm_configs: Vec<LLMConfig>,
    #[serde(default, alias = "mcp_servers")]
    pub mcp_servers: Vec<MCPServerConfigPersisted>,
    #[serde(alias = "python_path")]
    pub python_path: String,
    #[serde(alias = "skills_dir")]
    pub skills_dir: String,
    #[serde(alias = "data_dir")]
    pub data_dir: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        let home = dirs::home_dir().unwrap_or_default();
        let aiops_dir = home.join(".aiops");

        Self {
            llm_configs: Vec::new(),
            mcp_servers: vec![MCPServerConfigPersisted {
                name: "filesystem".to_string(),
                command: "npx".to_string(),
                args: vec![
                    "-y".to_string(),
                    "@modelcontextprotocol/server-filesystem".to_string(),
                    "/Users".to_string(),
                ],
                enabled: true,
                risk_level: Some("destructive".to_string()),
                tool_risk_overrides: HashMap::from([
                    ("read_file".to_string(), "read-only".to_string()),
                    ("read_multiple_files".to_string(), "read-only".to_string()),
                    ("get_file_info".to_string(), "read-only".to_string()),
                    ("list_directory".to_string(), "read-only".to_string()),
                    ("list_allowed_directories".to_string(), "read-only".to_string()),
                    ("search_files".to_string(), "read-only".to_string()),
                    ("write_file".to_string(), "destructive".to_string()),
                    ("edit_file".to_string(), "destructive".to_string()),
                    ("move_file".to_string(), "destructive".to_string()),
                    ("create_directory".to_string(), "state-change".to_string()),
                ]),
            }],
            python_path: "python3".to_string(),
            skills_dir: aiops_dir.join("skills").to_string_lossy().to_string(),
            data_dir: aiops_dir.join("data").to_string_lossy().to_string(),
        }
    }
}
