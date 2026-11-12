import { defineConfig, devices } from '@playwright/test';

// Suite end-to-end: tres motores (Chromium, Firefox y WebKit) contra el servidor real (ver e2e/support/fixtures.ts).
// Un solo worker: los tests comparten un servidor y un modelo simulado con estado, así que los proyectos se
// ejecutan uno detrás de otro. `npm run test:e2e` lanza solo Chromium; `npm run test:e2e:all`, los tres.
const viewport = { width: 1440, height: 900 };

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  outputDir: './e2e/.results',
  fullyParallel: false,
  workers: 1,
  // En CI un fallo se repite una vez y la traza del reintento queda en el informe; en local, ninguno se oculta.
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: './e2e/.report', open: 'never' }]],
  use: {
    locale: 'es-ES',
    colorScheme: 'light',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport } },
  ],
});
