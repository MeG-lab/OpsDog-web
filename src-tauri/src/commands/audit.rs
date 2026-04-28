use crate::services::audit::{get_audit_log_path, load_audit_events, summarize_audit_events};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditQueryRequest {
    pub limit: Option<usize>,
    pub event_type: Option<String>,
    pub search: Option<String>,
}

#[tauri::command]
pub async fn query_audit_events(request: Option<AuditQueryRequest>) -> Result<Value, String> {
    let request = request.unwrap_or(AuditQueryRequest {
        limit: Some(200),
        event_type: None,
        search: None,
    });
    let events = load_audit_events(
        request.limit,
        request.event_type.as_deref(),
        request.search.as_deref(),
    )?;
    Ok(serde_json::to_value(events).map_err(|e| format!("Failed to serialize audit events: {}", e))?)
}

#[tauri::command]
pub async fn get_audit_overview(request: Option<AuditQueryRequest>) -> Result<Value, String> {
    let request = request.unwrap_or(AuditQueryRequest {
        limit: Some(500),
        event_type: None,
        search: None,
    });
    let summary = summarize_audit_events(
        request.limit,
        request.event_type.as_deref(),
        request.search.as_deref(),
    )?;
    Ok(serde_json::to_value(summary).map_err(|e| format!("Failed to serialize audit summary: {}", e))?)
}

#[tauri::command]
pub async fn get_audit_replay(scope: String, limit: Option<usize>) -> Result<Value, String> {
    let scope = scope.trim().to_string();
    let events = load_audit_events(limit.or(Some(200)), None, Some(&scope))?;
    let path = get_audit_log_path()?;
    Ok(json!({
        "scope": scope,
        "logPath": path,
        "events": events,
    }))
}
