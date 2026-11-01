import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The dashboard only ever talks to the operator plane under /ops. In development the dev server
// forwards those requests to the API, so the browser sees ONE origin: no CORS to configure, and
// no API key ever leaves the page for a different site.
const apiTarget = process.env.VITE_API_PROXY_TARGET ?? "http://localhost:3000";

export default defineConfig({
  // The dashboard lives under /dashboard/ so that, behind the gateway, ONE origin can serve both
  // the app (/dashboard/...) and the API (/jobs, /ops, ...) without their paths colliding.
  base: "/dashboard/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/ops": { target: apiTarget } },
  },
  preview: {
    port: 4173,
    proxy: { "/ops": { target: apiTarget } },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    css: false,
    restoreMocks: true,
  },
});
