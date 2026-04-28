use crate::models::{SkillArgsValidationResult, SkillMeta, SkillRouteMatch, UploadedSkillFile};
use regex::Regex;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Scan the skills directory and return metadata for all found skills
#[tauri::command]
pub async fn scan_skills() -> Result<Vec<SkillMeta>, String> {
    let mut skills = Vec::new();
    let mut seen = HashSet::new();
    let user_skills_dir = get_skills_dir();
    ensure_user_script_dirs()?;

    if !user_skills_dir.exists() {
        std::fs::create_dir_all(&user_skills_dir)
            .map_err(|e| format!("Failed to create skills directory: {}", e))?;
    }

    scan_skills_from_dir(&user_skills_dir, &mut skills, &mut seen)?;

    let bundled_skills_dir = get_bundled_skills_dir();
    if bundled_skills_dir.exists() {
        scan_skills_from_dir(&bundled_skills_dir, &mut skills, &mut seen)?;
    }

    Ok(skills)
}

/// Load the full instructions.md for a specific skill
#[tauri::command]
pub async fn load_skill_instructions(skill_path: String) -> Result<String, String> {
    let instructions_path = PathBuf::from(&skill_path).join("instructions.md");

    if !instructions_path.exists() {
        return Err(format!("Instructions not found at {:?}", instructions_path));
    }

    std::fs::read_to_string(&instructions_path)
        .map_err(|e| format!("Failed to read instructions: {}", e))
}

#[tauri::command]
pub async fn match_skill_routes(
    input: String,
    allowed_skills: Vec<String>,
) -> Result<Vec<SkillRouteMatch>, String> {
    let all_skills = collect_skills()?;
    let allowed = allowed_skills.into_iter().collect::<HashSet<_>>();
    let matches = all_skills
        .into_iter()
        .filter(|skill| allowed.is_empty() || allowed.contains(&skill.name))
        .filter_map(|skill| {
            let (score, matched_trigger) = calculate_skill_match(&input, &skill);
            if score > 0.3 {
                Some(SkillRouteMatch {
                    skill_name: skill.name,
                    score,
                    matched_trigger,
                })
            } else {
                None
            }
        })
        .collect::<Vec<_>>();

    let mut sorted = matches;
    sorted.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    Ok(sorted)
}

#[tauri::command]
pub async fn resolve_instant_skill_execution(
    input: String,
    allowed_skills: Vec<String>,
) -> Result<Vec<SkillRouteMatch>, String> {
    let normalized = input.to_lowercase();
    let action_hints = [
        "执行", "运行", "测试", "检查", "检测", "排查", "巡检", "诊断", "run", "execute", "check", "test", "inspect", "ping",
    ];
    let should_execute = action_hints.iter().any(|hint| normalized.contains(hint));
    if !should_execute {
        return Ok(Vec::new());
    }

    let matches = match_skill_routes(input, allowed_skills).await?;
    Ok(matches
        .into_iter()
        .filter(|item| item.score >= 0.55)
        .take(2)
        .collect())
}

#[tauri::command]
pub async fn resolve_skill_entry_script(
    skill_path: String,
    entry_script: String,
) -> Result<String, String> {
    resolve_skill_entry_script_path(&skill_path, &entry_script)
}

#[tauri::command]
pub async fn validate_skill_args(
    skill_path: String,
    args: Vec<String>,
) -> Result<SkillArgsValidationResult, String> {
    validate_skill_args_internal(&skill_path, &args)
}

/// Install or replace a skill from uploaded files
#[tauri::command]
pub async fn install_skill(
    skill_name: String,
    files: Vec<UploadedSkillFile>,
) -> Result<SkillMeta, String> {
    let normalized_name = sanitize_skill_name(&skill_name);
    if normalized_name.is_empty() {
        return Err("Invalid skill name".to_string());
    }
    if files.is_empty() {
        return Err("No files uploaded".to_string());
    }

    let skill_dir = get_skills_dir().join(&normalized_name);
    if skill_dir.exists() {
        std::fs::remove_dir_all(&skill_dir)
            .map_err(|e| format!("Failed to replace existing skill: {}", e))?;
    }
    std::fs::create_dir_all(&skill_dir)
        .map_err(|e| format!("Failed to create skill directory: {}", e))?;

    for file in files {
        let rel = sanitize_relative_path(&file.relative_path)?;
        let target = skill_dir.join(rel);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create skill subdirectory: {}", e))?;
        }
        std::fs::write(&target, file.bytes)
            .map_err(|e| format!("Failed to write file {:?}: {}", target, e))?;
    }

    load_skill_meta(&skill_dir)
}

/// Delete an installed skill
#[tauri::command]
pub async fn delete_skill(skill_name: String) -> Result<(), String> {
    let normalized_name = sanitize_skill_name(&skill_name);
    if normalized_name.is_empty() {
        return Err("Invalid skill name".to_string());
    }

    let skill_dir = get_skills_dir().join(normalized_name);
    if !skill_dir.exists() {
        return Err("Skill not found".to_string());
    }

    std::fs::remove_dir_all(&skill_dir)
        .map_err(|e| format!("Failed to delete skill: {}", e))?;
    Ok(())
}

/// Update editable skill metadata fields
#[tauri::command]
pub async fn update_skill_meta(
    skill_name: String,
    description: String,
    triggers: Vec<String>,
) -> Result<SkillMeta, String> {
    let normalized_name = sanitize_skill_name(&skill_name);
    if normalized_name.is_empty() {
        return Err("Invalid skill name".to_string());
    }

    let skill_dir = get_skills_dir().join(&normalized_name);
    if !skill_dir.exists() {
        return Err("Skill not found".to_string());
    }

    let yaml_path = if skill_dir.join("skill.yaml").exists() {
        skill_dir.join("skill.yaml")
    } else {
        skill_dir.join("skill.yml")
    };

    if !yaml_path.exists() {
        return Err("Skill metadata file not found".to_string());
    }

    let content = std::fs::read_to_string(&yaml_path)
        .map_err(|e| format!("Failed to read skill metadata: {}", e))?;
    let mut yaml_value = serde_yaml::from_str::<serde_yaml::Value>(&content)
        .map_err(|e| format!("Failed to parse skill metadata: {}", e))?;

    let cleaned_triggers = triggers
        .into_iter()
        .map(|trigger| trigger.trim().to_string())
        .filter(|trigger| !trigger.is_empty())
        .collect::<Vec<_>>();

    let mapping = yaml_value
        .as_mapping_mut()
        .ok_or("Invalid skill metadata format".to_string())?;
    mapping.insert(
        serde_yaml::Value::String("description".to_string()),
        serde_yaml::Value::String(description.trim().to_string()),
    );
    mapping.insert(
        serde_yaml::Value::String("triggers".to_string()),
        serde_yaml::to_value(&cleaned_triggers)
            .map_err(|e| format!("Failed to encode triggers: {}", e))?,
    );

    let serialized = serde_yaml::to_string(&yaml_value)
        .map_err(|e| format!("Failed to serialize skill metadata: {}", e))?;
    std::fs::write(&yaml_path, serialized)
        .map_err(|e| format!("Failed to write skill metadata: {}", e))?;

    load_skill_meta(&skill_dir)
}

pub fn collect_skills() -> Result<Vec<SkillMeta>, String> {
    let mut skills = Vec::new();
    let mut seen = HashSet::new();
    let user_skills_dir = get_skills_dir();
    ensure_user_script_dirs()?;

    if !user_skills_dir.exists() {
        std::fs::create_dir_all(&user_skills_dir)
            .map_err(|e| format!("Failed to create skills directory: {}", e))?;
    }

    scan_skills_from_dir(&user_skills_dir, &mut skills, &mut seen)?;

    let bundled_skills_dir = get_bundled_skills_dir();
    if bundled_skills_dir.exists() {
        scan_skills_from_dir(&bundled_skills_dir, &mut skills, &mut seen)?;
    }

    Ok(skills)
}

fn load_skill_meta(skill_dir: &PathBuf) -> Result<SkillMeta, String> {
    let yaml_path = if skill_dir.join("skill.yaml").exists() {
        skill_dir.join("skill.yaml")
    } else {
        skill_dir.join("skill.yml")
    };

    if !yaml_path.exists() {
        return Err("Uploaded skill is missing skill.yaml".to_string());
    }

    let content = std::fs::read_to_string(&yaml_path)
        .map_err(|e| format!("Failed to read uploaded skill metadata: {}", e))?;
    let mut skill = serde_yaml::from_str::<SkillMeta>(&content)
        .map_err(|e| format!("Failed to parse uploaded skill metadata: {}", e))?;
    skill.path = skill_dir.to_string_lossy().to_string();
    Ok(skill)
}

fn calculate_skill_match(input: &str, skill: &SkillMeta) -> (f32, String) {
    let normalized_input = input.to_lowercase().trim().to_string();
    let mut best_score = 0.0_f32;
    let mut best_trigger = String::new();

    for trigger in &skill.triggers {
        let score = calculate_match_score(&normalized_input, &trigger.to_lowercase());
        if score > best_score {
            best_score = score;
            best_trigger = trigger.clone();
        }
    }

    let name_score = calculate_match_score(&normalized_input, &skill.name.to_lowercase());
    let desc_score = calculate_match_score(&normalized_input, &skill.description.to_lowercase()) * 0.6;

    if name_score > best_score {
        best_score = name_score;
        best_trigger = skill.name.clone();
    }

    if desc_score > best_score {
        best_score = desc_score;
        best_trigger = skill.description.clone();
    }

    (best_score, best_trigger)
}

fn calculate_match_score(input: &str, trigger: &str) -> f32 {
    if input == trigger {
        return 1.0;
    }
    if input.contains(trigger) || trigger.contains(input) {
        return 0.9;
    }

    let input_tokens = tokenize(input);
    let trigger_tokens = tokenize(trigger);
    if input_tokens.is_empty() || trigger_tokens.is_empty() {
        return 0.0;
    }

    let intersection = input_tokens
        .iter()
        .filter(|token| trigger_tokens.contains(*token))
        .count();
    let union = input_tokens
        .iter()
        .chain(trigger_tokens.iter())
        .cloned()
        .collect::<HashSet<_>>();
    let token_score = intersection as f32 / union.len() as f32;

    let all_trigger_tokens_present = trigger_tokens.iter().all(|token| {
        input_tokens.iter().any(|input_token| input_token.contains(token) || token.contains(input_token))
    });
    if all_trigger_tokens_present && trigger_tokens.len() > 1 {
        return token_score.max(0.8);
    }

    let partial_matches = trigger_tokens
        .iter()
        .filter(|token| {
            input_tokens.iter().any(|input_token| input_token.contains(*token) || token.contains(input_token))
        })
        .count();
    let partial_score = partial_matches as f32 / trigger_tokens.len() as f32;

    (token_score * 0.7).max(partial_score * 0.6)
}

fn tokenize(text: &str) -> Vec<String> {
    let tokens = text
        .split(|ch: char| ch.is_whitespace() || " ,，。！？、：；\"''（）【】-_/\\ ".contains(ch))
        .filter(|token| !token.is_empty())
        .map(|token| token.to_string())
        .collect::<Vec<_>>();

    let mut expanded = Vec::new();
    for token in tokens {
        expanded.push(token.clone());
        let chars = token.chars().collect::<Vec<_>>();
        if chars
            .iter()
            .filter(|ch| **ch >= '\u{4e00}' && **ch <= '\u{9fff}')
            .count()
            > 1
        {
            for window in chars.windows(2) {
                let bigram = window.iter().collect::<String>();
                expanded.push(bigram);
            }
        }
    }

    expanded.into_iter().collect::<HashSet<_>>().into_iter().collect()
}

fn load_skill_meta_from_path(skill_path: &str) -> Result<SkillMeta, String> {
    let dir = PathBuf::from(skill_path);
    load_skill_meta(&dir)
}

fn scan_skills_from_dir(
    skills_dir: &PathBuf,
    skills: &mut Vec<SkillMeta>,
    seen: &mut HashSet<String>,
) -> Result<(), String> {
    let entries = std::fs::read_dir(skills_dir)
        .map_err(|e| format!("Failed to read skills directory {:?}: {}", skills_dir, e))?;

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let yaml_path = if path.join("skill.yaml").exists() {
            path.join("skill.yaml")
        } else if path.join("skill.yml").exists() {
            path.join("skill.yml")
        } else {
            continue;
        };

        match std::fs::read_to_string(&yaml_path) {
            Ok(content) => match serde_yaml::from_str::<SkillMeta>(&content) {
                Ok(mut skill) => {
                    if seen.contains(&skill.name) {
                        continue;
                    }
                    skill.path = path.to_string_lossy().to_string();
                    seen.insert(skill.name.clone());
                    skills.push(skill);
                    log::info!("Loaded skill: {} from {:?}", skills.last().unwrap().name, path);
                }
                Err(e) => {
                    log::warn!("Failed to parse skill.yaml in {:?}: {}", path, e);
                }
            },
            Err(e) => {
                log::warn!("Failed to read skill.yaml in {:?}: {}", path, e);
            }
        }
    }

    Ok(())
}

fn sanitize_skill_name(name: &str) -> String {
    name.trim()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect()
}

fn sanitize_relative_path(path: &str) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(path);
    if candidate.is_absolute() {
        return Err("Absolute paths are not allowed".to_string());
    }

    let mut clean = PathBuf::new();
    for component in candidate.components() {
        match component {
            std::path::Component::Normal(part) => clean.push(part),
            _ => return Err("Invalid relative path".to_string()),
        }
    }

    if clean.as_os_str().is_empty() {
        return Err("Empty file path".to_string());
    }

    Ok(clean)
}

/// Get the default skills directory path
fn get_skills_dir() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".aiops").join("skills")
}

fn get_scripts_dir() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".aiops").join("scripts")
}

fn ensure_user_script_dirs() -> Result<(), String> {
    let scripts_dir = get_scripts_dir();
    for dir in [scripts_dir.join("instant"), scripts_dir.join("managed")] {
        if !dir.exists() {
            std::fs::create_dir_all(&dir)
                .map_err(|e| format!("Failed to create scripts directory {:?}: {}", dir, e))?;
        }
    }
    Ok(())
}

fn get_bundled_skills_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("skills")
}

pub fn resolve_skill_entry_script_path(skill_path: &str, entry_script: &str) -> Result<String, String> {
    if skill_path.trim().is_empty() {
        return Err("Skill path is empty".to_string());
    }
    if entry_script.trim().is_empty() {
        return Err("entry_script is empty".to_string());
    }

    let skill_dir = PathBuf::from(skill_path);
    let entry = PathBuf::from(entry_script);

    if entry.is_absolute() {
        return normalize_existing_path(&entry)
            .ok_or_else(|| format!("Script not found: {}", entry.display()));
    }

    let mut candidates = Vec::new();
    candidates.push(get_scripts_dir().join(&entry));
    candidates.push(skill_dir.join(&entry));

    if let Some(skills_dir) = skill_dir.parent() {
        if let Some(root_dir) = skills_dir.parent() {
            candidates.push(root_dir.join(&entry));
        }
    }

    let bundled_root = get_bundled_skills_dir()
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();
    candidates.push(bundled_root.join(&entry));

    for candidate in candidates {
        if let Some(resolved) = normalize_existing_path(&candidate) {
            return Ok(resolved);
        }
    }

    Err(format!(
        "Script not found for skill {}: {}",
        skill_dir.display(),
        entry.display()
    ))
}

fn normalize_existing_path(path: &Path) -> Option<String> {
    if !path.exists() {
        return None;
    }

    Some(
        std::fs::canonicalize(path)
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .to_string(),
    )
}

pub fn validate_skill_args_internal(
    skill_path: &str,
    args: &[String],
) -> Result<SkillArgsValidationResult, String> {
    let skill = load_skill_meta_from_path(skill_path)?;
    if skill.args_schema.is_empty() {
        return Ok(SkillArgsValidationResult {
            valid: true,
            normalized_args: args.to_vec(),
            errors: Vec::new(),
        });
    }

    let mut normalized_args = Vec::new();
    let mut errors = Vec::new();
    let mut seen_flags = HashSet::new();
    let schema_map = skill
        .args_schema
        .iter()
        .map(|field| (field.flag.clone(), field))
        .collect::<std::collections::HashMap<_, _>>();

    let mut i = 0;
    while i < args.len() {
        let flag = &args[i];
        let Some(field) = schema_map.get(flag) else {
            errors.push(format!("未声明的参数: {}", flag));
            i += 1;
            continue;
        };

        seen_flags.insert(flag.clone());
        normalized_args.push(flag.clone());

        if field.multiple {
            let mut values = Vec::new();
            i += 1;
            while i < args.len() && !args[i].starts_with("--") {
                values.push(args[i].clone());
                i += 1;
            }
            if values.is_empty() {
                errors.push(format!("参数 {} 至少需要一个值", flag));
                continue;
            }
            for value in values {
                validate_arg_value(field, &value, &mut errors);
                normalized_args.push(value);
            }
            continue;
        }

        let value = args.get(i + 1);
        if value.is_none() || value.is_some_and(|item| item.starts_with("--")) {
            errors.push(format!("参数 {} 缺少值", flag));
            i += 1;
            continue;
        }

        let value = value.cloned().unwrap_or_default();
        validate_arg_value(field, &value, &mut errors);
        normalized_args.push(value);
        i += 2;
    }

    for field in &skill.args_schema {
        if field.required && !seen_flags.contains(&field.flag) {
            errors.push(format!("缺少必填参数 {}", field.flag));
        }
    }

    Ok(SkillArgsValidationResult {
        valid: errors.is_empty(),
        normalized_args,
        errors,
    })
}

fn validate_arg_value(
    field: &crate::models::SkillArgSchemaField,
    value: &str,
    errors: &mut Vec<String>,
) {
    match field.arg_type.as_str() {
        "integer" => match value.parse::<i64>() {
            Ok(parsed) => {
                if let Some(min) = field.min {
                    if (parsed as f64) < min {
                        errors.push(format!("参数 {} 不能小于 {}", field.flag, min));
                    }
                }
                if let Some(max) = field.max {
                    if (parsed as f64) > max {
                        errors.push(format!("参数 {} 不能大于 {}", field.flag, max));
                    }
                }
            }
            Err(_) => errors.push(format!("参数 {} 需要整数值", field.flag)),
        },
        "number" => match value.parse::<f64>() {
            Ok(parsed) => {
                if let Some(min) = field.min {
                    if parsed < min {
                        errors.push(format!("参数 {} 不能小于 {}", field.flag, min));
                    }
                }
                if let Some(max) = field.max {
                    if parsed > max {
                        errors.push(format!("参数 {} 不能大于 {}", field.flag, max));
                    }
                }
            }
            Err(_) => errors.push(format!("参数 {} 需要数值", field.flag)),
        },
        _ => {}
    }

    if let Some(pattern) = &field.pattern {
        match Regex::new(pattern) {
            Ok(re) => {
                if !re.is_match(value) {
                    errors.push(format!("参数 {} 不符合格式要求", field.flag));
                }
            }
            Err(_) => {
                errors.push(format!("参数 {} 的 pattern 配置无效", field.flag));
            }
        }
    }
}
