use crate::commands::skills;
use crate::models::{ChatExecutionPlan, ChatRequest, ChatResponse, ChatRouteDecision, ModelListRequest};
use crate::services::audit::append_audit_event;
use crate::services::llm_service;
use serde::Serialize;
use serde_json::json;
use tauri::{Emitter, Window};

/// Event payload for streaming chunks
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamChunkPayload {
    conversation_id: String,
    message_id: String,
    chunk: String,
}

/// Event payload for stream completion
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamCompletePayload {
    conversation_id: String,
    message_id: String,
    success: bool,
    error: Option<String>,
}

/// Send a non-streaming chat message to the configured LLM
#[tauri::command]
pub async fn send_chat_message(request: ChatRequest) -> Result<ChatResponse, String> {
    log::info!(
        "Chat request: provider={}, model={}, messages={}",
        request.provider,
        request.model_name,
        request.messages.len()
    );

    llm_service::send_message(&request).await
}

/// Fetch available models for the configured provider
#[tauri::command]
pub async fn fetch_available_models(request: ModelListRequest) -> Result<Vec<String>, String> {
    log::info!("Fetch models request: provider={}", request.provider);
    llm_service::fetch_available_models(&request).await
}

#[tauri::command]
pub async fn route_chat_input(input: String) -> Result<ChatRouteDecision, String> {
    route_chat_input_internal(input).await
}

#[tauri::command]
pub async fn build_chat_execution_plan(
    input: String,
    allowed_skills: Vec<String>,
) -> Result<ChatExecutionPlan, String> {
    let route = route_chat_input_internal(input.clone()).await?;
    let matched_skills = skills::match_skill_routes(input.clone(), allowed_skills.clone()).await?;
    let executable_skills = if route.intent == "task.instant.execute_candidate" {
        skills::resolve_instant_skill_execution(input, allowed_skills).await?
    } else {
        Vec::new()
    };

    Ok(ChatExecutionPlan {
        route,
        matched_skills,
        executable_skills,
    })
}

async fn route_chat_input_internal(input: String) -> Result<ChatRouteDecision, String> {
    let normalized = input.trim().to_lowercase();
    let mut reason_codes: Vec<String> = Vec::new();
    let blocked_patterns = [
        "rm -rf /",
        "rm -rf ~",
        "mkfs",
        "dd if=",
        "shutdown -h",
        "reboot now",
        "curl http",
        "curl https",
        "wget http",
        "chmod -r 777 /",
        "kill -9 1",
        "sudo rm",
    ];

    if blocked_patterns.iter().any(|pattern| normalized.contains(pattern)) {
        reason_codes.push("dangerous_command".to_string());
        let decision = ChatRouteDecision {
            intent: "unsafe.or.unknown".to_string(),
            blocked: true,
            block_reason: Some("输入中包含高风险系统命令片段，已阻止进入模型与工具执行链路。".to_string()),
            local_only: true,
            allow_mcp: false,
            max_mcp_risk_level: "none".to_string(),
            explicit_tool_use: false,
            requires_confirmation: false,
            has_confirmation: false,
            confirmation_token: None,
            confirmation_title: None,
            confirmation_summary: None,
            confidence: 1.0,
            reason_codes,
        };
        audit_route_decision(&input, &decision);
        return Ok(decision);
    }

    let prompt_injection_hints = [
        "忽略之前",
        "忽略上面的要求",
        "忽略系统提示",
        "ignore previous",
        "ignore all previous",
        "system prompt",
        "developer message",
        "you are now",
        "假装是系统管理员",
        "绕过限制",
        "禁用安全检查",
        "override safety",
    ];
    let prompt_injection_detected = prompt_injection_hints
        .iter()
        .any(|pattern| normalized.contains(pattern));
    if prompt_injection_detected {
        reason_codes.push("prompt_injection".to_string());
    }

    let skill_catalog = normalized.contains("skill")
        || normalized.contains("技能")
        || normalized.contains("会什么")
        || normalized.contains("能干什么")
        || normalized.contains("有什么能力");
    if skill_catalog {
        reason_codes.push("skill_catalog_query".to_string());
    }

    let managed_create = {
        let intent_hints = ["持续", "一直", "长期", "托管", "监控", "监测", "守护", "盯着", "值守", "告警"];
        let action_hints = ["帮我", "给我", "创建", "新增", "加个", "配置", "设置", "建立", "启动"];
        let target_hints = ["端口", "port", "进程", "process", "服务", "nginx", "redis", "mysql", "node", "python", "java"];
        let has_intent = intent_hints.iter().any(|hint| normalized.contains(hint));
        let has_action = action_hints.iter().any(|hint| normalized.contains(hint));
        let has_target = target_hints.iter().any(|hint| normalized.contains(hint))
            || has_number_token(&input);
        has_intent && (has_action || has_target)
    };
    if managed_create {
        reason_codes.push("managed_task_create".to_string());
    }

    let managed_query = normalized.contains("托管任务")
        || normalized.contains("持续任务")
        || normalized.contains("watchdog")
        || normalized.contains("守护")
        || (contains_any(&normalized, &["状态", "日志", "运行", "异常", "告警", "恢复", "挂过", "最近", "怎么样", "情况"])
            && (contains_any(&normalized, &["端口", "服务", "任务"]) || has_number_token(&input)));
    if managed_query {
        reason_codes.push("managed_task_query".to_string());
    }

    let instant_execute_candidate = {
        let action_hints = ["执行", "运行", "测试", "检查", "检测", "排查", "巡检", "诊断", "run", "execute", "check", "test", "inspect", "ping"];
        !managed_create
            && !managed_query
            && !skill_catalog
            && action_hints.iter().any(|hint| normalized.contains(hint))
    };
    if instant_execute_candidate {
        reason_codes.push("instant_task_candidate".to_string());
    }

    let explicit_tool_use = contains_any(&normalized, &[
        "mcp",
        "工具",
        "tool",
        "filesystem",
        "文件系统",
        "列目录",
        "读取文件",
        "读文件",
        "调用工具",
    ]);
    if explicit_tool_use {
        reason_codes.push("explicit_tool_request".to_string());
    }
    let has_confirmation = normalized.contains("确认调用工具")
        || normalized.contains("确认执行")
        || normalized.contains("允许调用工具")
        || normalized.contains("批准调用工具");

    let destructive_tool_intent = contains_any(&normalized, &[
        "删除",
        "清空",
        "移除",
        "drop",
        "delete",
        "remove",
        "kill",
        "shutdown",
        "reboot",
        "重启服务",
        "停止服务",
        "卸载",
    ]);
    if destructive_tool_intent {
        reason_codes.push("destructive_tool_intent".to_string());
    }

    let state_change_tool_intent = destructive_tool_intent || contains_any(&normalized, &[
        "创建",
        "修改",
        "更新",
        "写入",
        "保存",
        "重载",
        "启动服务",
        "restart",
        "update",
        "write",
        "apply",
        "patch",
        "create",
    ]);
    if state_change_tool_intent && !destructive_tool_intent {
        reason_codes.push("state_change_tool_intent".to_string());
    }

    let intent = if skill_catalog {
        "skill.catalog"
    } else if managed_create {
        "task.managed.create"
    } else if managed_query {
        "task.managed.query"
    } else if instant_execute_candidate {
        "task.instant.execute_candidate"
    } else {
        "chat.general"
    };

    let local_only = matches!(intent, "skill.catalog" | "task.managed.create" | "task.managed.query");
    let confidence = if prompt_injection_detected {
        0.95
    } else if local_only {
        0.9
    } else if explicit_tool_use {
        0.85
    } else {
        0.7
    };

    if prompt_injection_detected && explicit_tool_use {
        let decision = ChatRouteDecision {
            intent: "unsafe.or.unknown".to_string(),
            blocked: true,
            block_reason: Some("输入同时包含角色绕过/提示注入特征和工具调用请求，已阻止进入模型与外部工具链路。".to_string()),
            local_only: true,
            allow_mcp: false,
            max_mcp_risk_level: "none".to_string(),
            explicit_tool_use,
            requires_confirmation: false,
            has_confirmation,
            confirmation_token: None,
            confirmation_title: None,
            confirmation_summary: None,
            confidence,
            reason_codes,
        };
        audit_route_decision(&input, &decision);
        return Ok(decision);
    }

    let max_mcp_risk_level = if !explicit_tool_use || prompt_injection_detected {
        "none"
    } else if destructive_tool_intent {
        "destructive"
    } else if state_change_tool_intent {
        "state-change"
    } else {
        "read-only"
    };

    log::info!(
        "route_chat_input intent={}, blocked=false, local_only={}, allow_mcp={}, max_mcp_risk_level={}, confirmation={}, confidence={:.2}, reasons={:?}",
        intent,
        local_only,
        explicit_tool_use,
        max_mcp_risk_level,
        has_confirmation,
        confidence,
        reason_codes
    );

    let decision = ChatRouteDecision {
        intent: intent.to_string(),
        blocked: false,
        block_reason: None,
        local_only,
        allow_mcp: explicit_tool_use && !prompt_injection_detected,
        max_mcp_risk_level: max_mcp_risk_level.to_string(),
        explicit_tool_use,
        requires_confirmation: explicit_tool_use,
        has_confirmation,
        confirmation_token: if explicit_tool_use { Some("确认调用工具".to_string()) } else { None },
        confirmation_title: if explicit_tool_use { Some("外部工具调用确认".to_string()) } else { None },
        confirmation_summary: if explicit_tool_use {
            Some(format!(
                "当前请求计划调用 MCP 外部工具，允许的最高风险等级为 {}。请确认后再继续。",
                max_mcp_risk_level
            ))
        } else {
            None
        },
        confidence,
        reason_codes,
    };

    audit_route_decision(&input, &decision);
    Ok(decision)
}

/// Send a streaming chat message — emits "chat:stream-chunk" events to the frontend
#[tauri::command]
pub async fn send_chat_message_stream(
    window: Window,
    request: ChatRequest,
    conversation_id: String,
    message_id: String,
) -> Result<(), String> {
    log::info!(
        "Streaming chat request: provider={}, model={}, messages={}",
        request.provider,
        request.model_name,
        request.messages.len()
    );

    let conv_id = conversation_id.clone();
    let msg_id = message_id.clone();
    let window_clone = window.clone();

    let result = llm_service::send_message_stream(&request, move |chunk| {
        let payload = StreamChunkPayload {
            conversation_id: conv_id.clone(),
            message_id: msg_id.clone(),
            chunk,
        };

        if let Err(e) = window_clone.emit("chat:stream-chunk", payload) {
            log::error!("Failed to emit stream chunk: {}", e);
        }
    })
    .await;

    // Emit completion event
    let complete_payload = StreamCompletePayload {
        conversation_id: conversation_id.clone(),
        message_id: message_id.clone(),
        success: result.is_ok(),
        error: result.as_ref().err().cloned(),
    };

    if let Err(e) = window.emit("chat:stream-complete", complete_payload) {
        log::error!("Failed to emit stream complete: {}", e);
    }

    result
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|item| haystack.contains(item))
}

fn has_number_token(input: &str) -> bool {
    let mut digits = 0;
    for ch in input.chars() {
        if ch.is_ascii_digit() {
            digits += 1;
            if digits >= 2 {
                return true;
            }
        } else {
            digits = 0;
        }
    }
    false
}

fn audit_route_decision(input: &str, decision: &ChatRouteDecision) {
    let payload = json!({
        "input": input,
        "intent": decision.intent,
        "blocked": decision.blocked,
        "blockReason": decision.block_reason,
        "localOnly": decision.local_only,
        "allowMcp": decision.allow_mcp,
        "maxMcpRiskLevel": decision.max_mcp_risk_level,
        "explicitToolUse": decision.explicit_tool_use,
        "requiresConfirmation": decision.requires_confirmation,
        "hasConfirmation": decision.has_confirmation,
        "confirmationToken": decision.confirmation_token,
        "confirmationTitle": decision.confirmation_title,
        "confirmationSummary": decision.confirmation_summary,
        "confidence": decision.confidence,
        "reasonCodes": decision.reason_codes,
    });

    if let Err(error) = append_audit_event("route_decision", payload) {
        log::warn!("Failed to append route audit log: {}", error);
    }
}
