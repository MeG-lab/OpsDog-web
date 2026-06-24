import React from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { Unplug, X } from 'lucide-react';
import { createRemoteTerminalSocket } from '../../services/runtime';
import type { SshTerminalClientFrame, SshTerminalServerFrame } from '../../services/runtime';
import { deferTerminalConnection } from './deferTerminalConnection';
import { createTerminalResizeFrame, sendTerminalFrameWhenReady } from './sendTerminalFrameWhenReady';

type TerminalWorkspaceProps = {
  profileLabel: string;
  targetLabel: string;
  protocol: 'ssh' | 'telnet';
  token: string;
  visible?: boolean;
  active?: boolean;
  autoFocus?: boolean;
  onReady?: (sessionId: string) => void;
  onOutput?: (data: string) => void;
  onStatusChange?: (status: TerminalStatus, message?: string) => void;
  onFocusTerminal?: () => void;
  onClose(): void;
};

type TerminalStatus = 'connecting' | 'connected' | 'closed' | 'error';

const statusLabel: Record<TerminalStatus, string> = {
  connecting: '正在连接...',
  connected: '已连接',
  closed: '连接已关闭',
  error: '连接失败',
};

const TerminalWorkspace: React.FC<TerminalWorkspaceProps> = ({
  profileLabel,
  targetLabel,
  protocol,
  token,
  visible = true,
  active = true,
  autoFocus = true,
  onReady,
  onOutput,
  onStatusChange,
  onFocusTerminal,
  onClose,
}) => {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const socketRef = React.useRef<WebSocket | null>(null);
  const terminalRef = React.useRef<Terminal | null>(null);
  const fitAddonRef = React.useRef<FitAddon | null>(null);
  const sessionReadyRef = React.useRef(false);
  const statusRef = React.useRef<TerminalStatus>('connecting');
  const [status, setStatus] = React.useState<TerminalStatus>('connecting');
  const [error, setError] = React.useState('');
  const protocolLabel = protocol === 'telnet' ? 'TELNET' : 'SSH';

  const updateStatus = React.useCallback((nextStatus: TerminalStatus, message = '') => {
    statusRef.current = nextStatus;
    setStatus(nextStatus);
    setError(nextStatus === 'error' ? message : '');
    onStatusChange?.(nextStatus, message);
  }, [onStatusChange]);

  const fitVisibleTerminal = React.useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal || !fitAddonRef.current) return;
    fitAddonRef.current.fit();
    sendTerminalFrameWhenReady(
      socketRef.current,
      sessionReadyRef.current,
      createTerminalResizeFrame(terminal.cols, terminal.rows),
    );
    if (autoFocus && active) {
      terminal.focus();
      onFocusTerminal?.();
    }
  }, [active, autoFocus, onFocusTerminal]);

  React.useEffect(() => {
    if (!visible) return undefined;
    if (visible && fitAddonRef.current) {
      fitAddonRef.current.fit();
    }
    const frame = window.requestAnimationFrame(fitVisibleTerminal);
    return () => window.cancelAnimationFrame(frame);
  }, [fitVisibleTerminal, visible]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    let disposed = false;
    updateStatus('connecting');
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: '"SFMono-Regular", "Roboto Mono", Consolas, monospace',
      fontSize: 13,
      scrollback: 3000,
      theme: {
        background: '#111827',
        foreground: '#e5e7eb',
        cursor: '#38bdf8',
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    let socket: WebSocket | null = null;
    let sessionReady = false;
    sessionReadyRef.current = false;

    const sendFrame = (frame: SshTerminalClientFrame) => {
      sendTerminalFrameWhenReady(socket, sessionReady, frame);
    };
    const fitAndResize = () => {
      fitAddon.fit();
      sendFrame(createTerminalResizeFrame(terminal.cols, terminal.rows));
    };
    const inputListener = terminal.onData((data) => {
      if (autoFocus) onFocusTerminal?.();
      sendFrame({ type: 'input', data });
    });
    const resizeObserver = new ResizeObserver(() => {
      fitAndResize();
    });
    resizeObserver.observe(container);

    const cancelConnection = deferTerminalConnection(() => {
      if (disposed) return;
      socket = createRemoteTerminalSocket(token);
      socketRef.current = socket;

      socket.addEventListener('message', (event) => {
        let frame: SshTerminalServerFrame;
        try {
          frame = JSON.parse(String(event.data)) as SshTerminalServerFrame;
        } catch {
          if (!disposed) {
            updateStatus('error', '终端服务返回了无法识别的数据。');
          }
          return;
        }
        if (frame.type === 'ready') {
          sessionReady = true;
          sessionReadyRef.current = true;
          if (!disposed) updateStatus('connected');
          fitAndResize();
          if (autoFocus) {
            terminal.focus();
            onFocusTerminal?.();
          }
          onReady?.(frame.sessionId);
          return;
        }
        if (frame.type === 'output') {
          terminal.write(frame.data);
          onOutput?.(frame.data);
          return;
        }
        if (frame.type === 'closed') {
          sessionReady = false;
          sessionReadyRef.current = false;
          if (!disposed) updateStatus('closed');
          return;
        }
        sessionReady = false;
        sessionReadyRef.current = false;
        if (!disposed) {
          updateStatus('error', frame.message);
        }
      });
      socket.addEventListener('close', () => {
        sessionReady = false;
        sessionReadyRef.current = false;
        if (!disposed && statusRef.current !== 'error') {
          updateStatus('closed');
        }
      });
      socket.addEventListener('error', () => {
        sessionReady = false;
        sessionReadyRef.current = false;
        if (!disposed) {
          updateStatus('error', '终端 WebSocket 连接失败。');
        }
      });
    });

    return () => {
      disposed = true;
      cancelConnection();
      resizeObserver.disconnect();
      inputListener.dispose();
      sendFrame({ type: 'close' } satisfies SshTerminalClientFrame);
      socket?.close();
      if (socketRef.current === socket) socketRef.current = null;
      if (terminalRef.current === terminal) terminalRef.current = null;
      if (fitAddonRef.current === fitAddon) fitAddonRef.current = null;
      sessionReadyRef.current = false;
      terminal.dispose();
    };
  }, [autoFocus, onFocusTerminal, onOutput, onReady, protocol, token, updateStatus]);

  const disconnect = () => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'close' } satisfies SshTerminalClientFrame));
    }
  };

  return (
    <div className="remote-terminal-workspace">
      <header className="remote-terminal-head">
        <div className="remote-terminal-identity">
          <strong className="remote-terminal-session-title" title={targetLabel}>
            {profileLabel} ({protocolLabel})
          </strong>
        </div>
        <div className={`remote-terminal-status ${status}`}>
          <i />
          {statusLabel[status]}
        </div>
        <div className="remote-terminal-actions">
          <button
            type="button"
            className="remote-terminal-icon-btn danger"
            onClick={disconnect}
            disabled={status !== 'connected'}
            aria-label="断开连接"
            title="断开连接"
          >
            <Unplug size={15} />
          </button>
          <button
            type="button"
            className="remote-terminal-icon-btn"
            onClick={onClose}
            aria-label="关闭终端窗口"
            title="关闭终端窗口"
          >
            <X size={15} />
          </button>
        </div>
      </header>
      <div ref={containerRef} className="remote-terminal-canvas" />
      <footer className={`remote-terminal-foot${error ? ' has-error' : ''}`}>
        {error ? <span className="remote-terminal-error">{error}</span> : <span>终端内容不写入审计或数据库。</span>}
      </footer>
    </div>
  );
};

export default TerminalWorkspace;
