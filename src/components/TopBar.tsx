import React from 'react';
import { ChevronRight, Settings, Wrench, Sun, Moon, X, Trash2 } from 'lucide-react';
import { SYSTEM_ANNOUNCEMENTS_ID, useAppStore, useChatStore } from '../stores';
import { listManagedTasks } from '../services/runtime';
import SettingsPanel from './panels/SettingsPanel';
import ToolsPanel from './panels/ToolsPanel';

const TopBar: React.FC = () => {
  const { sidebarCollapsed, toggleSidebar, theme, toggleTheme, activePanel, setActivePanel, activeWorkspace, backendOnline, backendStatusMessage } = useAppStore();
  const conv = useChatStore(s => s.conversations.find(c => c.id === s.activeConversationId));
  const clearSystemAnnouncements = useChatStore(s => s.clearSystemAnnouncements);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const [managedSummary, setManagedSummary] = React.useState({
    activeCount: 0,
    healthyCount: 0,
    alertCount: 0,
  });

  React.useEffect(() => {
    const refreshSummary = async () => {
      try {
        const tasks = await listManagedTasks();
        setManagedSummary({
          activeCount: tasks.filter(task => ['starting', 'running', 'attention', 'warning', 'recovered', 'stopping'].includes(task.status)).length,
          healthyCount: tasks.filter(task => task.status === 'running' || task.status === 'recovered').length,
          alertCount: tasks.filter(task => task.status === 'warning' || task.status === 'attention' || task.status === 'error').length,
        });
      } catch (error) {
        console.error('list managed tasks for topbar summary error:', error);
      }
    };

    void refreshSummary();
    const timer = window.setInterval(() => {
      void refreshSummary();
    }, 3000);

    return () => window.clearInterval(timer);
  }, []);

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
            ? (conv?.title || 'AIops智能运维中枢')
            : activeWorkspace === 'scripts'
              ? '任务工作台'
              : '运行总览'}
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

        <button className="toolbar-icon-btn theme-toggle-btn" onClick={toggleTheme} title="切换主题">
          <span className={`theme-toggle-track ${theme}`}>
            <Sun size={15} className="theme-icon sun" />
            <Moon size={15} className="theme-icon moon" />
          </span>
        </button>

        <button className={`toolbar-icon-btn${activePanel === 'settings' ? ' active' : ''}`}
          onClick={() => setActivePanel('settings')} title="设置">
          <Settings size={16} />
        </button>

        <button className={`toolbar-icon-btn${activePanel === 'tools' ? ' active' : ''}`}
          onClick={() => setActivePanel('tools')} title="工具集成">
          <Wrench size={16} />
        </button>

        {activePanel === 'settings' && (
          <div className="popover-panel">
            <div className="popover-header">
              <h2>设置</h2>
              <button className="btn-icon" onClick={() => setActivePanel(null)}><X size={14} /></button>
            </div>
            <div className="popover-body"><SettingsPanel /></div>
          </div>
        )}
        {activePanel === 'tools' && (
          <div className="popover-panel">
            <div className="popover-header">
              <h2>工具集成</h2>
              <button className="btn-icon" onClick={() => setActivePanel(null)}><X size={14} /></button>
            </div>
            <div className="popover-body"><ToolsPanel /></div>
          </div>
        )}
      </div>
    </div>
  );
};

export default TopBar;
