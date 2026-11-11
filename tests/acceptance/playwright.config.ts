import { resolve } from 'node:path';

import { defineConfig, devices } from '@playwright/test';

const artifactDir = resolve(
  process.cwd(),
  process.env.ACCEPTANCE_ARTIFACT_DIR ?? 'test-results/acceptance',
);

export default defineConfig({
  testDir: './browser',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 360_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    ['json', { outputFile: resolve(artifactDir, 'playwright-report.json') }],
  ],
  outputDir: resolve(artifactDir, 'playwright'),
  use: {
    baseURL: process.env.ACCEPTANCE_BASE_URL ?? 'http://127.0.0.1:5190',
    actionTimeout: 10_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
  },
});
