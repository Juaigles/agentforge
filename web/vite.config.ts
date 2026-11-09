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
    fs: { allow: ['..'] },
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
