import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: process.env.CI ? `npx next start -p ${PORT}` : `npx next dev -p ${PORT}`,
      url: `http://localhost:${PORT}/api/session`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // The WebSocket service (presence, cursors, typing, live notifications).
      command: "npx tsx realtime/main.ts",
      url: "http://localhost:3001/health",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
