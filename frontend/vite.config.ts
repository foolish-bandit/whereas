/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// PWA scope notes:
// - The service worker only caches the app shell and static assets
//   produced by Vite. API responses are NOT cached here; contract
//   data must continue to flow through the live request path with
//   org-scoped auth on every call.
// - The web manifest enables install-to-home-screen / standalone mode
//   without changing how the app boots in a normal browser tab.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      includeAssets: ["favicon.svg", "robots.txt"],
      manifest: {
        name: "Whereas",
        short_name: "Whereas",
        description: "Open-source contract lifecycle management",
        theme_color: "#111827",
        background_color: "#ffffff",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          {
            src: "/favicon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,ico,woff2}"],
        // Do not cache API responses. Contract data is org-scoped and
        // sensitive; serving a stale cached response across sessions
        // would silently weaken authorization.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
      },
    }),
  ],
  server: {
    port: 5173,
    host: "127.0.0.1",
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
