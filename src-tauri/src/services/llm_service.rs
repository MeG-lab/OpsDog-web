use crate::models::{ChatRequest, ChatResponse, ModelListRequest, ToolCallInfo};
use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};


/// HTTP client singleton
static HTTP_CLIENT: std::sync::LazyLock<Client> = std::sync::LazyLock::new(|| {
    Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .expect("Failed to create HTTP client")
});

// ── OpenAI-Compatible Format ──

#[derive(Debug, Serialize)]
struct OpenAIRequest {
    model: String,
    messages: Vec<OpenAIMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    temperature: f32,
    stream: bool,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    tools: Vec<OpenAIToolDefinition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_choice: Option<&'static str>,
}

#[derive(Debug, Serialize, Deserialize)]
struct OpenAIMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct OpenAIResponse {
    choices: Vec<OpenAIChoice>,
}

#[derive(Debug, Deserialize)]
struct OpenAIChoice {
    message: OpenAIResponseMessage,
}

#[derive(Debug, Deserialize)]
struct OpenAIResponseMessage {
    content: Option<String>,
    tool_calls: Option<Vec<OpenAIToolCall>>,
}

#[derive(Debug, Deserialize)]
struct OpenAIToolCall {
    id: String,
    function: OpenAIFunction,
}

#[derive(Debug, Deserialize)]
struct OpenAIFunction {
    name: String,
    arguments: String,
}

#[derive(Debug, Serialize)]
struct OpenAIToolDefinition {
    #[serde(rename = "type")]
    tool_type: &'static str,
    function: OpenAIToolFunction,
}

#[derive(Debug, Serialize)]
struct OpenAIToolFunction {
    name: String,
    description: String,
    parameters: serde_json::Value,
}

// ── Streaming Types ──

#[derive(Debug, Deserialize)]
struct OpenAIStreamChunk {
    choices: Vec<OpenAIStreamChoice>,
}

#[derive(Debug, Deserialize)]
struct OpenAIStreamChoice {
    delta: OpenAIStreamDelta,
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAIStreamDelta {
    content: Option<String>,
    role: Option<String>,
}

// ── Anthropic Format ──

#[derive(Debug, Serialize)]
struct AnthropicRequest {
    model: String,
    messages: Vec<AnthropicMessage>,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<String>,
    stream: bool,
}

#[derive(Debug, Serialize)]
struct AnthropicMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct AnthropicResponse {
    content: Vec<AnthropicContent>,
}

#[derive(Debug, Deserialize)]
struct AnthropicContent {
    text: Option<String>,
    #[serde(rename = "type")]
    content_type: String,
}

// ── Anthropic Streaming Types ──

#[derive(Debug, Deserialize)]
struct AnthropicStreamEvent {
    #[serde(rename = "type")]
    event_type: String,
    delta: Option<AnthropicStreamDelta>,
    content_block: Option<AnthropicContent>,
}

#[derive(Debug, Deserialize)]
struct AnthropicStreamDelta {
    #[serde(rename = "type")]
    delta_type: Option<String>,
    text: Option<String>,
    stop_reason: Option<String>,
}

// ── Google Gemini Format ──

#[derive(Debug, Serialize)]
struct GeminiRequest {
    contents: Vec<GeminiContent>,
    #[serde(rename = "generationConfig")]
    generation_config: GeminiGenerationConfig,
}

#[derive(Debug, Serialize)]
struct GeminiContent {
    role: String,
    parts: Vec<GeminiPart>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GeminiPart {
    text: Option<String>,
}

#[derive(Debug, Serialize)]
struct GeminiGenerationConfig {
    temperature: f32,
    #[serde(rename = "maxOutputTokens")]
    max_output_tokens: u32,
}

#[derive(Debug, Deserialize)]
struct GeminiResponse {
    candidates: Option<Vec<GeminiCandidate>>,
}

#[derive(Debug, Deserialize, Clone)]
struct GeminiCandidate {
    content: GeminiCandidateContent,
}

#[derive(Debug, Deserialize, Clone)]
struct GeminiCandidateContent {
    parts: Vec<GeminiPart>,
}

#[derive(Debug, Deserialize)]
struct OpenAIModelsResponse {
    data: Vec<OpenAIModelItem>,
}

#[derive(Debug, Deserialize)]
struct OpenAIModelItem {
    id: String,
}

#[derive(Debug, Deserialize)]
struct GeminiModelsResponse {
    models: Option<Vec<GeminiModelItem>>,
}

#[derive(Debug, Deserialize)]
struct GeminiModelItem {
    name: String,
}

// ── Public API ──

/// Send a non-streaming chat request and get a complete response
pub async fn send_message(request: &ChatRequest) -> Result<ChatResponse, String> {
    match request.provider.as_str() {
        "openai" | "custom" | "aliyun" | "deepseek" | "siliconflow" | "volcengine" | "zhipu"
        | "moonshot" => send_openai_compatible(request).await,
        "anthropic" => send_anthropic(request).await,
        "google" => send_google(request).await,
        _ => Err(format!("Unsupported provider: {}", request.provider)),
    }
}

/// Send a streaming chat request, calling `on_chunk` for each text chunk
pub async fn send_message_stream<F>(
    request: &ChatRequest,
    on_chunk: F,
) -> Result<(), String>
where
    F: Fn(String) + Send + 'static,
{
    match request.provider.as_str() {
        "openai" | "custom" | "aliyun" | "deepseek" | "siliconflow" | "volcengine" | "zhipu"
        | "moonshot" => stream_openai_compatible(request, on_chunk).await,
        "anthropic" => stream_anthropic(request, on_chunk).await,
        "google" => {
            // Google Gemini uses a different streaming approach (generateContent with alt=sse)
            // For now, fall back to non-streaming and emit the full response
            let response = send_google(request).await?;
            on_chunk(response.content);
            Ok(())
        }
        _ => Err(format!("Unsupported provider: {}", request.provider)),
    }
}

pub async fn fetch_available_models(request: &ModelListRequest) -> Result<Vec<String>, String> {
    match request.provider.as_str() {
        "openai" | "custom" | "aliyun" | "deepseek" | "siliconflow" | "volcengine" | "zhipu"
        | "moonshot" => fetch_openai_compatible_models(request).await,
        "google" => fetch_google_models(request).await,
        "anthropic" => Err("Anthropic 当前未接入模型列表拉取，请手动填写模型名称".to_string()),
        _ => Err(format!("Unsupported provider: {}", request.provider)),
    }
}

// ── OpenAI Compatible Implementation ──

fn get_openai_base_url(request: &ChatRequest) -> String {
    request
        .base_url
        .as_ref()
        .cloned()
        .unwrap_or_else(|| "https://api.openai.com/v1".to_string())
}

fn get_openai_base_url_from_model_request(request: &ModelListRequest) -> String {
    request
        .base_url
        .as_ref()
        .cloned()
        .unwrap_or_else(|| "https://api.openai.com/v1".to_string())
}

async fn fetch_openai_compatible_models(request: &ModelListRequest) -> Result<Vec<String>, String> {
    let base_url = get_openai_base_url_from_model_request(request);
    let url = format!("{}/models", base_url.trim_end_matches('/'));

    let resp = HTTP_CLIENT
        .get(&url)
        .header("Authorization", format!("Bearer {}", request.api_key))
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let error_body = resp.text().await.unwrap_or_default();
        return Err(format!("API returned {}: {}", status, error_body));
    }

    let models_resp: OpenAIModelsResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let mut models = models_resp
        .data
        .into_iter()
        .map(|item| item.id)
        .filter(|id| !id.is_empty())
        .collect::<Vec<_>>();

    models.sort();
    Ok(models)
}

async fn fetch_google_models(request: &ModelListRequest) -> Result<Vec<String>, String> {
    let base_url = request
        .base_url
        .as_ref()
        .cloned()
        .unwrap_or_else(|| "https://generativelanguage.googleapis.com/v1beta".to_string());
    let url = format!(
        "{}/models?key={}",
        base_url.trim_end_matches('/'),
        request.api_key
    );

    let resp = HTTP_CLIENT
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let error_body = resp.text().await.unwrap_or_default();
        return Err(format!("API returned {}: {}", status, error_body));
    }

    let models_resp: GeminiModelsResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let mut models = models_resp
        .models
        .unwrap_or_default()
        .into_iter()
        .map(|item| item.name.trim_start_matches("models/").to_string())
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>();

    models.sort();
    Ok(models)
}

async fn send_openai_compatible(request: &ChatRequest) -> Result<ChatResponse, String> {
    let base_url = get_openai_base_url(request);
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    let openai_req = OpenAIRequest {
        model: request.model_name.clone(),
        messages: request
            .messages
            .iter()
            .map(|m| OpenAIMessage {
                role: m.role.clone(),
                content: m.content.clone(),
            })
            .collect(),
        max_tokens: Some(request.max_tokens),
        temperature: request.temperature,
        stream: false,
        tools: to_openai_tools(request),
        tool_choice: (!request.tools.is_empty()).then_some("auto"),
    };

    let resp = HTTP_CLIENT
        .post(&url)
        .header("Authorization", format!("Bearer {}", request.api_key))
        .header("Content-Type", "application/json")
        .json(&openai_req)
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let error_body = resp.text().await.unwrap_or_default();
        return Err(format!("API returned {}: {}", status, error_body));
    }

    let openai_resp: OpenAIResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let choice = openai_resp
        .choices
        .first()
        .ok_or("No choices in response")?;

    let tool_calls = choice.message.tool_calls.as_ref().map(|tcs| {
        tcs.iter()
            .map(|tc| ToolCallInfo {
                id: tc.id.clone(),
                name: tc.function.name.clone(),
                arguments: tc.function.arguments.clone(),
            })
            .collect()
    });

    Ok(ChatResponse {
        content: choice.message.content.clone().unwrap_or_default(),
        tool_calls,
    })
}

async fn stream_openai_compatible<F>(
    request: &ChatRequest,
    on_chunk: F,
) -> Result<(), String>
where
    F: Fn(String) + Send + 'static,
{
    let base_url = get_openai_base_url(request);
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    let openai_req = OpenAIRequest {
        model: request.model_name.clone(),
        messages: request
            .messages
            .iter()
            .map(|m| OpenAIMessage {
                role: m.role.clone(),
                content: m.content.clone(),
            })
            .collect(),
        max_tokens: Some(request.max_tokens),
        temperature: request.temperature,
        stream: true,
        tools: Vec::new(),
        tool_choice: None,
    };

    let resp = HTTP_CLIENT
        .post(&url)
        .header("Authorization", format!("Bearer {}", request.api_key))
        .header("Content-Type", "application/json")
        .json(&openai_req)
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let error_body = resp.text().await.unwrap_or_default();
        return Err(format!("API returned {}: {}", status, error_body));
    }

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream read error: {}", e))?;
        let text = String::from_utf8_lossy(&chunk);
        buffer.push_str(&text);

        // Process complete SSE lines
        while let Some(line_end) = buffer.find('\n') {
            let line = buffer[..line_end].trim().to_string();
            buffer = buffer[line_end + 1..].to_string();

            if line.is_empty() || line.starts_with(':') {
                continue;
            }

            if let Some(data) = line.strip_prefix("data: ") {
                if data.trim() == "[DONE]" {
                    return Ok(());
                }

                if let Ok(chunk) = serde_json::from_str::<OpenAIStreamChunk>(data) {
                    for choice in &chunk.choices {
                        if let Some(content) = &choice.delta.content {
                            if !content.is_empty() {
                                on_chunk(content.clone());
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

fn to_openai_tools(request: &ChatRequest) -> Vec<OpenAIToolDefinition> {
    request
        .tools
        .iter()
        .map(|tool| OpenAIToolDefinition {
            tool_type: "function",
            function: OpenAIToolFunction {
                name: tool.function.name.clone(),
                description: tool.function.description.clone(),
                parameters: tool.function.parameters.clone(),
            },
        })
        .collect()
}

// ── Anthropic Implementation ──

async fn send_anthropic(request: &ChatRequest) -> Result<ChatResponse, String> {
    let base_url = request
        .base_url
        .as_ref()
        .cloned()
        .unwrap_or_else(|| "https://api.anthropic.com".to_string());
    let url = format!("{}/v1/messages", base_url.trim_end_matches('/'));

    // Extract system message if present
    let system_msg = request
        .messages
        .iter()
        .find(|m| m.role == "system")
        .map(|m| m.content.clone());

    let messages: Vec<AnthropicMessage> = request
        .messages
        .iter()
        .filter(|m| m.role != "system")
        .map(|m| AnthropicMessage {
            role: m.role.clone(),
            content: m.content.clone(),
        })
        .collect();

    let anthropic_req = AnthropicRequest {
        model: request.model_name.clone(),
        messages,
        max_tokens: request.max_tokens,
        system: system_msg,
        stream: false,
    };

    let resp = HTTP_CLIENT
        .post(&url)
        .header("x-api-key", &request.api_key)
        .header("anthropic-version", "2023-06-01")
        .header("Content-Type", "application/json")
        .json(&anthropic_req)
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let error_body = resp.text().await.unwrap_or_default();
        return Err(format!("API returned {}: {}", status, error_body));
    }

    let anthropic_resp: AnthropicResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let content = anthropic_resp
        .content
        .iter()
        .filter_map(|c| c.text.clone())
        .collect::<Vec<_>>()
        .join("");

    Ok(ChatResponse {
        content,
        tool_calls: None,
    })
}

async fn stream_anthropic<F>(
    request: &ChatRequest,
    on_chunk: F,
) -> Result<(), String>
where
    F: Fn(String) + Send + 'static,
{
    let base_url = request
        .base_url
        .as_ref()
        .cloned()
        .unwrap_or_else(|| "https://api.anthropic.com".to_string());
    let url = format!("{}/v1/messages", base_url.trim_end_matches('/'));

    let system_msg = request
        .messages
        .iter()
        .find(|m| m.role == "system")
        .map(|m| m.content.clone());

    let messages: Vec<AnthropicMessage> = request
        .messages
        .iter()
        .filter(|m| m.role != "system")
        .map(|m| AnthropicMessage {
            role: m.role.clone(),
            content: m.content.clone(),
        })
        .collect();

    let anthropic_req = AnthropicRequest {
        model: request.model_name.clone(),
        messages,
        max_tokens: request.max_tokens,
        system: system_msg,
        stream: true,
    };

    let resp = HTTP_CLIENT
        .post(&url)
        .header("x-api-key", &request.api_key)
        .header("anthropic-version", "2023-06-01")
        .header("Content-Type", "application/json")
        .json(&anthropic_req)
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let error_body = resp.text().await.unwrap_or_default();
        return Err(format!("API returned {}: {}", status, error_body));
    }

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream read error: {}", e))?;
        let text = String::from_utf8_lossy(&chunk);
        buffer.push_str(&text);

        while let Some(line_end) = buffer.find('\n') {
            let line = buffer[..line_end].trim().to_string();
            buffer = buffer[line_end + 1..].to_string();

            if line.is_empty() || line.starts_with(':') {
                continue;
            }

            if let Some(data) = line.strip_prefix("data: ") {
                if let Ok(event) = serde_json::from_str::<AnthropicStreamEvent>(data) {
                    match event.event_type.as_str() {
                        "content_block_delta" => {
                            if let Some(delta) = &event.delta {
                                if let Some(text) = &delta.text {
                                    if !text.is_empty() {
                                        on_chunk(text.clone());
                                    }
                                }
                            }
                        }
                        "message_stop" => {
                            return Ok(());
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    Ok(())
}

// ── Google Gemini Implementation ──

async fn send_google(request: &ChatRequest) -> Result<ChatResponse, String> {
    let base_url = request
        .base_url
        .as_ref()
        .cloned()
        .unwrap_or_else(|| "https://generativelanguage.googleapis.com/v1beta".to_string());

    let url = format!(
        "{}/models/{}:generateContent?key={}",
        base_url.trim_end_matches('/'),
        request.model_name,
        request.api_key
    );

    // Convert messages to Gemini format
    let contents: Vec<GeminiContent> = request
        .messages
        .iter()
        .filter(|m| m.role != "system")
        .map(|m| GeminiContent {
            role: if m.role == "assistant" {
                "model".to_string()
            } else {
                "user".to_string()
            },
            parts: vec![GeminiPart {
                text: Some(m.content.clone()),
            }],
        })
        .collect();

    let gemini_req = GeminiRequest {
        contents,
        generation_config: GeminiGenerationConfig {
            temperature: request.temperature,
            max_output_tokens: request.max_tokens,
        },
    };

    let resp = HTTP_CLIENT
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&gemini_req)
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let error_body = resp.text().await.unwrap_or_default();
        return Err(format!("API returned {}: {}", status, error_body));
    }

    let gemini_resp: GeminiResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let content = gemini_resp
        .candidates
        .and_then(|c| c.first().cloned())
        .map(|c| {
            c.content
                .parts
                .iter()
                .filter_map(|p| p.text.clone())
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();

    Ok(ChatResponse {
        content,
        tool_calls: None,
    })
}
