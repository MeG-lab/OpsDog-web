import React from 'react';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import ChatArea from './components/Chat/ChatArea';
import ScriptsWorkspace from './components/Scripts/ScriptsWorkspace';
import { initializeStores, useAppStore, useChatStore } from './stores';
import { listManagedTasks, restoreManagedTasks } from './services/tauri';
import type { ManagedTaskInfo } from './types';

const App: React.FC = () => {
  const activeWorkspace = useAppStore(s => s.activeWorkspace);
  const ensureSystemConversation = useChatStore(s => s.ensureSystemConversation);
  const appendSystemAnnouncement = useChatStore(s => s.appendSystemAnnouncement);
  const previousManagedStatuses = React.useRef<Record<string, ManagedTaskInfo['status']>>({});

  React.useEffect(() => {
    initializeStores();
  }, []);

  React.useEffect(() => {
    const restore = async () => {
      try {
        await restoreManagedTasks();
      } catch (error) {
        console.error('restore managed tasks error:', error);
      }
    };

    void restore();
  }, []);

  React.useEffect(() => {
    const parseManagedTarget = (task: ManagedTaskInfo) => {
      const latestLine = [...task.recentLogs].reverse().find(Boolean);
      if (!latestLine) return task.taskId;

      try {
        const parsed = JSON.parse(latestLine) as {
          target?: { host?: string; port?: number; process?: string | null };
        };
        const target = parsed.target;
        if (!target) return task.taskId;
        if (target.host && target.port) return `${target.host}:${target.port}`;
        if (target.process) return `进程 ${target.process}`;
      } catch {
        return task.taskId;
      }

      return task.taskId;
    };

    const buildManagedStatusMessage = (task: ManagedTaskInfo, kind: 'alert' | 'recovered') => {
      const target = parseManagedTarget(task);
      if (kind === 'recovered') {
        return [
          '## 托管任务恢复',
          '',
          `- **任务**：\`${task.taskId}\``,
          `- **目标**：\`${target}\``,
          `- **状态**：已恢复`,
          task.lastOutputAt ? `- **时间**：${new Date(task.lastOutputAt).toLocaleString('zh-CN', { hour12: false })}` : '',
        ].filter(Boolean).join('\n');
      }

      return [
        '## 托管任务告警',
        '',
        `- **任务**：\`${task.taskId}\``,
        `- **目标**：\`${target}\``,
        `- **状态**：${task.status === 'attention' ? '需关注' : task.status === 'error' ? '异常退出' : '告警中'}`,
        task.lastOutputAt ? `- **时间**：${new Date(task.lastOutputAt).toLocaleString('zh-CN', { hour12: false })}` : '',
      ].filter(Boolean).join('\n');
    };

    const isAlertStatus = (status: ManagedTaskInfo['status']) =>
      status === 'attention' || status === 'warning' || status === 'error';
    const pollManagedTaskTransitions = async () => {
      try {
        const tasks = await listManagedTasks();
        const nextStatuses: Record<string, ManagedTaskInfo['status']> = {};

        tasks.forEach(task => {
          nextStatuses[task.taskId] = task.status;
          const previousStatus = previousManagedStatuses.current[task.taskId];

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
      } catch (error) {
        console.error('poll managed task transitions error:', error);
      }
    };

    void pollManagedTaskTransitions();
    const timer = window.setInterval(() => {
      void pollManagedTaskTransitions();
    }, 3000);

    return () => window.clearInterval(timer);
  }, [appendSystemAnnouncement, ensureSystemConversation]);

  return (
    <div className="app-layout">
      <Sidebar />
      <div className="main">
        <TopBar />
        {activeWorkspace === 'chat' ? <ChatArea /> : <ScriptsWorkspace />}
      </div>
    </div>
  );
};

export default App;
