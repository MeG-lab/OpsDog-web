import type { MCPServer } from '../../types';

export const DEFAULT_FILESYSTEM_ROOT =
  import.meta.env.VITE_OPSDOG_FILESYSTEM_ROOT?.trim() || '/Users/meteor/Code/OpsDog-Web';

export const DEFAULT_FILESYSTEM_PACKAGE = '@modelcontextprotocol/server-filesystem';

export const DEFAULT_FILESYSTEM_ARGS = ['-y', DEFAULT_FILESYSTEM_PACKAGE, DEFAULT_FILESYSTEM_ROOT];

const isBroadFilesystemRoot = (value: string) => {
  const normalized = value.trim();
  return normalized === '/' || normalized === '/Users' || normalized === '/Users/';
};

export const normalizeFilesystemArgs = (args?: string[]): string[] => {
  if (!Array.isArray(args) || args.length === 0) {
    return [...DEFAULT_FILESYSTEM_ARGS];
  }

  const packageIndex = args.findIndex((item) => item.includes(DEFAULT_FILESYSTEM_PACKAGE));
  if (packageIndex === -1) {
    return [...args];
  }

  const nextIndex = packageIndex + 1;
  if (nextIndex >= args.length) {
    return [...args, DEFAULT_FILESYSTEM_ROOT];
  }

  const normalized = [...args];
  if (isBroadFilesystemRoot(normalized[nextIndex] || '')) {
    normalized[nextIndex] = DEFAULT_FILESYSTEM_ROOT;
  }

  return normalized;
};

export const normalizeFilesystemServer = <T extends Pick<MCPServer, 'name' | 'command' | 'args' | 'transport'>>(
  server: T,
): T => {
  const isFilesystemServer =
    server.name === 'filesystem' ||
    Boolean(server.args?.some((item) => item.includes(DEFAULT_FILESYSTEM_PACKAGE)));

  if (!isFilesystemServer) {
    return server;
  }

  return {
    ...server,
    transport: server.transport || 'stdio',
    command: server.command || 'npx',
    args: normalizeFilesystemArgs(server.args),
  };
};
