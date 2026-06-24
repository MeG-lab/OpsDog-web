import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { getAppConfig } from "./appConfig.js";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const config = getAppConfig(env);

  return {
    plugins: [react(), tailwindcss()],
    clearScreen: false,
    server: {
      port: config.webPort,
      strictPort: false,
      host: config.webHost,
      proxy: {
        '/api': {
          target: config.serverOrigin,
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
});
