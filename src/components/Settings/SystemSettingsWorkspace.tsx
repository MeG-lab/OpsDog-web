import React from 'react';
import {
  Bell,
  Bot,
  Check,
  Database,
  ExternalLink,
  KeyRound,
  Palette,
  ShieldCheck,
  Trash2,
  UserRound,
  Wrench,
} from 'lucide-react';
import { changePassword, createUser, listMCPServers, listUsers, resetUserPassword, updateUser } from '../../services/runtime';
import { SYSTEM_ANNOUNCEMENTS_ID, type SettingsSection, useAppStore, useChatStore, useToastStore } from '../../stores';
import type { UserAccount } from '../../services/runtime';
import type { ChatMcpMode, MCPServerRecord } from '../../types';
import ProfilePanel from '../panels/ProfilePanel';
import SettingsPanel from '../panels/SettingsPanel';

const SETTINGS_SECTIONS: Array<{
  id: SettingsSection;
  label: string;
  description: string;
  icon: React.ComponentType<{ size?: number }>;
}> = [
  { id: 'account', label: '账号安全', description: '登录密码', icon: KeyRound },
  { id: 'profile', label: '个人资料', description: '身份与联系方式', icon: UserRound },
  { id: 'ai-model', label: 'AI 模型', description: '模型供应商', icon: Bot },
  { id: 'notification', label: '通知', description: '语音告警', icon: Bell },
  { id: 'appearance', label: '外观', description: '主题与背景', icon: Palette },
  { id: 'tools', label: '工具与权限', description: 'MCP 调用策略', icon: Wrench },
  { id: 'data', label: '数据管理', description: '本地会话', icon: Database },
];

const MCP_MODE_LABELS: Record<ChatMcpMode, string> = {
  disabled: '禁用',
  manual: '手动',
  auto: '自动',
};

const MCP_MODE_DESCRIPTIONS: Record<ChatMcpMode, string> = {
  disabled: '对话不调用 MCP 工具。',
  manual: '只允许调用指定 MCP 服务器。',
  auto: '允许系统按意图自动选择 MCP 工具。',
};

const SectionHeader: React.FC<{ title: string; description: string }> = ({ title, description }) => (
  <div className="system-settings-section-head">
    <span>System Settings</span>
    <h2>{title}</h2>
    <p>{description}</p>
  </div>
);

const AccountSecuritySection: React.FC = () => {
  const showToast = useToastStore((state) => state.showToast);
  const [currentPassword, setCurrentPassword] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [error, setError] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [users, setUsers] = React.useState<UserAccount[]>([]);
  const [usersLoading, setUsersLoading] = React.useState(true);
  const [newUsername, setNewUsername] = React.useState('');
  const [newUserPassword, setNewUserPassword] = React.useState('');
  const [resetPasswords, setResetPasswords] = React.useState<Record<string, string>>({});

  const reloadUsers = React.useCallback(async () => {
    setUsersLoading(true);
    try {
      setUsers(await listUsers());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setUsersLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void reloadUsers();
  }, [reloadUsers]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setStatus('');
    setError('');

    if (!currentPassword || !newPassword || !confirmPassword) {
      setError('请填写当前密码、新密码和确认密码。');
      return;
    }
    if (newPassword.length < 8) {
      setError('新密码至少需要 8 位。');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致。');
      return;
    }

    setSaving(true);
    try {
      await changePassword({ currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setStatus('密码已更新。刷新页面后请使用新密码重新认证。');
      showToast('密码已更新', 'success');
    } catch (changeError) {
      setError(changeError instanceof Error ? changeError.message : String(changeError));
    } finally {
      setSaving(false);
    }
  };

  const handleCreateUser = async () => {
    setStatus('');
    setError('');
    if (!newUsername.trim() || !newUserPassword) {
      setError('请输入新增账号的用户名和密码。');
      return;
    }
    if (newUserPassword.length < 8) {
      setError('新增账号密码至少需要 8 位。');
      return;
    }
    try {
      await createUser({ username: newUsername.trim(), password: newUserPassword });
      setNewUsername('');
      setNewUserPassword('');
      setStatus('账号已新增。');
      showToast('账号已新增', 'success');
      await reloadUsers();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    }
  };

  const handleToggleUser = async (user: UserAccount) => {
    setStatus('');
    setError('');
    try {
      await updateUser(user.id, { enabled: !user.enabled });
      setStatus(user.enabled ? '账号已停用。' : '账号已启用。');
      await reloadUsers();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : String(updateError));
    }
  };

  const handleResetPassword = async (user: UserAccount) => {
    setStatus('');
    setError('');
    const nextPassword = resetPasswords[user.id] || '';
    if (nextPassword.length < 8) {
      setError('重置密码至少需要 8 位。');
      return;
    }
    try {
      await resetUserPassword(user.id, { newPassword: nextPassword });
      setResetPasswords((current) => ({ ...current, [user.id]: '' }));
      setStatus(`已重置 ${user.username} 的密码。`);
      showToast('密码已重置', 'success');
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : String(resetError));
    }
  };

  return (
    <div className="system-settings-stack">
      <form className="system-settings-form" onSubmit={handleSubmit}>
        <label className="profile-panel-field">
          <span>当前密码</span>
          <input
            className="input"
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            autoComplete="current-password"
          />
        </label>
        <div className="profile-panel-grid">
          <label className="profile-panel-field">
            <span>新密码</span>
            <input
              className="input"
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              autoComplete="new-password"
            />
          </label>
          <label className="profile-panel-field">
            <span>确认新密码</span>
            <input
              className="input"
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
            />
          </label>
        </div>
        <div className="system-settings-actions">
          <button type="submit" className="btn btn-primary" disabled={saving}>
            <ShieldCheck size={14} />
            <span>{saving ? '保存中...' : '修改密码'}</span>
          </button>
        </div>
      </form>

      <div className="system-settings-account-card">
        <div className="system-settings-account-head">
          <div>
            <strong>基础账号管理</strong>
            <span>至少保留一个启用账号；所有启用账号权限相同。</span>
          </div>
        </div>

        <div className="system-settings-account-create">
          <label className="profile-panel-field">
            <span>新增账号</span>
            <input
              className="input"
              value={newUsername}
              onChange={(event) => setNewUsername(event.target.value)}
              placeholder="用户名"
            />
          </label>
          <label className="profile-panel-field">
            <span>初始密码</span>
            <input
              className="input"
              type="password"
              value={newUserPassword}
              onChange={(event) => setNewUserPassword(event.target.value)}
              placeholder="至少 8 位"
            />
          </label>
          <button type="button" className="btn btn-primary" onClick={handleCreateUser}>
            新增账号
          </button>
        </div>

        <div className="system-settings-user-list">
          {usersLoading
            ? <div className="system-settings-user-empty">正在加载账号...</div>
            : users.map((user) => (
              <div className="system-settings-user-row" key={user.id}>
                <div className="system-settings-user-main">
                  <strong>{user.username}</strong>
                  <span>{user.enabled ? '已启用' : '已停用'}</span>
                </div>
                <input
                  className="input"
                  type="password"
                  value={resetPasswords[user.id] || ''}
                  onChange={(event) => setResetPasswords((current) => ({ ...current, [user.id]: event.target.value }))}
                  placeholder="重置密码"
                />
                <button type="button" className="btn btn-ghost" onClick={() => handleResetPassword(user)}>
                  重置密码
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => handleToggleUser(user)}>
                  {user.enabled ? '停用' : '启用'}
                </button>
              </div>
            ))}
        </div>
      </div>

      {error && <div className="system-settings-error">{error}</div>}
      {status && <div className="system-settings-success">{status}</div>}
    </div>
  );
};

const AppearanceSettingsSection: React.FC = () => {
  const theme = useAppStore((state) => state.theme);
  const toggleTheme = useAppStore((state) => state.toggleTheme);

  const setTheme = (nextTheme: 'light' | 'dark') => {
    if (theme !== nextTheme) toggleTheme();
  };

  return (
    <div className="system-settings-stack">
      <div className="settings-item system-settings-theme-row">
        <span className="settings-item-label">主题</span>
        <div className="system-settings-segmented">
          {(['light', 'dark'] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={`system-settings-segment${theme === item ? ' active' : ''}`}
              onClick={() => setTheme(item)}
            >
              <span>{item === 'light' ? '浅色' : '深色'}</span>
              {theme === item && <Check size={13} />}
            </button>
          ))}
        </div>
      </div>
      <SettingsPanel mode="appearance" />
    </div>
  );
};

const ToolsPermissionSection: React.FC = () => {
  const chatMcpMode = useAppStore((state) => state.chatMcpMode);
  const selectedManualMcpServer = useAppStore((state) => state.selectedManualMcpServer);
  const setChatMcpMode = useAppStore((state) => state.setChatMcpMode);
  const setSelectedManualMcpServer = useAppStore((state) => state.setSelectedManualMcpServer);
  const setActivePanel = useAppStore((state) => state.setActivePanel);
  const setToolsPanelTab = useAppStore((state) => state.setToolsPanelTab);
  const [mcpServers, setMcpServers] = React.useState<MCPServerRecord[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void listMCPServers()
      .then((servers) => {
        if (cancelled) return;
        const available = servers.filter((server) => (
          server.connected &&
          server.capabilityEnabled !== false &&
          server.name !== 'filesystem'
        ));
        setMcpServers(available);
        if (selectedManualMcpServer && !available.some((server) => server.name === selectedManualMcpServer)) {
          setSelectedManualMcpServer(null);
        }
      })
      .catch(() => {
        if (!cancelled) setMcpServers([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedManualMcpServer, setSelectedManualMcpServer]);

  const openToolsPanel = () => {
    setToolsPanelTab('mcp');
    setActivePanel('tools');
  };

  return (
    <div className="system-settings-stack">
      <div className="system-settings-mode-grid">
        {(['disabled', 'manual', 'auto'] as ChatMcpMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            className={`system-settings-mode-card${chatMcpMode === mode ? ' active' : ''}`}
            onClick={() => setChatMcpMode(mode)}
          >
            <span className="system-settings-mode-title">
              {MCP_MODE_LABELS[mode]}
              {chatMcpMode === mode && <Check size={13} />}
            </span>
            <span>{MCP_MODE_DESCRIPTIONS[mode]}</span>
          </button>
        ))}
      </div>

      <label className="profile-panel-field">
        <span>手动 MCP 服务器</span>
        <select
          className="input"
          value={selectedManualMcpServer || ''}
          onChange={(event) => setSelectedManualMcpServer(event.target.value || null)}
          disabled={chatMcpMode !== 'manual' || loading || mcpServers.length === 0}
        >
          <option value="">{loading ? '正在加载 MCP 服务器' : '未选择'}</option>
          {mcpServers.map((server) => (
            <option key={server.name} value={server.name}>{server.name}</option>
          ))}
        </select>
      </label>

      <div className="system-settings-actions">
        <button type="button" className="btn btn-ghost" onClick={openToolsPanel}>
          <ExternalLink size={14} />
          <span>打开工具集成</span>
        </button>
      </div>
    </div>
  );
};

const DataManagementSection: React.FC = () => {
  const conversations = useChatStore((state) => state.conversations);
  const deleteConversation = useChatStore((state) => state.deleteConversation);
  const createConversation = useChatStore((state) => state.createConversation);
  const showToast = useToastStore((state) => state.showToast);
  const normalConversationCount = conversations.filter((conversation) => conversation.id !== SYSTEM_ANNOUNCEMENTS_ID && conversation.kind !== 'system').length;

  const clearNormalConversations = () => {
    if (normalConversationCount === 0) return;
    const confirmed = window.confirm(`确认清空 ${normalConversationCount} 个普通对话？系统通告会保留。`);
    if (!confirmed) return;

    conversations
      .filter((conversation) => conversation.id !== SYSTEM_ANNOUNCEMENTS_ID && conversation.kind !== 'system')
      .forEach((conversation) => deleteConversation(conversation.id));
    createConversation();
    showToast('普通对话已清空', 'success');
  };

  return (
    <div className="system-settings-stack">
      <div className="system-settings-danger-zone">
        <div>
          <strong>普通对话历史</strong>
          <span>{normalConversationCount} 个普通对话 · 系统通告保留</span>
        </div>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={clearNormalConversations}
          disabled={normalConversationCount === 0}
        >
          <Trash2 size={14} />
          <span>清空对话</span>
        </button>
      </div>
    </div>
  );
};

const renderSettingsSection = (section: SettingsSection) => {
  switch (section) {
    case 'account':
      return <AccountSecuritySection />;
    case 'profile':
      return <ProfilePanel mode="profile" />;
    case 'ai-model':
      return <SettingsPanel mode="model" />;
    case 'notification':
      return <ProfilePanel mode="notification" />;
    case 'appearance':
      return <AppearanceSettingsSection />;
    case 'tools':
      return <ToolsPermissionSection />;
    case 'data':
      return <DataManagementSection />;
    default:
      return <AccountSecuritySection />;
  }
};

const SystemSettingsWorkspace: React.FC = () => {
  const activeSettingsSection = useAppStore((state) => state.activeSettingsSection);
  const setActiveSettingsSection = useAppStore((state) => state.setActiveSettingsSection);
  const activeSection = SETTINGS_SECTIONS.find((section) => section.id === activeSettingsSection) ?? SETTINGS_SECTIONS[0];

  return (
    <div className="system-settings-workspace">
      <aside className="system-settings-nav" aria-label="系统设置分组">
        <div className="system-settings-nav-head">
          <span>OpsDog</span>
          <strong>系统设置</strong>
        </div>
        <div className="system-settings-nav-list">
          {SETTINGS_SECTIONS.map((section) => {
            const Icon = section.icon;
            return (
              <button
                key={section.id}
                type="button"
                className={`system-settings-nav-item${section.id === activeSettingsSection ? ' active' : ''}`}
                onClick={() => setActiveSettingsSection(section.id)}
              >
                <Icon size={16} />
                <span>
                  <strong>{section.label}</strong>
                  <em>{section.description}</em>
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      <main className="system-settings-main">
        <SectionHeader title={activeSection.label} description={activeSection.description} />
        <div className="system-settings-panel">
          {renderSettingsSection(activeSection.id)}
        </div>
      </main>
    </div>
  );
};

export default SystemSettingsWorkspace;
