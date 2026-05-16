import React from 'react';
import { Plus, Search, Trash2, MessageSquare, ChevronLeft, FileCode2, BellRing, LayoutDashboard, ServerCog } from 'lucide-react';
import { SYSTEM_ANNOUNCEMENTS_ID, useAppStore, useChatStore } from '../stores';

const Sidebar: React.FC = () => {
  const { sidebarCollapsed, toggleSidebar, activeWorkspace, setActiveWorkspace } = useAppStore();
  const { conversations, activeConversationId, createConversation, deleteConversation, setActiveConversation } = useChatStore();
  const [searchQuery, setSearchQuery] = React.useState('');

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

  const handleGoHome = () => {
    setActiveWorkspace('chat');
    setActiveConversation(null);
  };

  return (
    <div className={`sidebar-shell${sidebarCollapsed ? ' collapsed' : ''}`}>
      <aside className={`sidebar${sidebarCollapsed ? ' collapsed' : ''}`}>
        <div className="sidebar-panel">
          <div className="sidebar-content">
            <div className="sidebar-header">
              <div className="sidebar-header-row">
                <button className="sidebar-brand" onClick={handleGoHome} title="返回主页">
                  <div className="sidebar-brand-mark">
                    <MessageSquare size={14} />
                  </div>
                  <div className="sidebar-brand-copy">
                    <span className="sidebar-brand-title">OpsDog</span>
                    <span className="sidebar-brand-subtitle">运维工作台</span>
                  </div>
                </button>
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
                  className={`workspace-switch-btn${activeWorkspace === 'overview' ? ' active' : ''}`}
                  onClick={() => setActiveWorkspace('overview')}
                >
                  <LayoutDashboard size={13} />
                  <span>总览</span>
                </button>
                <button
                  className={`workspace-switch-btn${activeWorkspace === 'servers' ? ' active' : ''}`}
                  onClick={() => setActiveWorkspace('servers')}
                >
                  <ServerCog size={13} />
                  <span>服务器</span>
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
                          <span className="conv-title">{conv.title}</span>
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
              ) : (
                <>
                  <div className="sidebar-section-label">服务器区</div>
                  <div className="sidebar-module-card">
                    <div className="sidebar-module-title">设备卡片</div>
                    <div className="sidebar-module-desc">集中查看全部设备，点击卡片打开设备详情与编辑界面。</div>
                  </div>
                </>
              )}
            </div>

            <div className="sidebar-footer">
              <div className="sidebar-footer-copy">
                {activeWorkspace === 'chat'
                  ? `${normalConversationCount} 个对话`
                  : activeWorkspace === 'scripts'
                    ? '任务工作台'
                    : activeWorkspace === 'overview'
                      ? '运行态势总览'
                      : '服务器管理'}
              </div>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
};

export default Sidebar;
