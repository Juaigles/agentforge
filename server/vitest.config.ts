import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    pool: 'forks',
    // `npm run test:coverage`. Los umbrales están un par de puntos por debajo de lo medido: evitan retrocesos.
    coverage: {
      provider: 'v8',
      // `shared/` queda fuera de la raíz del paquete, pero es código que ejecuta el servidor.
      include: ['src/**/*.ts', '../shared/**/*.ts'],
      exclude: ['src/index.ts'],
      allowExternal: true,
      reporter: ['text-summary', 'html', 'lcov'],
      reportsDirectory: './coverage',
      thresholds: { statements: 92, branches: 84, functions: 93, lines: 94 },
    },
  },
});
