import React from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, KeyRound, Loader2, ShieldCheck, SquareTerminal, Unplug } from 'lucide-react';
import type { AssetDevice } from '../../types';
import {
  createRemoteTerminalToken,
  trustSshHostKey,
  type ConnectionProfile,
  type SshHostKeyView,
} from '../../services/runtime';

const TerminalWorkspace = React.lazy(() => import('../Remote/TerminalWorkspace'));
const SHOW_AI_PERMISSION_LEVELS = false;

type AiPermissionLevel = 'L1' | 'L2' | 'L3';

export type ChatRemoteTerminalSelection = {
  device: AssetDevice;
  profile: ConnectionProfile;
};

type ChatRemotePermissionShellProps = {
  device: AssetDevice;
  profile: ConnectionProfile;
  onSessionReady?: (sessionId: string) => void;
  onSessionClosed?: () => void;
  onConnectionStateChange?: (state: 'idle' | 'connecting' | 'connected' | 'closed' | 'error') => void;
  onOutput?: (data: string) => void;
  onClose: () => void;
};

const PERMISSION_OPTIONS: Array<{ value: AiPermissionLevel; label: string }> = [
  { value: 'L1', label: 'L1 只读' },
  { value: 'L2', label: 'L2 执行时审批' },
  { value: 'L3', label: 'L3 完全自主' },
];

const getTargetLabel = (profile: ConnectionProfile) => `${profile.username ? `${profile.username}@` : ''}${profile.host}:${profile.port}`;

const isHostKeyChallenge = (hostKey: SshHostKeyView | null) => (
  hostKey?.code === 'HOST_KEY_CONFIRMATION_REQUIRED' && Boolean(hostKey.challengeToken)
);

const ChatRemotePermissionShell: React.FC<ChatRemotePermissionShellProps> = ({
  device,
  profile,
  onSessionReady,
  onSessionClosed,
  onConnectionStateChange,
  onOutput,
  onClose,
}) => {
  const [permissionLevel, setPermissionLevel] = React.useState<AiPermissionLevel>('L1');
  const [isExpanded, setIsExpanded] = React.useState(false);
  const [terminalStatus, setTerminalStatus] = React.useState<'idle' | 'connecting' | 'connected' | 'closed' | 'error'>('idle');
  const [token, setToken] = React.useState('');
  const [hostKey, setHostKey] = React.useState<SshHostKeyView | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const targetLabel = getTargetLabel(profile);
  const protocolLabel = profile.protocol === 'telnet' ? 'TELNET' : 'SSH';
  const needsUserAttention = Boolean(error || isHostKeyChallenge(hostKey));
  const remoteConnectionState = error ? 'error' : terminalStatus;
  const remoteConnectionLabel = remoteConnectionState === 'connected'
    ? '设备已连接'
    : remoteConnectionState === 'error'
      ? '连接异常'
      : remoteConnectionState === 'closed'
        ? '连接已断开'
        : '正在连接设备...';

  const openTerminal = React.useCallback(async () => {
    setLoading(true);
    setError('');
    setHostKey(null);
    setToken('');
    setTerminalStatus('connecting');
    onConnectionStateChange?.('connecting');
    try {
      const response = await createRemoteTerminalToken(profile.id, { cols: 100, rows: 24 });
      if ('token' in response) {
        setToken(response.token);
        setHostKey('hostKey' in response ? response.hostKey : null);
        return;
      }
      setHostKey(response);
      if (response.code === 'HOST_KEY_MISMATCH') {
        setError('SSH 主机密钥已变化，连接已阻断。');
        setTerminalStatus('error');
        onConnectionStateChange?.('error');
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '远程终端打开失败。');
      setTerminalStatus('error');
      onConnectionStateChange?.('error');
    } finally {
      setLoading(false);
    }
  }, [onConnectionStateChange, profile.id]);

  React.useEffect(() => {
    void openTerminal();
  }, [openTerminal]);

  React.useEffect(() => {
    if (needsUserAttention) {
      setIsExpanded(true);
    }
  }, [needsUserAttention]);

  const handleSessionReady = React.useCallback((sessionId: string) => {
    setTerminalStatus('connected');
    onConnectionStateChange?.('connected');
    onSessionReady?.(sessionId);
  }, [onConnectionStateChange, onSessionReady]);

  const handleTerminalStatusChange = React.useCallback((
    status: 'connecting' | 'connected' | 'closed' | 'error',
    message?: string,
  ) => {
    setTerminalStatus(status);
    onConnectionStateChange?.(status);
    if (status === 'connected') {
      return;
    }
    if (status === 'closed' || status === 'error') {
      onSessionClosed?.();
      if (message) setError(message);
    }
  }, [onConnectionStateChange, onSessionClosed]);

  const approveHostKey = async () => {
    if (!hostKey?.challengeToken) return;
    setLoading(true);
    setError('');
    try {
      await trustSshHostKey(profile.id, hostKey.challengeToken);
      await openTerminal();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'SSH 主机密钥确认失败。');
      setTerminalStatus('error');
      onConnectionStateChange?.('error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="chat-remote-shell chat-remote-terminal-slide" aria-label="设备功能可见终端">
      <button
        type="button"
        className={`chat-remote-collapse-bar ${remoteConnectionState}`}
        aria-expanded={isExpanded}
        onClick={() => setIsExpanded((current) => !current)}
      >
        <span className={`chat-remote-connection-dot ${remoteConnectionState}`} aria-hidden="true" />
        <div className="chat-remote-collapse-copy">
          <strong>{remoteConnectionLabel}</strong>
          <span>{device.name || '未命名设备'} · {profile.name}</span>
        </div>
        <span className="chat-remote-collapse-chevron" aria-hidden="true">
          {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </button>

      <div className={`chat-remote-terminal-panel${isExpanded ? ' is-expanded' : ' is-collapsed'}`}>
        <header className="chat-remote-shell-head">
          <div className="chat-remote-shell-title">
            <span className="chat-remote-shell-icon"><SquareTerminal size={16} /></span>
            <div>
              <strong>可见终端</strong>
              <span>{device.name || '未命名设备'} · {profile.name} · {targetLabel}</span>
            </div>
          </div>
          <div className="chat-remote-shell-actions">
            <button
              type="button"
              className="chat-remote-shell-action danger"
              onClick={onClose}
            >
              <Unplug size={14} />
              <span>断开连接</span>
            </button>
          </div>
        </header>
        {SHOW_AI_PERMISSION_LEVELS ? (
          <div className="chat-remote-permission-levels" aria-label="AI 权限等级">
            {PERMISSION_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`chat-remote-permission-option${permissionLevel === option.value ? ' active' : ''}`}
                aria-pressed={permissionLevel === option.value}
                onClick={() => setPermissionLevel(option.value)}
              >
                <ShieldCheck size={13} />
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="chat-remote-terminal-frame">
          {loading && !token ? (
            <div className="chat-remote-terminal-state">
              <Loader2 size={16} className="spin" />
              <span>正在打开 {protocolLabel} 终端...</span>
            </div>
          ) : null}
          {isHostKeyChallenge(hostKey) ? (
            <div className="chat-remote-hostkey-card">
              <KeyRound size={16} />
              <div>
                <strong>确认 SSH 主机密钥</strong>
                <span>{hostKey?.host}:{hostKey?.port} · {hostKey?.keyType}</span>
                <code>{hostKey?.fingerprintSha256}</code>
              </div>
              <button type="button" className="chat-remote-shell-action" disabled={loading} onClick={() => void approveHostKey()}>
                {loading ? '确认中...' : '确认并连接'}
              </button>
            </div>
          ) : null}
          {error ? (
            <div className="chat-remote-hostkey-card warning">
              <AlertTriangle size={16} />
              <div>
                <strong>终端连接失败</strong>
                <span>{error}</span>
                {hostKey?.code === 'HOST_KEY_MISMATCH' ? <code>{hostKey.fingerprintSha256}</code> : null}
              </div>
            </div>
          ) : null}
          {token ? (
            <React.Suspense fallback={(
              <div className="chat-remote-terminal-state">
                <Loader2 size={16} className="spin" />
                <span>正在加载终端...</span>
              </div>
            )}>
              <TerminalWorkspace
                key={token}
                profileLabel={profile.name}
                targetLabel={targetLabel}
                protocol={profile.protocol}
                token={token}
                autoFocus={false}
                onReady={handleSessionReady}
                onOutput={onOutput}
                onStatusChange={handleTerminalStatusChange}
                onClose={onClose}
              />
            </React.Suspense>
          ) : null}
        </div>
      </div>
    </section>
  );
};

export default ChatRemotePermissionShell;
