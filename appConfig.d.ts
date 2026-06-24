export interface AppConfig {
  webOrigin: string;
  webHost: string;
  webPort: number;
  serverOrigin: string;
  serverHost: string;
  serverPort: number;
  apiBaseUrl: string;
}

export function getAppConfig(env?: Record<string, string>): AppConfig;
