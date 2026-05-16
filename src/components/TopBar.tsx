import React from 'react';
import { ChevronRight, FileText, Settings, Wrench, Sun, Moon, X, Trash2, UserRound } from 'lucide-react';
import { SYSTEM_ANNOUNCEMENTS_ID, useAppStore, useChatStore } from '../stores';
import { summarizeManagedServers } from '../services/serverSummaries';
import SettingsPanel from './panels/SettingsPanel';
import ToolsPanel from './panels/ToolsPanel';
import ReportsPanel from './panels/ReportsPanel';
import ProfilePanel from './panels/ProfilePanel';

const TopBar: React.FC = () => {
  const { sidebarCollapsed, toggleSidebar, theme, toggleTheme, activePanel, setActivePanel, activeWorkspace, backendOnline, backendStatusMessage, operatorProfile } = useAppStore();
  const servers = useAppStore(s => s.servers);
  const conv = useChatStore(s => s.conversations.find(c => c.id === s.activeConversationId));
  const clearSystemAnnouncements = useChatStore(s => s.clearSystemAnnouncements);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const managedSummary = React.useMemo(() => summarizeManagedServers(servers), [servers]);

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

        <button type="button" className={`toolbar-icon-btn${activePanel === 'settings' ? ' active' : ''}`}
          onClick={() => setActivePanel('settings')} title="设置">
          <Settings size={16} />
        </button>

        <button type="button" className={`toolbar-icon-btn${activePanel === 'tools' ? ' active' : ''}`}
          onClick={() => setActivePanel('tools')} title="工具集成">
          <Wrench size={16} />
        </button>

        <button type="button" className={`toolbar-icon-btn${activePanel === 'reports' ? ' active' : ''}`}
          onClick={() => setActivePanel('reports')} title="报告">
          <FileText size={16} />
        </button>

        <button
          type="button"
          className={`toolbar-icon-btn${activePanel === 'profile' ? ' active' : ''}`}
          onClick={() => setActivePanel('profile')}
          title={operatorProfile.name ? `${operatorProfile.name} · ${operatorProfile.team}` : '运维资料'}
        >
          <UserRound size={16} />
        </button>

        {activePanel === 'profile' && (
          <div className="popover-panel profile-popover-panel" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
            <div className="popover-header">
              <h2>运维资料</h2>
              <button type="button" className="btn-icon" onClick={() => setActivePanel(null)}><X size={14} /></button>
            </div>
            <div className="popover-body"><ProfilePanel /></div>
          </div>
        )}
        {activePanel === 'settings' && (
          <div className="popover-panel" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
            <div className="popover-header">
              <h2>设置</h2>
              <button type="button" className="btn-icon" onClick={() => setActivePanel(null)}><X size={14} /></button>
            </div>
            <div className="popover-body"><SettingsPanel /></div>
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
