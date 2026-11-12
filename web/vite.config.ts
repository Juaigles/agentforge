import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

const apiTarget = process.env.AGENTFORGE_API ?? 'http://127.0.0.1:4310';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // El frontend habla con la API a través de este proxy: mismo origen, sin CORS.
    proxy: { '/api': { target: apiTarget, changeOrigin: false } },
    // Solo el frontend y el código compartido: nunca la carpeta de datos (clave maestra y base de datos).
    fs: { allow: ['.', '../shared', '../node_modules'], deny: ['**/data/**', '**/.env*', '**/*.key', '**/*.db'] },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
    // `npm run test:coverage`. Se cuentan también los archivos que ningún test importa (si no, el porcentaje
    // saldría inflado). Las vistas grandes se prueban sobre todo en la suite e2e, que aquí no cuenta.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,vue}'],
      exclude: ['src/test/**', 'src/main.ts', 'src/env.d.ts', 'src/**/*.test.ts', 'src/i18n/es/**', 'src/i18n/en/**'],
      reporter: ['text-summary', 'html', 'lcov'],
      reportsDirectory: './coverage',
      thresholds: { statements: 37, branches: 40, functions: 39, lines: 39 },
    },
  },
});
