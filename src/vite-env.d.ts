/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_RUNTIME?: 'web';
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  readonly opsdogDesktop?: {
    readonly platform: string;
    readonly minimizeWindow?: () => Promise<{ readonly ok: boolean; readonly error?: string }>;
    readonly toggleMaximizeWindow?: () => Promise<{ readonly ok: boolean; readonly error?: string }>;
    readonly closeWindow?: () => Promise<{ readonly ok: boolean; readonly error?: string }>;
    readonly getWindowState?: () => {
      readonly maximized: boolean;
      readonly focused: boolean;
    };
    readonly onWindowStateChanged?: (listener: (state: {
      readonly maximized: boolean;
      readonly focused: boolean;
    }) => void) => () => void;
  };
}
