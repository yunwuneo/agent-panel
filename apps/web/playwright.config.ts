import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: "../../.local/web-e2e-results",
  reporter: "list",
  use: {
    browserName: "chromium",
    channel: "chrome",
    headless: true,
    viewport: { width: 1440, height: 980 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
