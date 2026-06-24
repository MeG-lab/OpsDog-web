import React from 'react';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import DesktopTitleBar from './components/DesktopTitleBar';
import ChatArea from './components/Chat/ChatArea';
import ScriptsWorkspace from './components/Scripts/ScriptsWorkspace';
import OverviewWorkspace from './components/Overview/OverviewWorkspace';
import ServersWorkspace from './components/Servers/ServersWorkspace';
import SystemSettingsWorkspace from './components/Settings/SystemSettingsWorkspace';
import MaskCalculatorWorkspace from './components/More/MaskCalculatorWorkspace';
import LoginPage from './components/Auth/LoginPage';
import ToastViewport from './components/ToastViewport';
import { initializeStores, refreshServerState, useAppStore, useChatStore } from './stores';
import { callServerTool, getAuthSession, getBackendHealth, logout } from './services/runtime';
import type { ServerDefinition } from './types';
import type { AuthUser } from './services/runtime';

const ALERT_VOICE_NOTIFY_NUMBERS = String(import.meta.env.VITE_ALERT_VOICE_NOTIFY_NUMBERS || '')
  .split(/[,\n;，；\s]+/)
  .map((item) => item.trim())
  .filter(Boolean);

const parseNotifyNumbers = (value: string) => value
  .split(/[,\n;，；\s]+/)
  .map((item) => item.trim())
  .filter(Boolean);

const VOICE_ALERT_COOLDOWN_MS = 10 * 60 * 1000;
const BUILTIN_VOICE_SKILL_SERVER_ID = 'skillpkg_aliyun-voice-notify';
const BUILTIN_VOICE_SKILL_TOOL_NAME = 'make_call';

const dedupeNotifyNumbers = (numbers: string[]) => {
  const seen = new Set<string>();
  return numbers.filter((item) => {
    const key = item.replace(/\s+/g, '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const App: React.FC = () => {
  const [authSession, setAuthSession] = React.useState<{
    loading: boolean;
    authenticated: boolean;
    user?: AuthUser;
  }>({ loading: true, authenticated: false });
  const activeWorkspace = useAppStore(s => s.activeWorkspace);
  const servers = useAppStore(s => s.servers);
  const operatorProfile = useAppStore(s => s.operatorProfile);
  const setBackendStatus = useAppStore(s => s.setBackendStatus);
  const ensureSystemConversation = useChatStore(s => s.ensureSystemConversation);
  const appendSystemAnnouncement = useChatStore(s => s.appendSystemAnnouncement);
  const previousManagedStatuses = React.useRef<Record<string, ServerDefinition['status']>>({});
  const lastVoiceAlertFingerprintByServer = React.useRef<Record<string, string>>({});
  const lastVoiceAlertAtByServer = React.useRef<Record<string, number>>({});

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const session = await getAuthSession();
        if (cancelled) return;
        if (session.authenticated && session.user) {
          await initializeStores();
          if (cancelled) return;
          setAuthSession({ loading: false, authenticated: true, user: session.user });
          return;
        }
        setAuthSession({ loading: false, authenticated: false });
      } catch {
        if (!cancelled) setAuthSession({ loading: false, authenticated: false });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleAuthenticated = React.useCallback(async (user: AuthUser) => {
    setAuthSession({ loading: true, authenticated: false });
    await initializeStores();
    setAuthSession({ loading: false, authenticated: true, user });
  }, []);

  const handleLogout = React.useCallback(async () => {
    try {
      await logout();
    } finally {
      useChatStore.setState({ conversations: [], activeConversationId: null, isStreaming: false, reportDrafts: {} });
      useAppStore.setState({
        llmConfigs: [],
        activeModelId: null,
        servers: [],
        skillPackages: [],
        activeWorkspace: 'chat',
        activePanel: null,
      });
      setAuthSession({ loading: false, authenticated: false });
    }
  }, []);

  React.useEffect(() => {
    if (!authSession.authenticated) return;
    const pollBackendHealth = async () => {
      try {
        await getBackendHealth();
        setBackendStatus(true, '后端已连接');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setBackendStatus(false, `后端未连接：${message}`);
      }
    };

    void pollBackendHealth();
    const timer = window.setInterval(() => {
      void pollBackendHealth();
    }, 5000);

    return () => window.clearInterval(timer);
  }, [authSession.authenticated, setBackendStatus]);

  React.useEffect(() => {
    if (!authSession.authenticated) return;
    const pollManagedTaskTransitions = async () => {
      try {
        await refreshServerState();
      } catch (error) {
        console.error('poll managed task transitions error:', error);
      }
    };

    void pollManagedTaskTransitions();
    const timer = window.setInterval(() => {
      void pollManagedTaskTransitions();
    }, 3000);

    return () => window.clearInterval(timer);
  }, [authSession.authenticated]);

  React.useEffect(() => {
    if (!authSession.authenticated) return;

    const parseManagedTarget = (task: ServerDefinition) => task.entry || task.name;
    const buildVoiceEquipmentLabel = (task: ServerDefinition) => {
      const target = parseManagedTarget(task);
      const normalizedTarget = target.split('/').pop() || target;
      const raw = normalizedTarget || task.name || task.id || '系统告警';
      return raw.slice(0, 15);
    };

    const buildManagedStatusMessage = (task: ServerDefinition, kind: 'alert' | 'recovered') => {
      const target = parseManagedTarget(task);
      if (kind === 'recovered') {
        return [
          '## Server 恢复',
          '',
          `- **Server**：\`${task.id}\``,
          `- **目标**：\`${target}\``,
          `- **状态**：已恢复`,
          task.runtimeState?.lastOutputAt ? `- **时间**：${new Date(task.runtimeState.lastOutputAt).toLocaleString('zh-CN', { hour12: false })}` : '',
        ].filter(Boolean).join('\n');
      }

      return [
        '## Server 告警',
        '',
        `- **Server**：\`${task.id}\``,
        `- **目标**：\`${target}\``,
        `- **状态**：${task.status === 'attention' ? '需关注' : task.status === 'error' ? '异常退出' : '告警中'}`,
        task.runtimeState?.lastOutputAt ? `- **时间**：${new Date(task.runtimeState.lastOutputAt).toLocaleString('zh-CN', { hour12: false })}` : '',
      ].filter(Boolean).join('\n');
    };

    const buildAlertFingerprint = (task: ServerDefinition) => {
      const target = parseManagedTarget(task);
      const recentLog = task.capabilities?.recentLogs?.[task.capabilities.recentLogs.length - 1] || '';
      const normalizedRecentLog = recentLog.replace(/\s+/g, ' ').trim().slice(0, 240);
      return [task.id, task.status, target, normalizedRecentLog].join('::');
    };

    const savedVoiceAccessKeyId = String(operatorProfile.voiceAccessKeyId || '').trim();
    const savedVoiceAccessKeySecret = String(operatorProfile.voiceAccessKeySecret || '').trim();
    const hasSavedVoiceCredentials = Boolean(savedVoiceAccessKeyId && savedVoiceAccessKeySecret);
    const savedNotifyNumbers = parseNotifyNumbers(String(operatorProfile.voiceNotifyNumbers || ''));
    const profileNotifyNumber = operatorProfile.voiceAlertEnabled
      ? String(operatorProfile.phone || '').trim()
      : '';
    // Frontend profile switch is the single gate for automatic voice alerts.
    // .env only provides fallback credentials / numbers and should not enable
    // calling on its own, otherwise UI state and actual behavior diverge.
    const voiceNotifyEnabled = operatorProfile.voiceServiceEnabled;
    const baseVoiceNotifyNumbers = savedNotifyNumbers.length > 0
      ? savedNotifyNumbers
      : ALERT_VOICE_NOTIFY_NUMBERS;
    const voiceNotifyNumbers = dedupeNotifyNumbers([
      ...baseVoiceNotifyNumbers,
      ...(profileNotifyNumber ? [profileNotifyNumber] : []),
    ]);
    const voiceEnvOverrides = hasSavedVoiceCredentials
      ? {
          ALIBABA_CLOUD_ACCESS_KEY_ID: savedVoiceAccessKeyId,
          ALIBABA_CLOUD_ACCESS_KEY_SECRET: savedVoiceAccessKeySecret,
        }
      : undefined;

    const sendVoiceAlert = async (task: ServerDefinition) => {
      if (!voiceNotifyEnabled || voiceNotifyNumbers.length === 0) {
        return;
      }

      const equipment = buildVoiceEquipmentLabel(task);
      const results = await Promise.all(voiceNotifyNumbers.map(async (calledNumber) => {
        try {
          const response = await callServerTool(BUILTIN_VOICE_SKILL_SERVER_ID, BUILTIN_VOICE_SKILL_TOOL_NAME, {
            input: {
              called_number: calledNumber,
              equipment,
              requestText: `自动告警通知 ${equipment} ${calledNumber}`,
            },
            timeoutMs: 45000,
            ...(voiceEnvOverrides ? { envOverrides: voiceEnvOverrides } : {}),
          });
          const text = response.content?.map((item) => item.text || '').join('\n').trim() || '';
          return {
            calledNumber,
            ok: !response.isError,
            stdout: response.isError ? '' : text,
            stderr: response.isError ? text : '',
          };
        } catch (error) {
          return {
            calledNumber,
            ok: false,
            stdout: '',
            stderr: error instanceof Error ? error.message : String(error),
          };
        }
      }));
      const successCount = results.filter((item) => item.ok).length;
      const failureCount = results.length - successCount;
      const details = results
        .map((item) => `- \`${item.calledNumber}\`：${item.ok ? '成功' : item.stderr || item.stdout || '失败'}`)
        .join('\n');

      appendSystemAnnouncement([
        '## 语音通知执行结果',
        '',
        `- **Server**：\`${task.id}\``,
        `- **设备名**：\`${equipment}\``,
        `- **成功**：${successCount}`,
        `- **失败**：${failureCount}`,
        '',
        details,
      ].join('\n'));
    };

    const isAlertStatus = (status: ServerDefinition['status']) =>
      status === 'attention' || status === 'warning' || status === 'error';

    const shouldSendVoiceAlert = (task: ServerDefinition) => {
      if (task.status !== 'warning' && task.status !== 'error') {
        return false;
      }

      const fingerprint = buildAlertFingerprint(task);
      const lastFingerprint = lastVoiceAlertFingerprintByServer.current[task.id];
      const lastAlertAt = lastVoiceAlertAtByServer.current[task.id] || 0;
      const now = Date.now();

      if (lastFingerprint === fingerprint && now - lastAlertAt < VOICE_ALERT_COOLDOWN_MS) {
        return false;
      }

      lastVoiceAlertFingerprintByServer.current[task.id] = fingerprint;
      lastVoiceAlertAtByServer.current[task.id] = now;
      return true;
    };

    const tasks = servers.filter((server) => server.category === 'managed');
    const nextStatuses: Record<string, ServerDefinition['status']> = {};

    tasks.forEach(task => {
      nextStatuses[task.id] = task.status;
      const previousStatus = previousManagedStatuses.current[task.id];

      if (!previousStatus) {
        return;
      }

      const becameAlert = !isAlertStatus(previousStatus) && isAlertStatus(task.status);
      const becameRecovered = isAlertStatus(previousStatus) && task.status === 'recovered';

      if (!becameAlert && !becameRecovered) {
        return;
      }

      ensureSystemConversation();
      appendSystemAnnouncement(buildManagedStatusMessage(task, becameRecovered ? 'recovered' : 'alert'));
      if (becameRecovered) {
        delete lastVoiceAlertFingerprintByServer.current[task.id];
        delete lastVoiceAlertAtByServer.current[task.id];
      }
      if (becameAlert && shouldSendVoiceAlert(task)) {
        void sendVoiceAlert(task);
      }
    });

    previousManagedStatuses.current = nextStatuses;
  }, [appendSystemAnnouncement, authSession.authenticated, ensureSystemConversation, operatorProfile, servers]);

  if (authSession.loading) {
    return (
      <div className="desktop-shell">
        <DesktopTitleBar />
        <div className="login-loading">正在检查登录状态...</div>
      </div>
    );
  }

  if (!authSession.authenticated) {
    return (
      <div className="desktop-shell">
        <DesktopTitleBar />
        <ToastViewport />
        <LoginPage onAuthenticated={handleAuthenticated} />
      </div>
    );
  }

  return (
    <div className="desktop-shell">
      <DesktopTitleBar />
      <div className="app-layout">
        <ToastViewport />
        <Sidebar />
        <div className="main">
          <TopBar authUser={authSession.user} onLogout={handleLogout} />
          <div className={`workspace-pane chat${activeWorkspace === 'chat' ? ' active' : ''}`} aria-hidden={activeWorkspace !== 'chat'}>
            <ChatArea />
          </div>
          {activeWorkspace === 'scripts'
            ? <ScriptsWorkspace />
            : activeWorkspace === 'overview'
              ? <OverviewWorkspace />
              : activeWorkspace === 'servers'
                ? <ServersWorkspace />
                : activeWorkspace === 'settings'
                  ? <SystemSettingsWorkspace />
                  : activeWorkspace === 'more'
                    ? <MaskCalculatorWorkspace />
                    : null}
        </div>
      </div>
    </div>
  );
};

export default App;
