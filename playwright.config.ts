import { defineConfig, devices } from "@playwright/test";

/**
 * Runs against `npm run build && npm run start` (prod build), not `next dev`.
 * This project's own established finding (see AGENTS.md) is that dev-mode
 * Turbopack/Strict Mode double-invocation was ruled out as a cause for real
 * bugs found during manual verification, so prod-build testing is the
 * reliable signal — the dev server is not used here on purpose.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "html",
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run build && npm run start",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
