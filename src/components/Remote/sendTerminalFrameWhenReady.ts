type WritableTerminalSocket = Pick<WebSocket, 'readyState' | 'send'>;

const WEB_SOCKET_OPEN = 1;

const boundedDimension = (value: number, fallback: number, minimum: number, maximum: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
};

export const createTerminalResizeFrame = (cols: number, rows: number) => ({
  type: 'resize' as const,
  cols: boundedDimension(cols, 80, 20, 500),
  rows: boundedDimension(rows, 24, 5, 200),
});

export const sendTerminalFrameWhenReady = (
  socket: WritableTerminalSocket | null,
  sessionReady: boolean,
  frame: unknown,
): void => {
  if (sessionReady && socket?.readyState === WEB_SOCKET_OPEN) {
    socket.send(JSON.stringify(frame));
  }
};
