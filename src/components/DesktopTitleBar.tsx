import React from 'react';
import { Minus, Square, Copy, X } from 'lucide-react';
import opsdogDesktopIcon from '../assets/opsdog-desktop-icon.svg';
import { useAppStore } from '../stores';

const DesktopTitleBar: React.FC = () => {
  const appTheme = useAppStore((state) => state.theme);
  const [desktopPlatform, setDesktopPlatform] = React.useState<string | null>(() => (
    typeof window === 'undefined' ? null : window.opsdogDesktop?.platform ?? null
  ));
  const [maximized, setMaximized] = React.useState<boolean>(() => (
    typeof window === 'undefined' ? false : window.opsdogDesktop?.getWindowState?.().maximized ?? false
  ));

  React.useEffect(() => {
    setDesktopPlatform(window.opsdogDesktop?.platform ?? null);
    const state = window.opsdogDesktop?.getWindowState?.();
    setMaximized(state?.maximized ?? false);
    return window.opsdogDesktop?.onWindowStateChanged?.((nextState) => {
      setMaximized(nextState.maximized);
    });
  }, []);

  if (!desktopPlatform) return null;

  return (
    <div className="desktop-titlebar" data-platform={desktopPlatform} data-mode={appTheme}>
      <div className="desktop-titlebar-brand">
        <img className="desktop-titlebar-logo" src={opsdogDesktopIcon} alt="" aria-hidden="true" />
        <span className="desktop-titlebar-name">OpsDog</span>
      </div>
      <div className="desktop-titlebar-controls" aria-label="窗口控制">
        <button
          type="button"
          className="desktop-titlebar-control"
          onClick={() => void window.opsdogDesktop?.minimizeWindow?.()}
          aria-label="最小化"
          title="最小化"
        >
          <Minus size={15} />
        </button>
        <button
          type="button"
          className="desktop-titlebar-control"
          onClick={() => void window.opsdogDesktop?.toggleMaximizeWindow?.()}
          aria-label={maximized ? '还原' : '最大化'}
          title={maximized ? '还原' : '最大化'}
        >
          {maximized ? <Copy size={13} /> : <Square size={13} />}
        </button>
        <button
          type="button"
          className="desktop-titlebar-control close"
          onClick={() => void window.opsdogDesktop?.closeWindow?.()}
          aria-label="关闭"
          title="关闭"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
};

export default DesktopTitleBar;
