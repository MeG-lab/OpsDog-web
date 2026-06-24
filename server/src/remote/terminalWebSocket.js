import { StringDecoder } from 'node:string_decoder';
import { WebSocket, WebSocketServer } from 'ws';

const MAX_INPUT_BYTES = 64 * 1024;
const SAFE_OPEN_CODES = new Set([
  'HOST_KEY_MISMATCH',
  'SSH_CONNECTION_DISABLED',
  'SSH_CREDENTIAL_UNAVAILABLE',
  'SSH_TERMINAL_CONNECTION_FAILED',
  'SSH_TERMINAL_OPEN_FAILED',
  'TELNET_CONNECTION_DISABLED',
  'TELNET_CREDENTIAL_UNAVAILABLE',
  'TELNET_CONNECTION_FAILED',
  'TELNET_LOGIN_FAILED',
  'TELNET_TERMINAL_OPEN_FAILED',
  'TELNET_UNSUPPORTED',
  'TERMINAL_TOKEN_INVALID',
]);

const send = (socket, frame) => {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(frame));
  }
};

const validResize = (frame) => (
  Number.isInteger(frame.cols)
  && Number.isInteger(frame.rows)
  && frame.cols >= 20
  && frame.cols <= 500
  && frame.rows >= 5
  && frame.rows <= 200
);

export const createTerminalWebSocket = (terminalService, { isOriginAllowed = () => true } = {}) => {
  const gateway = new WebSocketServer({ noServer: true });
  const sockets = new Set();

  const accept = async (socket, token) => {
    const decoder = new StringDecoder('utf8');
    let sessionId = null;
    let removeDataListener = null;
    let removeCloseListener = null;

    const closeSession = (reason) => {
      if (!sessionId) return;
      const currentId = sessionId;
      sessionId = null;
      removeDataListener?.();
      removeDataListener = null;
      removeCloseListener?.();
      removeCloseListener = null;
      terminalService.close(currentId, reason);
    };

    const failFrame = () => {
      send(socket, {
        type: 'error',
        code: 'TERMINAL_FRAME_INVALID',
        message: 'Invalid terminal message.',
      });
      closeSession('invalid_frame');
      socket.close(1008);
    };

    const closeTerminalSocket = (reason) => {
      closeSession(reason);
      send(socket, { type: 'closed', reason });
      socket.close(1000);
    };

    const failTerminalOperation = (error) => {
      if (error?.code === 'TERMINAL_SESSION_CLOSED') {
        closeTerminalSocket('remote_closed');
        return;
      }
      send(socket, {
        type: 'error',
        code: 'TERMINAL_OPERATION_FAILED',
        message: 'Unable to write to the terminal connection.',
      });
      closeSession('operation_failed');
      socket.close(1011);
    };

    const runTerminalOperation = (operation) => {
      try {
        operation();
        return true;
      } catch (error) {
        failTerminalOperation(error);
        return false;
      }
    };

    socket.once('close', () => {
      sockets.delete(socket);
      closeSession('websocket_closed');
    });
    socket.on('message', (raw, isBinary) => {
      if (!sessionId || isBinary) {
        failFrame();
        return;
      }
      let frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        failFrame();
        return;
      }
      if (frame?.type === 'input'
          && typeof frame.data === 'string'
          && Buffer.byteLength(frame.data, 'utf8') <= MAX_INPUT_BYTES) {
        runTerminalOperation(() => terminalService.write(sessionId, frame.data));
        return;
      }
      if (frame?.type === 'resize' && validResize(frame)) {
        runTerminalOperation(() => terminalService.resize(sessionId, { cols: frame.cols, rows: frame.rows }));
        return;
      }
      if (frame?.type === 'close') {
        closeTerminalSocket('operator_closed');
        return;
      }
      failFrame();
    });

    try {
      const terminal = await terminalService.openTerminal(token);
      if (socket.readyState !== WebSocket.OPEN) {
        terminalService.close(terminal.sessionId, 'websocket_closed');
        return;
      }
      sessionId = terminal.sessionId;
      removeDataListener = terminal.onData((data) => {
        const text = Buffer.isBuffer(data) ? decoder.write(data) : String(data);
        if (text) send(socket, { type: 'output', data: text });
      });
      removeCloseListener = terminal.onClose?.(() => {
        closeTerminalSocket('remote_closed');
      }) || null;
      send(socket, { type: 'ready', sessionId });
    } catch (error) {
      const code = SAFE_OPEN_CODES.has(error?.code)
        ? error.code
        : 'SSH_TERMINAL_CONNECTION_FAILED';
      send(socket, {
        type: 'error',
        code,
        message: 'Unable to open the terminal connection.',
      });
      socket.close(1008);
    }
  };

  return {
    handleUpgrade(request, socket, head) {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      if (url.pathname !== '/api/remote/terminal') return false;
      if (!isOriginAllowed(request)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return true;
      }
      const token = url.searchParams.get('token') || '';
      gateway.handleUpgrade(request, socket, head, (webSocket) => {
        sockets.add(webSocket);
        void accept(webSocket, token);
      });
      return true;
    },

    close() {
      for (const socket of sockets) socket.terminate();
      return new Promise((resolve) => gateway.close(() => resolve()));
    },
  };
};
