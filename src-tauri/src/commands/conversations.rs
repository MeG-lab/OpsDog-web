use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::PathBuf;

const LEGACY_CONVERSATIONS_KEY: &str = "conversations";

#[tauri::command]
pub async fn load_conversations() -> Result<Value, String> {
    let mut conn = open_storage_db()?;
    initialize_storage_schema(&conn)?;
    migrate_legacy_conversations_if_needed(&mut conn)?;

    let summaries = load_conversation_rows(&conn)?;
    let mut conversations = Vec::with_capacity(summaries.len());

    for summary in summaries {
        let messages = load_messages_for_conversation(&conn, summary["id"].as_str().unwrap_or_default())?;
        conversations.push(json!({
            "id": summary["id"],
            "title": summary["title"],
            "kind": summary["kind"],
            "systemChannel": summary["systemChannel"],
            "lastReadAt": summary["lastReadAt"],
            "messages": messages,
            "modelId": summary["modelId"],
            "createdAt": summary["createdAt"],
            "updatedAt": summary["updatedAt"],
        }));
    }

    Ok(Value::Array(conversations))
}

#[tauri::command]
pub async fn list_conversation_summaries() -> Result<Value, String> {
    let mut conn = open_storage_db()?;
    initialize_storage_schema(&conn)?;
    migrate_legacy_conversations_if_needed(&mut conn)?;
    Ok(Value::Array(load_conversation_rows(&conn)?))
}

#[tauri::command]
pub async fn load_conversation_messages(conversation_id: String) -> Result<Value, String> {
    let mut conn = open_storage_db()?;
    initialize_storage_schema(&conn)?;
    migrate_legacy_conversations_if_needed(&mut conn)?;
    Ok(Value::Array(load_messages_for_conversation(&conn, &conversation_id)?))
}

#[tauri::command]
pub async fn save_conversations(conversations: Value) -> Result<(), String> {
    let mut conn = open_storage_db()?;
    initialize_storage_schema(&conn)?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to start conversation transaction: {}", e))?;

    let list = conversations
        .as_array()
        .ok_or("Conversations payload must be an array".to_string())?;

    let incoming_ids = list
        .iter()
        .filter_map(|conversation| conversation.get("id").and_then(Value::as_str).map(str::to_string))
        .collect::<HashSet<_>>();

    prune_deleted_conversations(&tx, &incoming_ids)?;

    for conversation in list {
        upsert_conversation_record(&tx, conversation)?;
        let conversation_id = conversation
            .get("id")
            .and_then(Value::as_str)
            .ok_or("Conversation id is missing".to_string())?;
        let messages = conversation
            .get("messages")
            .and_then(Value::as_array)
            .ok_or("Conversation messages must be an array".to_string())?;
        replace_messages_for_conversation(&tx, conversation_id, messages)?;
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit conversation transaction: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn upsert_conversation(conversation: Value) -> Result<(), String> {
    let mut conn = open_storage_db()?;
    initialize_storage_schema(&conn)?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to start conversation upsert transaction: {}", e))?;
    upsert_conversation_record(&tx, &conversation)?;
    tx.commit()
        .map_err(|e| format!("Failed to commit conversation upsert: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn append_conversation_message(conversation_id: String, message: Value) -> Result<(), String> {
    let mut conn = open_storage_db()?;
    initialize_storage_schema(&conn)?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to start append message transaction: {}", e))?;
    let next_order = next_message_order(&tx, &conversation_id)?;
    insert_message(&tx, &conversation_id, &message, next_order)?;
    tx.execute(
        "UPDATE conversations SET updated_at = ?2 WHERE id = ?1",
        params![conversation_id, message.get("timestamp").and_then(Value::as_i64).unwrap_or_default()],
    )
    .map_err(|e| format!("Failed to update conversation timestamp: {}", e))?;
    tx.commit()
        .map_err(|e| format!("Failed to commit append message transaction: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn update_conversation_message(
    conversation_id: String,
    message_id: String,
    updates: Value,
) -> Result<(), String> {
    let mut conn = open_storage_db()?;
    initialize_storage_schema(&conn)?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to start update message transaction: {}", e))?;
    update_message_record(&tx, &conversation_id, &message_id, &updates)?;
    tx.commit()
        .map_err(|e| format!("Failed to commit update message transaction: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn replace_conversation_messages(conversation_id: String, messages: Value) -> Result<(), String> {
    let mut conn = open_storage_db()?;
    initialize_storage_schema(&conn)?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to start replace messages transaction: {}", e))?;
    let messages = messages
        .as_array()
        .ok_or("Conversation messages payload must be an array".to_string())?;
    replace_messages_for_conversation(&tx, &conversation_id, messages)?;
    tx.commit()
        .map_err(|e| format!("Failed to commit replace messages transaction: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn delete_conversation_record(conversation_id: String) -> Result<(), String> {
    let conn = open_storage_db()?;
    initialize_storage_schema(&conn)?;
    conn.execute("DELETE FROM conversations WHERE id = ?1", params![conversation_id])
        .map_err(|e| format!("Failed to delete conversation: {}", e))?;
    Ok(())
}

fn open_storage_db() -> Result<Connection, String> {
    let db_path = get_storage_db_path()?;
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create storage directory: {}", e))?;
    }
    Connection::open(db_path).map_err(|e| format!("Failed to open storage db: {}", e))
}

fn initialize_storage_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS app_storage (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            kind TEXT,
            system_channel TEXT,
            last_read_at INTEGER,
            model_id TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            is_streaming INTEGER NOT NULL DEFAULT 0,
            tool_calls_json TEXT,
            script_result_json TEXT,
            confirmation_request_json TEXT,
            message_order INTEGER NOT NULL,
            FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_messages_conversation_order
            ON messages(conversation_id, message_order);
        "#,
    )
    .map_err(|e| format!("Failed to initialize storage schema: {}", e))
}

fn migrate_legacy_conversations_if_needed(conn: &mut Connection) -> Result<(), String> {
    let conversation_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM conversations", [], |row| row.get(0))
        .map_err(|e| format!("Failed to count conversations: {}", e))?;
    if conversation_count > 0 {
        return Ok(());
    }

    let legacy_payload: Option<String> = conn
        .query_row(
            "SELECT value FROM app_storage WHERE key = ?1",
            params![LEGACY_CONVERSATIONS_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to read legacy conversations: {}", e))?;

    let Some(payload) = legacy_payload else {
        return Ok(());
    };

    let conversations: Value = serde_json::from_str(&payload)
        .map_err(|e| format!("Failed to parse legacy conversations: {}", e))?;
    if !conversations.is_array() {
        return Ok(());
    }

    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to start migration transaction: {}", e))?;

    if let Some(items) = conversations.as_array() {
        for conversation in items {
            upsert_conversation_record(&tx, conversation)?;
            let conversation_id = conversation
                .get("id")
                .and_then(Value::as_str)
                .ok_or("Legacy conversation id is missing".to_string())?;
            let messages = conversation
                .get("messages")
                .and_then(Value::as_array)
                .ok_or("Legacy conversation messages must be an array".to_string())?;
            replace_messages_for_conversation(&tx, conversation_id, messages)?;
        }
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit legacy conversation migration: {}", e))?;

    Ok(())
}

fn load_conversation_rows(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, kind, system_channel, last_read_at, model_id, created_at, updated_at
             FROM conversations
             ORDER BY updated_at DESC",
        )
        .map_err(|e| format!("Failed to prepare conversation summary query: {}", e))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "title": row.get::<_, String>(1)?,
                "kind": row.get::<_, Option<String>>(2)?.unwrap_or_else(|| "normal".to_string()),
                "systemChannel": row.get::<_, Option<String>>(3)?,
                "lastReadAt": row.get::<_, Option<i64>>(4)?,
                "modelId": row.get::<_, String>(5)?,
                "createdAt": row.get::<_, i64>(6)?,
                "updatedAt": row.get::<_, i64>(7)?,
            }))
        })
        .map_err(|e| format!("Failed to load conversation summaries: {}", e))?;

    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|e| format!("Failed to parse conversation summary row: {}", e))?);
    }
    Ok(items)
}

fn upsert_conversation_record(tx: &Transaction<'_>, conversation: &Value) -> Result<(), String> {
    let id = conversation
        .get("id")
        .and_then(Value::as_str)
        .ok_or("Conversation id is missing".to_string())?;
    let title = conversation.get("title").and_then(Value::as_str).unwrap_or("新对话");
    let kind = conversation.get("kind").and_then(Value::as_str);
    let system_channel = conversation.get("systemChannel").and_then(Value::as_str);
    let last_read_at = conversation.get("lastReadAt").and_then(Value::as_i64);
    let model_id = conversation.get("modelId").and_then(Value::as_str).unwrap_or_default();
    let created_at = conversation.get("createdAt").and_then(Value::as_i64).unwrap_or_default();
    let updated_at = conversation.get("updatedAt").and_then(Value::as_i64).unwrap_or(created_at);

    tx.execute(
        "INSERT INTO conversations (id, title, kind, system_channel, last_read_at, model_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            kind = excluded.kind,
            system_channel = excluded.system_channel,
            last_read_at = excluded.last_read_at,
            model_id = excluded.model_id,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at",
        params![id, title, kind, system_channel, last_read_at, model_id, created_at, updated_at],
    )
    .map_err(|e| format!("Failed to upsert conversation: {}", e))?;

    Ok(())
}

fn replace_messages_for_conversation(
    tx: &Transaction<'_>,
    conversation_id: &str,
    messages: &[Value],
) -> Result<(), String> {
    tx.execute("DELETE FROM messages WHERE conversation_id = ?1", params![conversation_id])
        .map_err(|e| format!("Failed to clear existing messages: {}", e))?;

    for (index, message) in messages.iter().enumerate() {
        insert_message(tx, conversation_id, message, index as i64)?;
    }

    Ok(())
}

fn insert_message(
    tx: &Transaction<'_>,
    conversation_id: &str,
    message: &Value,
    order: i64,
) -> Result<(), String> {
    let id = message
        .get("id")
        .and_then(Value::as_str)
        .ok_or("Message id is missing".to_string())?;
    let role = message.get("role").and_then(Value::as_str).unwrap_or("assistant");
    let content = message.get("content").and_then(Value::as_str).unwrap_or_default();
    let timestamp = message.get("timestamp").and_then(Value::as_i64).unwrap_or_default();
    let is_streaming = message.get("isStreaming").and_then(Value::as_bool).unwrap_or(false);
    let tool_calls_json = stringify_optional_json(message.get("toolCalls"))?;
    let script_result_json = stringify_optional_json(message.get("scriptResult"))?;
    let confirmation_request_json = stringify_optional_json(message.get("confirmationRequest"))?;

    tx.execute(
        "INSERT INTO messages (
            id, conversation_id, role, content, timestamp, is_streaming,
            tool_calls_json, script_result_json, confirmation_request_json, message_order
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            id,
            conversation_id,
            role,
            content,
            timestamp,
            if is_streaming { 1 } else { 0 },
            tool_calls_json,
            script_result_json,
            confirmation_request_json,
            order,
        ],
    )
    .map_err(|e| format!("Failed to insert message: {}", e))?;

    Ok(())
}

fn load_messages_for_conversation(conn: &Connection, conversation_id: &str) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, role, content, timestamp, is_streaming, tool_calls_json, script_result_json, confirmation_request_json
             FROM messages WHERE conversation_id = ?1 ORDER BY message_order ASC",
        )
        .map_err(|e| format!("Failed to prepare message query: {}", e))?;

    let rows = stmt
        .query_map(params![conversation_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        })
        .map_err(|e| format!("Failed to load messages: {}", e))?;

    let mut messages = Vec::new();
    for row in rows {
        let (id, role, content, timestamp, is_streaming, tool_calls_json, script_result_json, confirmation_request_json) =
            row.map_err(|e| format!("Failed to parse message row: {}", e))?;
        let mut message = json!({
            "id": id,
            "role": role,
            "content": content,
            "timestamp": timestamp,
            "isStreaming": is_streaming == 1,
        });

        if let Some(tool_calls) = tool_calls_json {
            message["toolCalls"] = serde_json::from_str(&tool_calls)
                .map_err(|e| format!("Failed to parse tool calls json: {}", e))?;
        }
        if let Some(script_result) = script_result_json {
            message["scriptResult"] = serde_json::from_str(&script_result)
                .map_err(|e| format!("Failed to parse script result json: {}", e))?;
        }
        if let Some(confirmation_request) = confirmation_request_json {
            message["confirmationRequest"] = serde_json::from_str(&confirmation_request)
                .map_err(|e| format!("Failed to parse confirmation request json: {}", e))?;
        }

        messages.push(message);
    }

    Ok(messages)
}

fn next_message_order(tx: &Transaction<'_>, conversation_id: &str) -> Result<i64, String> {
    tx.query_row(
        "SELECT COALESCE(MAX(message_order), -1) + 1 FROM messages WHERE conversation_id = ?1",
        params![conversation_id],
        |row| row.get(0),
    )
    .map_err(|e| format!("Failed to compute next message order: {}", e))
}

fn update_message_record(
    tx: &Transaction<'_>,
    conversation_id: &str,
    message_id: &str,
    updates: &Value,
) -> Result<(), String> {
    let existing_message = tx
        .query_row(
            "SELECT role, content, timestamp, is_streaming, tool_calls_json, script_result_json, confirmation_request_json
             FROM messages WHERE conversation_id = ?1 AND id = ?2",
            params![conversation_id, message_id],
            |row| {
                Ok(json!({
                    "role": row.get::<_, String>(0)?,
                    "content": row.get::<_, String>(1)?,
                    "timestamp": row.get::<_, i64>(2)?,
                    "isStreaming": row.get::<_, i64>(3)? == 1,
                    "toolCalls": parse_string_field(row.get::<_, Option<String>>(4)?),
                    "scriptResult": parse_string_field(row.get::<_, Option<String>>(5)?),
                    "confirmationRequest": parse_string_field(row.get::<_, Option<String>>(6)?),
                }))
            },
        )
        .optional()
        .map_err(|e| format!("Failed to load existing message: {}", e))?
        .ok_or("Message not found".to_string())?;

    let mut merged = existing_message;
    if let Some(map) = updates.as_object() {
        for (key, value) in map {
            merged[key] = value.clone();
        }
    }

    tx.execute(
        "UPDATE messages
         SET role = ?3,
             content = ?4,
             timestamp = ?5,
             is_streaming = ?6,
             tool_calls_json = ?7,
             script_result_json = ?8,
             confirmation_request_json = ?9
         WHERE conversation_id = ?1 AND id = ?2",
        params![
            conversation_id,
            message_id,
            merged.get("role").and_then(Value::as_str).unwrap_or("assistant"),
            merged.get("content").and_then(Value::as_str).unwrap_or_default(),
            merged.get("timestamp").and_then(Value::as_i64).unwrap_or_default(),
            if merged.get("isStreaming").and_then(Value::as_bool).unwrap_or(false) { 1 } else { 0 },
            stringify_optional_json(merged.get("toolCalls"))?,
            stringify_optional_json(merged.get("scriptResult"))?,
            stringify_optional_json(merged.get("confirmationRequest"))?,
        ],
    )
    .map_err(|e| format!("Failed to update message: {}", e))?;

    Ok(())
}

fn prune_deleted_conversations(tx: &Transaction<'_>, incoming_ids: &HashSet<String>) -> Result<(), String> {
    let mut stmt = tx
        .prepare("SELECT id FROM conversations")
        .map_err(|e| format!("Failed to query stored conversation ids: {}", e))?;
    let stored_ids = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("Failed to read stored conversation ids: {}", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to collect stored conversation ids: {}", e))?;

    for id in stored_ids {
        if !incoming_ids.contains(&id) {
            tx.execute("DELETE FROM conversations WHERE id = ?1", params![id])
                .map_err(|e| format!("Failed to delete removed conversation: {}", e))?;
        }
    }

    Ok(())
}

fn stringify_optional_json(value: Option<&Value>) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    serde_json::to_string(value)
        .map(Some)
        .map_err(|e| format!("Failed to serialize nested json: {}", e))
}

fn parse_string_field(value: Option<String>) -> Value {
    value
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(Value::Null)
}

fn get_storage_db_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home.join(".aiops").join("data.db"))
}
