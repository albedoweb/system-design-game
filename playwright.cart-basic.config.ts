import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/** GC-B02 real-browser/real-Worker acceptance on the dedicated port 5294. */
export default defineConfig({
  testDir: './tests/cart-basic',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  // Generated Playwright output stays outside the Git worktree.
  outputDir: join(tmpdir(), 'gc-b02-playwright-results'),
  use: {
    baseURL: 'http://127.0.0.1:5294',
    screenshot: 'off',
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: 'npx vite --host 127.0.0.1 --port 5294 --strictPort',
    url: 'http://127.0.0.1:5294',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
