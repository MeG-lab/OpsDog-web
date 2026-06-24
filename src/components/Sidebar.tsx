import React from 'react';
import {
  Archive,
  BookOpen,
  Calculator,
  FileClock,
  Grid2X2,
  LayoutDashboard,
  MessageSquare,
  Plus,
  ScanSearch,
  Search,
  ServerCog,
  Shield,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Trash2,
  ChevronLeft,
  FileCode2,
  BellRing,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import { SYSTEM_ANNOUNCEMENTS_ID, useAppStore, useChatStore } from '../stores';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const calendarDayValue = (timestamp: number) => {
  const date = new Date(timestamp);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
};

const formatConversationCreatedAge = (createdAt: number, now: number) => {
  if (!Number.isFinite(createdAt)) return '';
  const dayAge = Math.max(0, Math.round((calendarDayValue(now) - calendarDayValue(createdAt)) / DAY_MS));
  if (dayAge > 0) return `${dayAge}天前`;

  const elapsedMinutes = Math.max(0, Math.floor((now - createdAt) / MINUTE_MS));
  if (elapsedMinutes < 1) return '刚刚';

  const hours = Math.floor(elapsedMinutes / 60);
  const minutes = elapsedMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}小时${minutes}分钟前`;
  if (hours > 0) return `${hours}小时前`;
  return `${minutes}分钟前`;
};

const formatTimestampTitle = (timestamp: number) => {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { hour12: false });
};

const MORE_FEATURES: Array<{
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
}> = [
  { label: '掩码计算器', icon: Calculator },
  { label: '智能巡检', icon: Sparkles, disabled: true },
  { label: '配置备份', icon: Archive, disabled: true },
  { label: '安全审查', icon: ShieldCheck, disabled: true },
  { label: '漏洞扫描', icon: ScanSearch, disabled: true },
  { label: '知识库', icon: BookOpen, disabled: true },
  { label: '日志管理', icon: FileClock, disabled: true },
];

const Sidebar: React.FC = () => {
  const { sidebarCollapsed, toggleSidebar, activeWorkspace, setActiveWorkspace, setActiveSettingsSection } = useAppStore();
  const { conversations, activeConversationId, createConversation, deleteConversation, setActiveConversation } = useChatStore();
  const [searchQuery, setSearchQuery] = React.useState('');
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => window.clearInterval(timer);
  }, []);

  const filtered = conversations.filter(c =>
    c.title.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const sortedConversations = [...filtered].sort((a, b) => {
    if (a.id === SYSTEM_ANNOUNCEMENTS_ID) return -1;
    if (b.id === SYSTEM_ANNOUNCEMENTS_ID) return 1;
    return b.updatedAt - a.updatedAt;
  });
  const normalConversationCount = conversations.filter(conv => conv.kind !== 'system').length;

  const handleNew = () => {
    setActiveWorkspace('chat');
    createConversation();
  };
  const openSystemSettings = () => {
    setActiveSettingsSection('account');
    setActiveWorkspace('settings');
  };

  return (
    <div className={`sidebar-shell${sidebarCollapsed ? ' collapsed' : ''}`}>
      <aside className={`sidebar${sidebarCollapsed ? ' collapsed' : ''}`}>
        <div className="sidebar-panel">
          <div className="sidebar-content">
            <div className="sidebar-header">
              <div className="sidebar-header-row">
                <div className="sidebar-brand" aria-label="OpsDog">
                  <div className="sidebar-brand-mark">
                    <Shield size={19} className="sidebar-brand-shield" />
                    <SquareTerminal size={10} className="sidebar-brand-terminal" />
                  </div>
                  <div className="sidebar-brand-copy">
                    <span className="sidebar-brand-title">OpsDog</span>
                    <span className="sidebar-brand-subtitle">运维工作台</span>
                  </div>
                </div>
                <button className="btn-icon" onClick={handleNew} title="新对话">
                  <Plus size={16} />
                </button>
                <button className="btn-icon" onClick={toggleSidebar} title="折叠侧边栏">
                  <ChevronLeft size={16} />
                </button>
              </div>
            </div>

            <div className="sidebar-search">
              <div className="workspace-switch">
                <button
                  className={`workspace-switch-btn${activeWorkspace === 'chat' ? ' active' : ''}`}
                  onClick={() => setActiveWorkspace('chat')}
                >
                  <MessageSquare size={13} />
                  <span>对话</span>
                </button>
                <button
                  className={`workspace-switch-btn${activeWorkspace === 'scripts' ? ' active' : ''}`}
                  onClick={() => setActiveWorkspace('scripts')}
                >
                  <FileCode2 size={13} />
                  <span>任务</span>
                </button>
                <button
                  className={`workspace-switch-btn${activeWorkspace === 'servers' ? ' active' : ''}`}
                  onClick={() => setActiveWorkspace('servers')}
                >
                  <ServerCog size={13} />
                  <span>设备</span>
                </button>
                <button
                  className={`workspace-switch-btn${activeWorkspace === 'overview' ? ' active' : ''}`}
                  onClick={() => setActiveWorkspace('overview')}
                >
                  <LayoutDashboard size={13} />
                  <span>总览</span>
                </button>
                <button
                  className={`workspace-switch-btn workspace-switch-btn-wide${activeWorkspace === 'more' ? ' active' : ''}`}
                  onClick={() => setActiveWorkspace('more')}
                >
                  <Grid2X2 size={13} />
                  <span>更多功能</span>
                </button>
              </div>
            </div>

            <div className="sidebar-list">
              {activeWorkspace === 'chat' ? (
                <>
                  <div className="sidebar-section-label">对话历史</div>
                  <div className="sidebar-search-box">
                    <Search size={13} className="sidebar-search-icon" />
                    <input
                      className="input"
                      placeholder="搜索对话..."
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                    />
                  </div>
                  {sortedConversations.length === 0 && (
                    <div className="sidebar-empty">
                      {searchQuery ? '没有匹配的对话' : '暂无对话'}
                    </div>
                  )}
                  {sortedConversations.map(conv => (
                    (() => {
                      const unreadCount = conv.kind === 'system'
                        ? conv.messages.filter(message => message.timestamp > (conv.lastReadAt ?? 0)).length
                        : 0;

                      return (
                        <div
                          key={conv.id}
                          className={`conv-item${conv.id === activeConversationId ? ' active' : ''}${conv.kind === 'system' ? ' system' : ''}`}
                          onClick={() => setActiveConversation(conv.id)}
                        >
                          {conv.kind === 'system'
                            ? <BellRing size={13} className="conv-icon" />
                            : <MessageSquare size={13} className="conv-icon" />}
                          <span className="conv-copy">
                            <span className="conv-title">{conv.title}</span>
                            {conv.kind !== 'system' ? (
                              <time
                                className="conv-time"
                                dateTime={new Date(conv.createdAt).toISOString()}
                                title={`创建于 ${formatTimestampTitle(conv.createdAt)}`}
                              >
                                {formatConversationCreatedAge(conv.createdAt, now)}
                              </time>
                            ) : null}
                          </span>
                          {conv.kind === 'system' && unreadCount > 0 && (
                            <span className="conv-unread-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
                          )}
                          {conv.kind !== 'system' && (
                            <div className="conv-actions">
                              <button
                                className="btn-icon"
                                onClick={e => { e.stopPropagation(); deleteConversation(conv.id); }}
                                title="删除"
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })()
                  ))}
                </>
              ) : activeWorkspace === 'scripts' ? (
                <>
                  <div className="sidebar-section-label">任务视图</div>
                  <div className="sidebar-module-card">
                    <div className="sidebar-module-title">即时任务</div>
                    <div className="sidebar-module-desc">巡检、日志分析、诊断、生成报告</div>
                  </div>
                  <div className="sidebar-module-card">
                    <div className="sidebar-module-title">托管任务</div>
                    <div className="sidebar-module-desc">监控、守护、轮询、长期采集与告警</div>
                  </div>
                </>
              ) : activeWorkspace === 'overview' ? (
                <>
                  <div className="sidebar-section-label">总览视图</div>
                  <div className="sidebar-module-card">
                    <div className="sidebar-module-title">运行态势</div>
                    <div className="sidebar-module-desc">聚合查看当前托管任务的运行、告警、恢复与异常退出情况。</div>
                  </div>
                  <div className="sidebar-module-card">
                    <div className="sidebar-module-title">最近事件</div>
                    <div className="sidebar-module-desc">快速扫描最近发生的告警、恢复、启动与停止事件。</div>
                  </div>
                </>
              ) : activeWorkspace === 'settings' ? (
                <>
                  <div className="sidebar-section-label">系统设置</div>
                  <div className="sidebar-module-card">
                    <div className="sidebar-module-title">全局配置</div>
                    <div className="sidebar-module-desc">账号安全、模型、通知、外观和工具调用策略集中管理。</div>
                  </div>
                  <div className="sidebar-module-card">
                    <div className="sidebar-module-title">本地数据</div>
                    <div className="sidebar-module-desc">清理普通对话历史，同时保留系统通告。</div>
                  </div>
                </>
              ) : activeWorkspace === 'more' ? (
                <>
                  <div className="sidebar-section-label">更多功能</div>
                  <div className="sidebar-feature-list">
                    {MORE_FEATURES.map((feature) => {
                      const Icon = feature.icon;
                      return (
                        <button
                          key={feature.label}
                          type="button"
                          className={`sidebar-feature-card${feature.disabled ? ' disabled' : ' active'}`}
                          onClick={feature.disabled ? undefined : () => setActiveWorkspace('more')}
                          disabled={feature.disabled}
                          aria-disabled={feature.disabled ? true : undefined}
                          title={feature.disabled ? `${feature.label}（敬请期待）` : feature.label}
                        >
                          <Icon size={15} />
                          <span>{feature.label}</span>
                          {feature.disabled ? <small>敬请期待</small> : null}
                        </button>
                      );
                    })}
                  </div>
                </>
              ) : (
                <>
                  <div className="sidebar-section-label">设备区</div>
                  <div className="sidebar-module-card">
                    <div className="sidebar-module-title">设备卡片</div>
                    <div className="sidebar-module-desc">集中查看全部设备，点击卡片打开设备详情与编辑界面。</div>
                  </div>
                </>
              )}
            </div>

            <div className="sidebar-footer">
              <button
                type="button"
                className={`sidebar-settings-btn${activeWorkspace === 'settings' ? ' active' : ''}`}
                onClick={openSystemSettings}
                title="系统设置"
              >
                <Settings size={14} />
                <span>系统设置</span>
              </button>
              <div className="sidebar-footer-copy">
                {activeWorkspace === 'chat'
                  ? `${normalConversationCount} 个对话`
                  : activeWorkspace === 'scripts'
                    ? '任务工作台'
                    : activeWorkspace === 'overview'
                      ? '运行态势总览'
                      : activeWorkspace === 'settings'
                        ? '全局配置'
                        : activeWorkspace === 'more'
                          ? '更多功能'
                          : '设备管理'}
              </div>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
};

export default Sidebar;
