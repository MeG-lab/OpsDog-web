mod commands;
mod models;
mod services;

use commands::{audit, chat, config, conversations, mcp, python, skills};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(mcp::MCPState::new())
        .manage(python::ManagedTaskState::default())
        .invoke_handler(tauri::generate_handler![
            // Chat commands
            chat::send_chat_message,
            chat::send_chat_message_stream,
            chat::fetch_available_models,
            chat::route_chat_input,
            chat::build_chat_execution_plan,
            // Python commands
            python::check_python_env,
            python::execute_python_script,
            python::execute_instant_skill,
            python::start_managed_task,
            python::restart_managed_task,
            python::stop_managed_task,
            python::restore_managed_tasks,
            python::list_managed_tasks,
            python::get_managed_task,
            python::get_system_info,
            // Skills commands
            skills::scan_skills,
            skills::load_skill_instructions,
            skills::resolve_skill_entry_script,
            skills::validate_skill_args,
            skills::match_skill_routes,
            skills::resolve_instant_skill_execution,
            skills::install_skill,
            skills::delete_skill,
            skills::update_skill_meta,
            // Config commands
            config::load_config,
            config::save_config,
            config::get_app_data_dir,
            // Conversation storage commands
            conversations::load_conversations,
            conversations::save_conversations,
            conversations::list_conversation_summaries,
            conversations::load_conversation_messages,
            conversations::upsert_conversation,
            conversations::append_conversation_message,
            conversations::update_conversation_message,
            conversations::replace_conversation_messages,
            conversations::delete_conversation_record,
            // Audit commands
            audit::query_audit_events,
            audit::get_audit_overview,
            audit::get_audit_replay,
            // MCP commands
            mcp::connect_mcp_server,
            mcp::disconnect_mcp_server,
            mcp::list_mcp_tools,
            mcp::call_mcp_tool,
            mcp::get_mcp_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
