use crate::models::{AppConfig, ManagedTaskInfo, PythonEnvInfo, ScriptExecutionResult};
use crate::commands::skills::{collect_skills, resolve_skill_entry_script_path, validate_skill_args_internal};
use crate::services::audit::append_audit_event;
use chrono::Utc;
use serde_json::json;
use std::collections::{HashMap, VecDeque};
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader as StdBufReader};
#[cfg(target_family = "unix")]
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::Stdio;
use std::process::Command as StdCommand;
use std::sync::Arc;
use std::time::Instant;
use tauri::State;
use tokio::sync::Mutex;
use tokio::process::Command as TokioCommand;

const MAX_MANAGED_LOGS: usize = 80;

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
struct PersistedManagedTask {
    task_id: String,
    script_path: String,
    log_path: Option<String>,
    args: Vec<String>,
    pid: Option<u32>,
    desired_state: String,
    auto_restart: bool,
    restart_delay_seconds: u64,
    restart_attempts: u32,
    last_restart_at: Option<String>,
    last_error: Option<String>,
    status: String,
    started_at: Option<String>,
    stopped_at: Option<String>,
    last_output_at: Option<String>,
    last_level: Option<String>,
    exit_code: Option<i32>,
    recent_logs: Vec<String>,
}

#[derive(Default)]
pub struct ManagedTaskState {
    tasks: Mutex<HashMap<String, Arc<Mutex<ManagedTaskRuntime>>>>,
}

const DEFAULT_RESTART_DELAY_SECONDS: u64 = 5;

struct ManagedTaskRuntime {
    task_id: String,
    script_path: String,
    log_path: Option<String>,
    args: Vec<String>,
    status: String,
    pid: Option<u32>,
    started_at: Option<String>,
    stopped_at: Option<String>,
    last_output_at: Option<String>,
    last_level: Option<String>,
    exit_code: Option<i32>,
    recent_logs: VecDeque<String>,
}

/// Check if Python is available in the system
#[tauri::command]
pub async fn check_python_env() -> Result<PythonEnvInfo, String> {
    // Try common Python paths
    let python_candidates = vec!["python3", "python"];

    for candidate in python_candidates {
        match TokioCommand::new(candidate)
            .arg("--version")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await
        {
            Ok(output) => {
                let version_str = String::from_utf8_lossy(&output.stdout).to_string();
                let stderr_str = String::from_utf8_lossy(&output.stderr).to_string();
                // Python --version may output to either stdout or stderr
                let version = if version_str.starts_with("Python") {
                    version_str.trim().to_string()
                } else if stderr_str.starts_with("Python") {
                    stderr_str.trim().to_string()
                } else {
                    continue;
                };

                // Get the full path of the Python interpreter
                let path = match TokioCommand::new("which")
                    .arg(candidate)
                    .stdout(Stdio::piped())
                    .output()
                    .await
                {
                    Ok(output) => String::from_utf8_lossy(&output.stdout).trim().to_string(),
                    Err(_) => candidate.to_string(),
                };

                return Ok(PythonEnvInfo {
                    available: true,
                    version,
                    path,
                });
            }
            Err(_) => continue,
        }
    }

    Ok(PythonEnvInfo {
        available: false,
        version: String::new(),
        path: String::new(),
    })
}

/// Execute a Python script with timeout control
#[tauri::command]
pub async fn execute_python_script(
    script_path: String,
    args: Vec<String>,
    timeout_ms: u64,
) -> Result<ScriptExecutionResult, String> {
    execute_python_script_internal(script_path, args, timeout_ms).await
}

#[tauri::command]
pub async fn execute_instant_skill(
    skill_name: String,
    args: Vec<String>,
) -> Result<ScriptExecutionResult, String> {
    let skill = collect_skills()?
        .into_iter()
        .find(|item| item.name == skill_name)
        .ok_or_else(|| format!("Skill not found: {}", skill_name))?;

    if skill.task_kind != "instant" {
        return Err(format!("Skill is not an instant task: {}", skill_name));
    }

    let validated = validate_skill_args_internal(&skill.path, &args)?;
    if !validated.valid {
        return Err(format!("Skill argument validation failed: {}", validated.errors.join("；")));
    }

    let script_path = resolve_skill_entry_script_path(&skill.path, &skill.entry_script)?;
    execute_python_script_internal(script_path, validated.normalized_args, skill.timeout_seconds * 1000).await
}

async fn execute_python_script_internal(
    script_path: String,
    args: Vec<String>,
    timeout_ms: u64,
) -> Result<ScriptExecutionResult, String> {
    log::info!("Executing Python script: {} with args: {:?}", script_path, args);

    let start = Instant::now();

    // Validate script path exists
    if !std::path::Path::new(&script_path).exists() {
        return Err(format!("Script not found: {}", script_path));
    }

    let mut cmd = TokioCommand::new(resolve_python_path());
    cmd.arg(&script_path)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let child = cmd.spawn().map_err(|e| format!("Failed to spawn Python process: {}", e))?;

    // Apply timeout
    let timeout_duration = std::time::Duration::from_millis(timeout_ms);
    let result = tokio::time::timeout(timeout_duration, child.wait_with_output()).await;

    match result {
        Ok(Ok(output)) => {
            let execution_time_ms = start.elapsed().as_millis() as u64;
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();

            // Truncate if output is too large (> 100KB)
            let max_len = 100 * 1024;
            let (stdout, truncated) = if stdout.len() > max_len {
                (stdout[..max_len].to_string(), true)
            } else {
                (stdout, false)
            };

            let result = ScriptExecutionResult {
                exit_code: output.status.code().unwrap_or(-1),
                stdout,
                stderr,
                execution_time_ms,
                truncated,
            };
            let _ = append_audit_event("python_script_execute", json!({
                "scriptPath": script_path,
                "args": args,
                "timeoutMs": timeout_ms,
                "exitCode": result.exit_code,
                "executionTimeMs": result.execution_time_ms,
                "truncated": result.truncated,
            }));
            Ok(result)
        }
        Ok(Err(e)) => Err(format!("Script execution failed: {}", e)),
        Err(_) => {
            let execution_time_ms = start.elapsed().as_millis() as u64;
            let result = ScriptExecutionResult {
                exit_code: -1,
                stdout: String::new(),
                stderr: "Script execution timed out".to_string(),
                execution_time_ms,
                truncated: false,
            };
            let _ = append_audit_event("python_script_execute", json!({
                "scriptPath": script_path,
                "args": args,
                "timeoutMs": timeout_ms,
                "exitCode": result.exit_code,
                "executionTimeMs": result.execution_time_ms,
                "truncated": result.truncated,
                "timedOut": true,
            }));
            Ok(result)
        }
    }
}

#[tauri::command]
pub async fn start_managed_task(
    state: State<'_, ManagedTaskState>,
    task_id: String,
    script_path: String,
    args: Vec<String>,
) -> Result<ManagedTaskInfo, String> {
    let result = spawn_managed_task(&state, task_id.clone(), script_path.clone(), args.clone()).await;
    if let Ok(info) = &result {
        let _ = persist_managed_task(info);
        let _ = append_audit_event("managed_task_start", json!({
            "taskId": task_id,
            "scriptPath": script_path,
            "args": args,
            "status": info.status,
            "pid": info.pid,
        }));
    }
    result
}

#[tauri::command]
pub async fn restart_managed_task(
    state: State<'_, ManagedTaskState>,
    task_id: String,
    script_path: String,
    args: Vec<String>,
) -> Result<ManagedTaskInfo, String> {
    let existing = {
        let tasks = state.tasks.lock().await;
        tasks.get(&task_id).cloned()
    };

    if let Some(runtime) = existing {
        let pid = {
            let mut entry = runtime.lock().await;
            entry.status = "stopping".to_string();
            entry.push_log("[system] restarting managed task".to_string(), Some("info".to_string()));
            entry.pid
        };

        if let Some(pid) = pid {
            terminate_process(pid).await?;

            for _ in 0..20 {
                let stopped = {
                    let entry = runtime.lock().await;
                    matches!(entry.status.as_str(), "stopped" | "error")
                };
                if stopped {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            }
        }
    }

    let result = spawn_managed_task(&state, task_id.clone(), script_path.clone(), args.clone()).await;
    if let Ok(info) = &result {
        let _ = persist_managed_task(info);
        let _ = append_audit_event("managed_task_restart", json!({
            "taskId": task_id,
            "scriptPath": script_path,
            "args": args,
            "status": info.status,
            "pid": info.pid,
        }));
    }
    result
}

async fn spawn_managed_task(
    state: &State<'_, ManagedTaskState>,
    task_id: String,
    script_path: String,
    args: Vec<String>,
) -> Result<ManagedTaskInfo, String> {
    if task_id.trim().is_empty() {
        return Err("Task id is required".to_string());
    }

    if !std::path::Path::new(&script_path).exists() {
        return Err(format!("Script not found: {}", script_path));
    }

    let existing = {
        let tasks = state.tasks.lock().await;
        tasks.get(&task_id).cloned()
    };

    if let Some(runtime) = existing {
        let snapshot = runtime.lock().await.to_info();
        if snapshot.status == "starting" || snapshot.status == "running" || snapshot.status == "warning" || snapshot.status == "attention" || snapshot.status == "recovered" {
            return Err(format!("Managed task already running: {}", task_id));
        }
    }

    let log_path = get_managed_task_log_path(&task_id);
    if let Some(parent) = log_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create managed task log directory: {}", e))?;
    }

    let stdout_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Failed to open managed task log file: {}", e))?;
    let stderr_file = stdout_file
        .try_clone()
        .map_err(|e| format!("Failed to clone managed task log file handle: {}", e))?;

    let mut cmd = StdCommand::new(resolve_python_path());
    cmd.arg(&script_path)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file));

    #[cfg(target_family = "unix")]
    {
        cmd.process_group(0);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn managed task: {}", e))?;

    let pid = Some(child.id());

    let runtime = Arc::new(Mutex::new(ManagedTaskRuntime {
        task_id: task_id.clone(),
        script_path: script_path.clone(),
        log_path: Some(log_path.to_string_lossy().to_string()),
        args: args.clone(),
        status: "running".to_string(),
        pid,
        started_at: Some(now_iso()),
        stopped_at: None,
        last_output_at: None,
        last_level: Some("info".to_string()),
        exit_code: None,
        recent_logs: VecDeque::new(),
    }));

    {
        let mut tasks = state.tasks.lock().await;
        tasks.insert(task_id.clone(), runtime.clone());
    }

    let info = refresh_runtime_snapshot(runtime).await;
    Ok(info)
}

#[tauri::command]
pub async fn stop_managed_task(
    state: State<'_, ManagedTaskState>,
    task_id: String,
) -> Result<ManagedTaskInfo, String> {
    let runtime = {
        let tasks = state.tasks.lock().await;
        tasks.get(&task_id).cloned()
    };

    let persisted = load_persisted_managed_tasks()?
        .into_iter()
        .find(|task| task.task_id == task_id);

    let pid = if let Some(runtime) = &runtime {
        {
            let mut entry = runtime.lock().await;
            entry.status = "stopping".to_string();
            entry.push_log("[system] stopping managed task".to_string(), Some("info".to_string()));
        }
        runtime.lock().await.pid
    } else {
        persisted.as_ref().and_then(|task| task.pid)
    }
    .ok_or_else(|| format!("Managed task has no active pid: {}", task_id))?;

    terminate_process(pid).await?;

    if let Some(runtime) = runtime {
        let mut entry = runtime.lock().await;
        entry.pid = None;
        entry.status = "stopped".to_string();
        entry.stopped_at = Some(now_iso());
        entry.push_log("[system] managed task stopped".to_string(), Some("info".to_string()));
    }

    let info = if let Some(runtime) = {
        let tasks = state.tasks.lock().await;
        tasks.get(&task_id).cloned()
    } {
        refresh_runtime_snapshot(runtime).await
    } else if let Some(task) = persisted {
        let refreshed = refresh_persisted_task(task, true);
        persist_persisted_task_snapshot(&refreshed)?;
        persisted_to_info(&refreshed)
    } else {
        return Err(format!("Managed task not found after stop: {}", task_id));
    };
    let _ = mark_persisted_managed_task_stopped(&task_id, &info);
    let _ = append_audit_event("managed_task_stop", json!({
        "taskId": task_id,
        "status": info.status,
        "pid": info.pid,
    }));
    Ok(info)
}

#[tauri::command]
pub async fn restore_managed_tasks(
    state: State<'_, ManagedTaskState>,
) -> Result<Vec<ManagedTaskInfo>, String> {
    let persisted = load_persisted_managed_tasks()?;
    let mut restored = Vec::new();

    for task in persisted {
        if task.desired_state != "running" {
            continue;
        }
        match ensure_managed_task_runtime(&state, task).await {
            Ok(Some(info)) => restored.push(info),
            Ok(None) => {}
            Err(error) => log::warn!("Failed to ensure managed task runtime: {}", error),
        }
    }

    Ok(restored)
}

#[tauri::command]
pub async fn list_managed_tasks(
    state: State<'_, ManagedTaskState>,
) -> Result<Vec<ManagedTaskInfo>, String> {
    let persisted = refresh_all_persisted_tasks()?;
    let mut items = Vec::with_capacity(persisted.len());
    for task in persisted {
        if task.desired_state == "running" {
            match ensure_managed_task_runtime(&state, task).await? {
                Some(info) => items.push(info),
                None => {}
            }
        } else {
            items.push(persisted_to_info(&task));
        }
    }
    Ok(items)
}

#[tauri::command]
pub async fn get_managed_task(
    state: State<'_, ManagedTaskState>,
    task_id: String,
) -> Result<Option<ManagedTaskInfo>, String> {
    let runtime = {
        let tasks = state.tasks.lock().await;
        tasks.get(&task_id).cloned()
    };

    match runtime {
        Some(runtime) => Ok(Some(refresh_runtime_snapshot(runtime).await)),
        None => {
            let mut persisted = load_persisted_managed_tasks().unwrap_or_default();
            if let Some(index) = persisted.iter().position(|task| task.task_id == task_id) {
                let refreshed = refresh_persisted_task(persisted[index].clone(), false);
                if refreshed.desired_state == "running" {
                    ensure_managed_task_runtime(&state, refreshed).await
                } else {
                    if refreshed != persisted[index] {
                        persisted[index] = refreshed.clone();
                        let _ = save_persisted_managed_tasks(&persisted);
                    }
                    Ok(Some(persisted_to_info(&refreshed)))
                }
            } else {
                Ok(None)
            }
        }
    }
}

fn resolve_python_path() -> String {
    let config_path = dirs::home_dir()
        .unwrap_or_default()
        .join(".aiops")
        .join("config.json");

    let content = match std::fs::read_to_string(config_path) {
        Ok(content) => content,
        Err(_) => return AppConfig::default().python_path,
    };

    match serde_json::from_str::<AppConfig>(&content) {
        Ok(config) if !config.python_path.trim().is_empty() => config.python_path,
        _ => AppConfig::default().python_path,
    }
}

fn get_managed_tasks_state_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".aiops")
        .join("managed_tasks.json")
}

fn get_managed_task_log_path(task_id: &str) -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".aiops")
        .join("managed_logs")
        .join(format!("{}.log", task_id))
}

fn load_persisted_managed_tasks() -> Result<Vec<PersistedManagedTask>, String> {
    let path = get_managed_tasks_state_path();
    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read managed tasks state: {}", e))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse managed tasks state: {}", e))
}

fn save_persisted_managed_tasks(tasks: &[PersistedManagedTask]) -> Result<(), String> {
    let path = get_managed_tasks_state_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create managed task state directory: {}", e))?;
    }

    let content = serde_json::to_string_pretty(tasks)
        .map_err(|e| format!("Failed to serialize managed tasks state: {}", e))?;
    std::fs::write(path, content)
        .map_err(|e| format!("Failed to write managed tasks state: {}", e))
}

fn persist_managed_task(info: &ManagedTaskInfo) -> Result<(), String> {
    let mut tasks = load_persisted_managed_tasks()?;
    tasks.retain(|task| task.task_id != info.task_id);
    tasks.push(PersistedManagedTask {
        task_id: info.task_id.clone(),
        script_path: info.script_path.clone(),
        log_path: info.log_path.clone(),
        args: info.args.clone(),
        pid: info.pid,
        desired_state: if matches!(info.status.as_str(), "stopped") { "stopped".to_string() } else { "running".to_string() },
        auto_restart: true,
        restart_delay_seconds: DEFAULT_RESTART_DELAY_SECONDS,
        restart_attempts: 0,
        last_restart_at: info.started_at.clone(),
        last_error: None,
        status: info.status.clone(),
        started_at: info.started_at.clone(),
        stopped_at: info.stopped_at.clone(),
        last_output_at: info.last_output_at.clone(),
        last_level: info.last_level.clone(),
        exit_code: info.exit_code,
        recent_logs: info.recent_logs.clone(),
    });
    save_persisted_managed_tasks(&tasks)
}

fn mark_persisted_managed_task_stopped(task_id: &str, info: &ManagedTaskInfo) -> Result<(), String> {
    let mut tasks = load_persisted_managed_tasks()?;
    let mut found = false;
    for task in &mut tasks {
        if task.task_id == task_id {
            task.desired_state = "stopped".to_string();
            task.status = info.status.clone();
            task.log_path = info.log_path.clone();
            task.pid = info.pid;
            task.last_error = None;
            task.stopped_at = info.stopped_at.clone();
            task.last_output_at = info.last_output_at.clone();
            task.last_level = info.last_level.clone();
            task.exit_code = info.exit_code;
            task.recent_logs = info.recent_logs.clone();
            found = true;
        }
    }
    if !found {
        tasks.push(PersistedManagedTask {
            task_id: task_id.to_string(),
            script_path: info.script_path.clone(),
            log_path: info.log_path.clone(),
            args: info.args.clone(),
            pid: info.pid,
            desired_state: "stopped".to_string(),
            auto_restart: true,
            restart_delay_seconds: DEFAULT_RESTART_DELAY_SECONDS,
            restart_attempts: 0,
            last_restart_at: info.started_at.clone(),
            last_error: None,
            status: info.status.clone(),
            started_at: info.started_at.clone(),
            stopped_at: info.stopped_at.clone(),
            last_output_at: info.last_output_at.clone(),
            last_level: info.last_level.clone(),
            exit_code: info.exit_code,
            recent_logs: info.recent_logs.clone(),
        });
    }
    save_persisted_managed_tasks(&tasks)
}

fn update_persisted_task_snapshot(info: &ManagedTaskInfo) {
    let _ = persist_managed_task(info);
}

fn persist_persisted_task_snapshot(task: &PersistedManagedTask) -> Result<(), String> {
    let mut tasks = load_persisted_managed_tasks()?;
    tasks.retain(|item| item.task_id != task.task_id);
    tasks.push(task.clone());
    save_persisted_managed_tasks(&tasks)
}

impl ManagedTaskRuntime {
    fn push_log(&mut self, line: String, level: Option<String>) {
        self.last_output_at = Some(now_iso());
        if let Some(level) = level {
            self.last_level = Some(level.clone());
            if !matches!(self.status.as_str(), "stopping" | "stopped" | "error") {
                self.status = map_level_to_status(&level).to_string();
            }
        }
        self.recent_logs.push_back(line);
        while self.recent_logs.len() > MAX_MANAGED_LOGS {
            self.recent_logs.pop_front();
        }
    }

    fn to_info(&self) -> ManagedTaskInfo {
        ManagedTaskInfo {
            task_id: self.task_id.clone(),
            script_path: self.script_path.clone(),
            log_path: self.log_path.clone(),
            args: self.args.clone(),
            status: self.status.clone(),
            pid: self.pid,
            started_at: self.started_at.clone(),
            stopped_at: self.stopped_at.clone(),
            last_output_at: self.last_output_at.clone(),
            last_level: self.last_level.clone(),
            exit_code: self.exit_code,
            recent_logs: self.recent_logs.iter().cloned().collect(),
        }
    }
}

fn parse_log_level(line: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(line)
        .ok()
        .and_then(|value| value.get("level").and_then(|level| level.as_str()).map(|s| s.to_string()))
}

fn parse_log_time(line: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(line)
        .ok()
        .and_then(|value| value.get("time").and_then(|field| field.as_str()).map(|s| s.to_string()))
}

fn map_level_to_status(level: &str) -> &'static str {
    match level {
        "running" => "running",
        "recovered" => "recovered",
        "warning" => "warning",
        "attention" => "attention",
        "error" => "error",
        _ => "running",
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

async fn terminate_process(pid: u32) -> Result<(), String> {
    #[cfg(target_family = "unix")]
    {
        let term_status = TokioCommand::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .status()
            .await
            .map_err(|e| format!("Failed to send SIGTERM: {}", e))?;

        if !term_status.success() {
            return Err(format!("Failed to stop managed task process: {}", pid));
        }

        tokio::time::sleep(std::time::Duration::from_millis(300)).await;

        let still_running = TokioCommand::new("kill")
            .arg("-0")
            .arg(pid.to_string())
            .status()
            .await
            .map(|status| status.success())
            .unwrap_or(false);

        if still_running {
            let kill_status = TokioCommand::new("kill")
                .arg("-KILL")
                .arg(pid.to_string())
                .status()
                .await
                .map_err(|e| format!("Failed to send SIGKILL: {}", e))?;

            if !kill_status.success() {
                return Err(format!("Failed to force stop managed task process: {}", pid));
            }
        }

        return Ok(());
    }

    #[cfg(target_family = "windows")]
    {
        let status = TokioCommand::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status()
            .await
            .map_err(|e| format!("Failed to stop process: {}", e))?;

        if status.success() {
            Ok(())
        } else {
            Err(format!("Failed to stop managed task process: {}", pid))
        }
    }
}

async fn is_process_running(pid: u32) -> bool {
    #[cfg(target_family = "unix")]
    {
        return TokioCommand::new("kill")
            .arg("-0")
            .arg(pid.to_string())
            .status()
            .await
            .map(|status| status.success())
            .unwrap_or(false);
    }

    #[cfg(target_family = "windows")]
    {
        return TokioCommand::new("tasklist")
            .args(["/FI", &format!("PID eq {}", pid)])
            .output()
            .await
            .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
            .unwrap_or(false);
    }
}

fn is_process_running_sync(pid: u32) -> bool {
    #[cfg(target_family = "unix")]
    {
        return StdCommand::new("kill")
            .arg("-0")
            .arg(pid.to_string())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
    }

    #[cfg(target_family = "windows")]
    {
        return StdCommand::new("tasklist")
            .args(["/FI", &format!("PID eq {}", pid)])
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
            .unwrap_or(false);
    }
}

fn read_recent_logs(path: Option<&str>) -> Vec<String> {
    let Some(path) = path else {
        return Vec::new();
    };
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return Vec::new(),
    };
    let reader = StdBufReader::new(file);
    let mut lines = VecDeque::new();
    for line in reader.lines().map_while(Result::ok) {
        lines.push_back(line);
        while lines.len() > MAX_MANAGED_LOGS {
            lines.pop_front();
        }
    }
    lines.into_iter().collect()
}

fn runtime_from_persisted(task: &PersistedManagedTask) -> ManagedTaskRuntime {
    ManagedTaskRuntime {
        task_id: task.task_id.clone(),
        script_path: task.script_path.clone(),
        log_path: task.log_path.clone(),
        args: task.args.clone(),
        status: task.status.clone(),
        pid: task.pid,
        started_at: task.started_at.clone(),
        stopped_at: task.stopped_at.clone(),
        last_output_at: task.last_output_at.clone(),
        last_level: task.last_level.clone(),
        exit_code: task.exit_code,
        recent_logs: task.recent_logs.clone().into_iter().collect(),
    }
}

fn persisted_to_info(task: &PersistedManagedTask) -> ManagedTaskInfo {
    ManagedTaskInfo {
        task_id: task.task_id.clone(),
        script_path: task.script_path.clone(),
        log_path: task.log_path.clone(),
        args: task.args.clone(),
        status: task.status.clone(),
        pid: task.pid,
        started_at: task.started_at.clone(),
        stopped_at: task.stopped_at.clone(),
        last_output_at: task.last_output_at.clone(),
        last_level: task.last_level.clone(),
        exit_code: task.exit_code,
        recent_logs: task.recent_logs.clone(),
    }
}

async fn refresh_runtime_snapshot(runtime: Arc<Mutex<ManagedTaskRuntime>>) -> ManagedTaskInfo {
    let snapshot = runtime.lock().await.to_info();
    let refreshed = refresh_info_from_parts(
        snapshot.task_id.clone(),
        snapshot.script_path.clone(),
        snapshot.log_path.clone(),
        snapshot.args.clone(),
        snapshot.status.clone(),
        snapshot.pid,
        snapshot.started_at.clone(),
        snapshot.stopped_at.clone(),
        snapshot.last_output_at.clone(),
        snapshot.last_level.clone(),
        snapshot.exit_code,
        snapshot.recent_logs.clone(),
        "running".to_string(),
        false,
    );

    let mut entry = runtime.lock().await;
    entry.status = refreshed.status.clone();
    entry.pid = refreshed.pid;
    entry.started_at = refreshed.started_at.clone();
    entry.stopped_at = refreshed.stopped_at.clone();
    entry.last_output_at = refreshed.last_output_at.clone();
    entry.last_level = refreshed.last_level.clone();
    entry.exit_code = refreshed.exit_code;
    entry.recent_logs = refreshed.recent_logs.iter().cloned().collect();
    drop(entry);

    update_persisted_task_snapshot(&refreshed);
    refreshed
}

fn refresh_persisted_task(task: PersistedManagedTask, forced_stopped: bool) -> PersistedManagedTask {
    let info = refresh_info_from_parts(
        task.task_id.clone(),
        task.script_path.clone(),
        task.log_path.clone(),
        task.args.clone(),
        task.status.clone(),
        task.pid,
        task.started_at.clone(),
        task.stopped_at.clone(),
        task.last_output_at.clone(),
        task.last_level.clone(),
        task.exit_code,
        task.recent_logs.clone(),
        task.desired_state.clone(),
        forced_stopped,
    );

    PersistedManagedTask {
        task_id: info.task_id,
        script_path: info.script_path,
        log_path: info.log_path,
        args: info.args,
        pid: info.pid,
        desired_state: if forced_stopped { "stopped".to_string() } else if matches!(info.status.as_str(), "stopped") { "stopped".to_string() } else { task.desired_state },
        auto_restart: task.auto_restart,
        restart_delay_seconds: task.restart_delay_seconds,
        restart_attempts: task.restart_attempts,
        last_restart_at: task.last_restart_at,
        last_error: if matches!(info.status.as_str(), "error") {
            Some(format!("Managed task unavailable at {}", now_iso()))
        } else {
            task.last_error
        },
        status: info.status,
        started_at: info.started_at,
        stopped_at: info.stopped_at,
        last_output_at: info.last_output_at,
        last_level: info.last_level,
        exit_code: info.exit_code,
        recent_logs: info.recent_logs,
    }
}

fn refresh_all_persisted_tasks() -> Result<Vec<PersistedManagedTask>, String> {
    let tasks = load_persisted_managed_tasks()?;
    let mut changed = false;
    let mut refreshed = Vec::with_capacity(tasks.len());
    for task in tasks {
        let next = refresh_persisted_task(task.clone(), false);
        if next != task {
            changed = true;
        }
        refreshed.push(next);
    }
    if changed {
        save_persisted_managed_tasks(&refreshed)?;
    }
    Ok(refreshed)
}

async fn ensure_managed_task_runtime(
    state: &State<'_, ManagedTaskState>,
    task: PersistedManagedTask,
) -> Result<Option<ManagedTaskInfo>, String> {
    if let Some(pid) = task.pid {
        if is_process_running(pid).await {
            let runtime = Arc::new(Mutex::new(runtime_from_persisted(&task)));
            {
                let mut tasks = state.tasks.lock().await;
                tasks.insert(task.task_id.clone(), runtime.clone());
            }
            let info = refresh_runtime_snapshot(runtime).await;
            let _ = append_audit_event("managed_task_restore", json!({
                "taskId": task.task_id,
                "scriptPath": task.script_path,
                "args": task.args,
                "status": info.status,
                "pid": info.pid,
                "reattached": true,
            }));
            return Ok(Some(info));
        }
    }

    if task.desired_state != "running" {
        return Ok(Some(persisted_to_info(&task)));
    }

    if !task.auto_restart {
        return Ok(Some(persisted_to_info(&task)));
    }

    if !should_restart_task(&task) {
        return Ok(Some(persisted_to_info(&task)));
    }

    match spawn_managed_task(state, task.task_id.clone(), task.script_path.clone(), task.args.clone()).await {
        Ok(info) => {
            let mut persisted_snapshot = task.clone();
            persisted_snapshot.pid = info.pid;
            persisted_snapshot.status = info.status.clone();
            persisted_snapshot.started_at = info.started_at.clone();
            persisted_snapshot.stopped_at = info.stopped_at.clone();
            persisted_snapshot.last_output_at = info.last_output_at.clone();
            persisted_snapshot.last_level = info.last_level.clone();
            persisted_snapshot.exit_code = info.exit_code;
            persisted_snapshot.recent_logs = info.recent_logs.clone();
            persisted_snapshot.restart_attempts += 1;
            persisted_snapshot.last_restart_at = Some(now_iso());
            persisted_snapshot.last_error = None;
            persist_persisted_task_snapshot(&persisted_snapshot)?;
            let _ = append_audit_event("managed_task_restore", json!({
                "taskId": task.task_id,
                "scriptPath": task.script_path,
                "args": task.args,
                "status": info.status,
                "pid": info.pid,
                "restarted": true,
                "restartAttempts": persisted_snapshot.restart_attempts,
            }));
            Ok(Some(info))
        }
        Err(error) => {
            let mut failed_snapshot = task.clone();
            failed_snapshot.status = "error".to_string();
            failed_snapshot.pid = None;
            failed_snapshot.stopped_at = Some(now_iso());
            failed_snapshot.last_error = Some(error.clone());
            failed_snapshot.restart_attempts += 1;
            failed_snapshot.last_restart_at = Some(now_iso());
            persist_persisted_task_snapshot(&failed_snapshot)?;
            let _ = append_audit_event("managed_task_restore_failed", json!({
                "taskId": task.task_id,
                "scriptPath": task.script_path,
                "args": task.args,
                "error": error,
                "restartAttempts": failed_snapshot.restart_attempts,
            }));
            Ok(Some(persisted_to_info(&failed_snapshot)))
        }
    }
}

fn refresh_info_from_parts(
    task_id: String,
    script_path: String,
    log_path: Option<String>,
    args: Vec<String>,
    current_status: String,
    pid: Option<u32>,
    started_at: Option<String>,
    stopped_at: Option<String>,
    last_output_at: Option<String>,
    last_level: Option<String>,
    exit_code: Option<i32>,
    recent_logs: Vec<String>,
    desired_state: String,
    forced_stopped: bool,
) -> ManagedTaskInfo {
    let logs = {
        let file_logs = read_recent_logs(log_path.as_deref());
        if file_logs.is_empty() { recent_logs } else { file_logs }
    };

    let parsed_level = logs.iter().rev().find_map(|line| parse_log_level(line));
    let parsed_time = logs.iter().rev().find_map(|line| parse_log_time(line));
    let is_running = pid.map(is_process_running_sync).unwrap_or(false);

    let effective_level = parsed_level.or(last_level);
    let mut effective_status = if forced_stopped {
        "stopped".to_string()
    } else if is_running {
        effective_level
            .as_deref()
            .map(map_level_to_status)
            .unwrap_or("running")
            .to_string()
    } else if desired_state == "running" {
        "error".to_string()
    } else if current_status == "stopped" || current_status == "stopping" {
        "stopped".to_string()
    } else {
        current_status
    };

    if effective_status == "starting" {
        effective_status = "running".to_string();
    }

    ManagedTaskInfo {
        task_id,
        script_path,
        log_path,
        args,
        status: effective_status,
        pid: if is_running { pid } else { None },
        started_at,
        stopped_at: if is_running { None } else { stopped_at.or_else(|| Some(now_iso())) },
        last_output_at: parsed_time.or(last_output_at),
        last_level: effective_level,
        exit_code: if is_running { None } else { exit_code.or(Some(-1)) },
        recent_logs: logs,
    }
}

fn should_restart_task(task: &PersistedManagedTask) -> bool {
    if !task.auto_restart {
        return false;
    }
    match &task.last_restart_at {
        Some(last_restart_at) => chrono::DateTime::parse_from_rfc3339(last_restart_at)
            .ok()
            .map(|time| {
                let elapsed = Utc::now().signed_duration_since(time.with_timezone(&Utc));
                elapsed.num_seconds() >= task.restart_delay_seconds as i64
            })
            .unwrap_or(true),
        None => true,
    }
}

/// Get system information
#[tauri::command]
pub async fn get_system_info() -> Result<crate::models::SystemInfo, String> {
    let hostname = std::process::Command::new("hostname")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

    Ok(crate::models::SystemInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        hostname,
    })
}
