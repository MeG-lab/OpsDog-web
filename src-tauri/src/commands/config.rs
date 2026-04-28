use crate::models::AppConfig;
use std::path::PathBuf;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::collections::HashSet;
#[cfg(target_os = "macos")]
use std::process::Command;

const LLM_KEYCHAIN_SERVICE: &str = "AIops智能运维中枢.llm";

/// Load application configuration from ~/.aiops/config.json
#[tauri::command]
pub async fn load_config() -> Result<serde_json::Value, String> {
    let config_path = get_config_path();

    if !config_path.exists() {
        // Return default config
        let default_config = AppConfig::default();
        let mut value = serde_json::to_value(default_config)
            .map_err(|e| format!("Failed to serialize default config: {}", e))?;
        hydrate_llm_api_keys(&mut value)?;
        return Ok(value);
    }

    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config file: {}", e))?;

    let mut config: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse config file: {}", e))?;
    hydrate_llm_api_keys(&mut config)?;
    Ok(config)
}

/// Save application configuration to ~/.aiops/config.json
#[tauri::command]
pub async fn save_config(config: serde_json::Value) -> Result<(), String> {
    let config_path = get_config_path();
    let mut config = config;

    // Ensure parent directory exists
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
    }

    persist_llm_api_keys(&mut config, &config_path)?;

    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    std::fs::write(&config_path, content)
        .map_err(|e| format!("Failed to write config file: {}", e))?;

    #[cfg(unix)]
    {
        let permissions = std::fs::Permissions::from_mode(0o600);
        std::fs::set_permissions(&config_path, permissions)
            .map_err(|e| format!("Failed to set config file permissions: {}", e))?;
    }

    log::info!("Configuration saved to {:?}", config_path);
    Ok(())
}

/// Get the app data directory path
#[tauri::command]
pub async fn get_app_data_dir() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    let aiops_dir = home.join(".aiops");

    // Ensure the directory exists
    std::fs::create_dir_all(&aiops_dir)
        .map_err(|e| format!("Failed to create data directory: {}", e))?;

    Ok(aiops_dir.to_string_lossy().to_string())
}

fn get_config_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".aiops").join("config.json")
}

fn persist_llm_api_keys(config: &mut serde_json::Value, config_path: &PathBuf) -> Result<(), String> {
    let previous_ids = read_existing_llm_ids(config_path);
    let mut next_ids = HashSet::new();

    let llm_configs = get_llm_configs_mut(config);

    if let Some(configs) = llm_configs {
        for item in configs.iter_mut() {
            let Some(obj) = item.as_object_mut() else {
                continue;
            };

            let Some(id) = obj.get("id").and_then(|value| value.as_str()).map(str::to_string) else {
                continue;
            };
            next_ids.insert(id.clone());

            let api_key = obj
                .get("apiKey")
                .or_else(|| obj.get("api_key"))
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .trim()
                .to_string();

            if api_key.is_empty() {
                let _ = delete_llm_api_key(&id);
                obj.insert("apiKeyStored".to_string(), serde_json::Value::Bool(false));
                obj.insert("apiKey".to_string(), serde_json::Value::String(String::new()));
                continue;
            }

            store_llm_api_key(&id, &api_key)?;
            obj.insert("apiKeyStored".to_string(), serde_json::Value::Bool(true));
            obj.insert("apiKey".to_string(), serde_json::Value::String(String::new()));
        }
    }

    for removed_id in previous_ids.difference(&next_ids) {
        let _ = delete_llm_api_key(removed_id);
    }

    Ok(())
}

fn hydrate_llm_api_keys(config: &mut serde_json::Value) -> Result<(), String> {
    let llm_configs = get_llm_configs_mut(config);

    if let Some(configs) = llm_configs {
        for item in configs.iter_mut() {
            let Some(obj) = item.as_object_mut() else {
                continue;
            };

            let Some(id) = obj.get("id").and_then(|value| value.as_str()) else {
                continue;
            };

            if let Some(api_key) = load_llm_api_key(id)? {
                obj.insert("apiKey".to_string(), serde_json::Value::String(api_key));
                obj.insert("apiKeyStored".to_string(), serde_json::Value::Bool(true));
                continue;
            }

            if let Some(existing) = obj.get("apiKey").and_then(|value| value.as_str()) {
                if !existing.trim().is_empty() {
                    obj.insert("apiKeyStored".to_string(), serde_json::Value::Bool(false));
                }
            }
        }
    }

    Ok(())
}

fn read_existing_llm_ids(config_path: &PathBuf) -> HashSet<String> {
    let Ok(content) = std::fs::read_to_string(config_path) else {
        return HashSet::new();
    };
    let Ok(config) = serde_json::from_str::<serde_json::Value>(&content) else {
        return HashSet::new();
    };

    config
        .get("llmConfigs")
        .or_else(|| config.get("llm_configs"))
        .and_then(|value| value.as_array())
        .into_iter()
        .flat_map(|items| items.iter())
        .filter_map(|item| item.get("id").and_then(|value| value.as_str()).map(str::to_string))
        .collect()
}

fn get_llm_configs_mut(config: &mut serde_json::Value) -> Option<&mut Vec<serde_json::Value>> {
    if config.get("llmConfigs").is_some() {
        return config.get_mut("llmConfigs").and_then(|value| value.as_array_mut());
    }
    if config.get("llm_configs").is_some() {
        return config.get_mut("llm_configs").and_then(|value| value.as_array_mut());
    }
    None
}

fn llm_account_name(id: &str) -> String {
    format!("llm-config:{}", id)
}

#[cfg(target_os = "macos")]
fn store_llm_api_key(id: &str, api_key: &str) -> Result<(), String> {
    let output = Command::new("security")
        .args([
            "add-generic-password",
            "-U",
            "-s",
            LLM_KEYCHAIN_SERVICE,
            "-a",
            &llm_account_name(id),
            "-w",
            api_key,
        ])
        .output()
        .map_err(|e| format!("Failed to access macOS Keychain: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "Failed to store API key in Keychain: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

#[cfg(not(target_os = "macos"))]
fn store_llm_api_key(_id: &str, _api_key: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn load_llm_api_key(id: &str) -> Result<Option<String>, String> {
    let output = Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            LLM_KEYCHAIN_SERVICE,
            "-a",
            &llm_account_name(id),
            "-w",
        ])
        .output()
        .map_err(|e| format!("Failed to access macOS Keychain: {}", e))?;

    if output.status.success() {
        Ok(Some(String::from_utf8_lossy(&output.stdout).trim().to_string()))
    } else if String::from_utf8_lossy(&output.stderr).contains("could not be found") {
        Ok(None)
    } else {
        Err(format!(
            "Failed to load API key from Keychain: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

#[cfg(not(target_os = "macos"))]
fn load_llm_api_key(_id: &str) -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(target_os = "macos")]
fn delete_llm_api_key(id: &str) -> Result<(), String> {
    let output = Command::new("security")
        .args([
            "delete-generic-password",
            "-s",
            LLM_KEYCHAIN_SERVICE,
            "-a",
            &llm_account_name(id),
        ])
        .output()
        .map_err(|e| format!("Failed to access macOS Keychain: {}", e))?;

    if output.status.success() || String::from_utf8_lossy(&output.stderr).contains("could not be found") {
        Ok(())
    } else {
        Err(format!(
            "Failed to delete API key from Keychain: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

#[cfg(not(target_os = "macos"))]
fn delete_llm_api_key(_id: &str) -> Result<(), String> {
    Ok(())
}
