import { defineConfig, devices } from '@playwright/test';

// Chrome/Chromium only — matches the project's stated primary browser
// target. Used both for pixel-level rendering acceptance tests
// (tests/acceptance) and the end-to-end smoke test (tests/e2e).
export default defineConfig({
  testDir: 'tests',
  testMatch: ['**/*.spec.ts'],
  fullyParallel: true,
  reporter: 'list',
  use: {
    browserName: 'chromium'
  },
  webServer: {
    command: 'npm run dev -- --port 4173 --strictPort',
    port: 4173,
    reuseExistingServer: !process.env.CI
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } }
  ]
});
