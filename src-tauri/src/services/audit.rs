use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::File;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEventRecord {
    pub time: String,
    pub event_type: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEventSummary {
    pub total: usize,
    pub returned: usize,
    pub event_types: Vec<AuditEventTypeCount>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEventTypeCount {
    pub event_type: String,
    pub count: usize,
}

pub fn append_audit_event(event_type: &str, payload: Value) -> Result<(), String> {
    let line = json!({
        "time": Utc::now().to_rfc3339(),
        "eventType": event_type,
        "payload": payload,
    });

    let path = get_audit_log_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create audit directory: {}", e))?;
    }

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open audit log: {}", e))?;

    writeln!(file, "{}", line)
        .map_err(|e| format!("Failed to write audit log: {}", e))?;

    Ok(())
}

pub fn load_audit_events(
    limit: Option<usize>,
    event_type: Option<&str>,
    search: Option<&str>,
) -> Result<Vec<AuditEventRecord>, String> {
    let path = get_audit_log_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let file = File::open(&path).map_err(|e| format!("Failed to open audit log for reading: {}", e))?;
    let reader = BufReader::new(file);
    let event_type = event_type.map(str::trim).filter(|value| !value.is_empty());
    let search = search
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_lowercase());

    let mut events = Vec::new();
    for line in reader.lines() {
        let raw = line.map_err(|e| format!("Failed to read audit log line: {}", e))?;
        if raw.trim().is_empty() {
            continue;
        }

        let Ok(event) = serde_json::from_str::<AuditEventRecord>(&raw) else {
            continue;
        };

        if let Some(expected_event_type) = event_type {
            if event.event_type != expected_event_type {
                continue;
            }
        }

        if let Some(query) = &search {
            let haystack = raw.to_lowercase();
            if !haystack.contains(query) {
                continue;
            }
        }

        events.push(event);
    }

    events.reverse();
    if let Some(max_items) = limit {
        events.truncate(max_items);
    }

    Ok(events)
}

pub fn summarize_audit_events(
    limit: Option<usize>,
    event_type: Option<&str>,
    search: Option<&str>,
) -> Result<AuditEventSummary, String> {
    let events = load_audit_events(limit, event_type, search)?;
    let mut counts = std::collections::BTreeMap::<String, usize>::new();
    for event in &events {
        *counts.entry(event.event_type.clone()).or_insert(0) += 1;
    }

    Ok(AuditEventSummary {
        total: events.len(),
        returned: events.len(),
        event_types: counts
            .into_iter()
            .map(|(event_type, count)| AuditEventTypeCount { event_type, count })
            .collect(),
    })
}

pub fn get_audit_log_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home.join(".aiops").join("audit.log"))
}
