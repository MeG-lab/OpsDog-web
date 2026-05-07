import React from 'react';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import ChatArea from './components/Chat/ChatArea';
import ScriptsWorkspace from './components/Scripts/ScriptsWorkspace';
import OverviewWorkspace from './components/Overview/OverviewWorkspace';
import { initializeStores, refreshServerState, useAppStore, useChatStore } from './stores';
import { getBackendHealth } from './services/runtime';
import type { ServerDefinition } from './types';

const App: React.FC = () => {
  const activeWorkspace = useAppStore(s => s.activeWorkspace);
  const servers = useAppStore(s => s.servers);
  const setBackendStatus = useAppStore(s => s.setBackendStatus);
  const ensureSystemConversation = useChatStore(s => s.ensureSystemConversation);
  const appendSystemAnnouncement = useChatStore(s => s.appendSystemAnnouncement);
  const previousManagedStatuses = React.useRef<Record<string, ServerDefinition['status']>>({});

  React.useEffect(() => {
    void initializeStores();
  }, []);

  React.useEffect(() => {
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
  }, [setBackendStatus]);

  React.useEffect(() => {
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
  }, []);

  React.useEffect(() => {
    const parseManagedTarget = (task: ServerDefinition) => task.entry || task.name;

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

    const isAlertStatus = (status: ServerDefinition['status']) =>
      status === 'attention' || status === 'warning' || status === 'error';

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
    });

    previousManagedStatuses.current = nextStatuses;
  }, [appendSystemAnnouncement, ensureSystemConversation, servers]);

  return (
    <div className="app-layout">
      <Sidebar />
      <div className="main">
        <TopBar />
        {activeWorkspace === 'chat'
          ? <ChatArea />
          : activeWorkspace === 'scripts'
            ? <ScriptsWorkspace />
            : <OverviewWorkspace />}
      </div>
    </div>
  );
};

export default App;
