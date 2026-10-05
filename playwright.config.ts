import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
/** Realtime service port. Override to run alongside something already on :3001 (e.g. the Docker stack). */
const REALTIME_PORT = Number(process.env.E2E_REALTIME_PORT ?? 3001);
const realtimeEnv = { REALTIME_PORT: String(REALTIME_PORT), NEXT_PUBLIC_REALTIME_URL: `ws://localhost:${REALTIME_PORT}/ws` };

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: process.env.CI ? `npx next start -p ${PORT}` : `npx next dev -p ${PORT}`,
      url: `http://localhost:${PORT}/api/session`,
      // NEXT_PUBLIC_* is inlined at build time: with CI=1, build with the same E2E_REALTIME_PORT.
      env: realtimeEnv,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // The WebSocket service (presence, cursors, typing, live notifications).
      command: "npx tsx realtime/main.ts",
      url: `http://localhost:${REALTIME_PORT}/health`,
      env: realtimeEnv,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
