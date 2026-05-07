import type { ServerDefinition } from '../types';

export const MANAGED_RUNNING_STATUSES = ['starting', 'running', 'attention', 'warning', 'recovered', 'stopping'] as const;
export const MANAGED_HEALTHY_STATUSES = ['running', 'recovered'] as const;
export const MANAGED_ALERT_STATUSES = ['warning', 'attention', 'error'] as const;

export const summarizeManagedServers = (servers: ServerDefinition[]) => {
  const managed = servers.filter((server) => server.category === 'managed');
  return {
    activeCount: managed.filter((server) => MANAGED_RUNNING_STATUSES.includes(server.status as typeof MANAGED_RUNNING_STATUSES[number])).length,
    healthyCount: managed.filter((server) => MANAGED_HEALTHY_STATUSES.includes(server.status as typeof MANAGED_HEALTHY_STATUSES[number])).length,
    alertCount: managed.filter((server) => MANAGED_ALERT_STATUSES.includes(server.status as typeof MANAGED_ALERT_STATUSES[number])).length,
  };
};
