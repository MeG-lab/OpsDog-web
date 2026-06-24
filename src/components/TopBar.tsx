import React from 'react';
import { ChevronRight, FileText, LogOut, Settings, Wrench, Sun, Moon, X, Trash2, UserRound } from 'lucide-react';
import { SYSTEM_ANNOUNCEMENTS_ID, useAppStore, useChatStore } from '../stores';
import { summarizeManagedServers } from '../services/serverSummaries';
import ToolsPanel from './panels/ToolsPanel';
import ReportsPanel from './panels/ReportsPanel';
import type { SettingsSection } from '../stores';
import type { AuthUser } from '../services/runtime';

type TopBarProps = {
  authUser?: AuthUser;
  onLogout?: () => void | Promise<void>;
};

const TopBar: React.FC<TopBarProps> = ({ authUser, onLogout }) => {
  const {
    sidebarCollapsed,
    toggleSidebar,
    theme,
    toggleTheme,
    activePanel,
    setActivePanel,
    activeWorkspace,
    setActiveWorkspace,
    activeSettingsSection,
    setActiveSettingsSection,
    backendOnline,
    backendStatusMessage,
    operatorProfile,
  } = useAppStore();
  const servers = useAppStore(s => s.servers);
  const conv = useChatStore(s => s.conversations.find(c => c.id === s.activeConversationId));
  const clearSystemAnnouncements = useChatStore(s => s.clearSystemAnnouncements);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const managedSummary = React.useMemo(() => summarizeManagedServers(servers), [servers]);
  const openSettingsSection = (section: SettingsSection) => {
    setActiveSettingsSection(section);
    setActiveWorkspace('settings');
    setActivePanel(null);
  };

  return (
    <div className="topbar">
      {sidebarCollapsed && (
        <button className="btn-icon topbar-sidebar-toggle" onClick={toggleSidebar} title="展开侧边栏">
          <ChevronRight size={16} />
        </button>
      )}

      <div className="topbar-title-group">
        <div className="topbar-title-label">Workspace</div>
        <span className="topbar-title">
          {activeWorkspace === 'chat'
            ? (conv?.title || 'OpsDog')
            : activeWorkspace === 'scripts'
              ? '任务工作台'
              : activeWorkspace === 'overview'
                ? '运行总览'
                : activeWorkspace === 'settings'
                  ? '系统设置'
                  : activeWorkspace === 'more'
                    ? '更多功能'
                    : '服务器管理'}
        </span>
      </div>

      <div className="topbar-right" ref={panelRef}>
        <div className={`topbar-managed-pill${backendOnline ? ' healthy' : ' alert active'}`} title={backendStatusMessage}>
          <strong>{backendOnline ? '后端在线' : '后端离线'}</strong>
          <em>{backendOnline ? 'API' : '请启动服务'}</em>
        </div>
        <div className="topbar-managed-summary" title="托管任务运行摘要">
          <span className="topbar-managed-summary-label">托管任务</span>
          <span className="topbar-managed-pill">
            <strong>{managedSummary.activeCount}</strong>
            <em>运行中</em>
          </span>
          <span className="topbar-managed-pill healthy">
            <strong>{managedSummary.healthyCount}</strong>
            <em>正常</em>
          </span>
          <span className={`topbar-managed-pill alert${managedSummary.alertCount > 0 ? ' active' : ''}`}>
            <strong>{managedSummary.alertCount}</strong>
            <em>异常</em>
          </span>
        </div>

        {activeWorkspace === 'chat' && conv?.id === SYSTEM_ANNOUNCEMENTS_ID && (conv.messages?.length ?? 0) > 0 && (
          <button
            className="toolbar-text-btn"
            onClick={clearSystemAnnouncements}
            title="清空系统通知"
          >
            <Trash2 size={14} />
            <span>清空通告</span>
          </button>
        )}

        <button type="button" className="toolbar-icon-btn theme-toggle-btn" onClick={toggleTheme} title="切换主题">
          <span className={`theme-toggle-track ${theme}`}>
            <Sun size={15} className="theme-icon sun" />
            <Moon size={15} className="theme-icon moon" />
          </span>
        </button>

        <button type="button" className={`toolbar-icon-btn${activeWorkspace === 'settings' && activeSettingsSection === 'ai-model' ? ' active' : ''}`}
          onClick={() => openSettingsSection('ai-model')} title="AI 模型设置">
          <Settings size={16} />
        </button>

        <button type="button" className={`toolbar-icon-btn${activeWorkspace === 'settings' && activeSettingsSection === 'tools' ? ' active' : ''}`}
          onClick={() => openSettingsSection('tools')} title="工具与权限">
          <Wrench size={16} />
        </button>

        <button type="button" className={`toolbar-icon-btn${activePanel === 'reports' ? ' active' : ''}`}
          onClick={() => setActivePanel('reports')} title="报告">
          <FileText size={16} />
        </button>

        <button
          type="button"
          className={`toolbar-icon-btn${activeWorkspace === 'settings' && activeSettingsSection === 'profile' ? ' active' : ''}`}
          onClick={() => openSettingsSection('profile')}
          title={authUser?.username || (operatorProfile.name ? `${operatorProfile.name} · ${operatorProfile.team}` : '运维资料')}
        >
          <UserRound size={16} />
        </button>

        {onLogout && (
          <button type="button" className="toolbar-icon-btn" onClick={() => void onLogout()} title="退出登录">
            <LogOut size={16} />
          </button>
        )}

        {activePanel === 'profile' && (
          <div className="popover-panel profile-popover-panel" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
            <div className="popover-header">
              <h2>个人资料</h2>
              <button type="button" className="btn-icon" onClick={() => setActivePanel(null)}><X size={14} /></button>
            </div>
            <div className="popover-body">
              <div className="profile-readonly-card">
                <div className="profile-readonly-avatar">
                  <UserRound size={32} />
                </div>
                <div className="profile-readonly-name">
                  {operatorProfile.name || '未设置姓名'}
                </div>
                <div className="profile-readonly-team">
                  {operatorProfile.team || '未设置团队'}
                </div>

                <div className="profile-readonly-fields">
                  <div className="profile-readonly-field">
                    <span className="profile-readonly-label">单位</span>
                    <span className="profile-readonly-value">{operatorProfile.organization || '未填写'}</span>
                  </div>
                  <div className="profile-readonly-field">
                    <span className="profile-readonly-label">电话</span>
                    <span className="profile-readonly-value">{operatorProfile.phone || '未填写'}</span>
                  </div>
                  <div className="profile-readonly-field">
                    <span className="profile-readonly-label">邮箱</span>
                    <span className="profile-readonly-value">{operatorProfile.email || '未填写'}</span>
                  </div>
                  <div className="profile-readonly-field">
                    <span className="profile-readonly-label">语音通知</span>
                    <span className={`badge ${operatorProfile.voiceServiceEnabled ? 'badge-accent' : 'badge-muted'}`}>
                      {operatorProfile.voiceServiceEnabled ? '已启用' : '未启用'}
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  className="btn btn-primary profile-readonly-edit-btn"
                  onClick={() => openSettingsSection('profile')}
                >
                  修改信息
                </button>
              </div>
            </div>
          </div>
        )}

        {activePanel === 'tools' && (
          <div className="popover-panel tools-popover-panel" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
            <div className="popover-header">
              <h2>工具集成</h2>
              <button type="button" className="btn-icon" onClick={() => setActivePanel(null)}><X size={14} /></button>
            </div>
            <div className="popover-body"><ToolsPanel /></div>
          </div>
        )}
        {activePanel === 'reports' && (
          <div className="popover-panel reports-popover-panel" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
            <div className="popover-header">
              <h2>报告</h2>
              <button type="button" className="btn-icon" onClick={() => setActivePanel(null)}><X size={14} /></button>
            </div>
            <div className="popover-body"><ReportsPanel /></div>
          </div>
        )}
      </div>
    </div>
  );
};

export default TopBar;
