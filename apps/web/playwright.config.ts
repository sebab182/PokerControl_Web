import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const TEMP = join(tmpdir(), 'pokercontrol');

export default defineConfig({
  testDir: './e2e',
  outputDir: `${TEMP}/pw-results`,
  reporter: [['list'], ['html', { outputFolder: `${TEMP}/pw-report`, open: 'never' }]],
  workers: 1,
  timeout: 30000,
  use: { baseURL: 'http://localhost:5174', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command: 'pnpm --filter @pokercontrol/api e2e-server',
      url: 'http://127.0.0.1:3100/health',
      cwd: '../..',
      reuseExistingServer: false,
    },
    {
      command: 'pnpm exec vite --port 5174 --strictPort',
      url: 'http://localhost:5174',
      env: { VITE_API_URL: 'http://127.0.0.1:3100', VITE_GOOGLE_CLIENT_ID: 'e2e' },
      reuseExistingServer: false,
    },
  ],
});
