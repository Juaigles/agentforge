// ESLint (configuración plana): TypeScript en todo el repositorio y Vue en el frontend. El formato lo decide
// Prettier (`npm run format`); aquí solo van reglas de corrección.
import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import pluginVue from 'eslint-plugin-vue';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', 'data/**', 'e2e/.results/**', 'e2e/.report/**', 'presentacion/**', '**/*.d.ts'],
  },
  {
    files: ['**/*.{ts,vue,js,mjs}'],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: {
      // Los parámetros y variables que empiezan por «_» son intencionadamente no usados.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      // `any` se usa en las fronteras con datos sin tipar (JSON de proveedores, cuerpos de la API en los tests).
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-empty': ['error', { allowEmptyCatch: false }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
      'prefer-const': 'error',
    },
  },
  // Servidor, pruebas y utilidades: Node.
  {
    files: ['server/**/*.ts', 'shared/**/*.ts', 'e2e/**/*.ts', 'scripts/**/*.mjs', '*.{js,ts,mjs}', 'web/vite.config.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  // Frontend: navegador y componentes de Vue con TypeScript dentro.
  {
    files: ['web/src/**/*.{ts,vue}'],
    extends: [...pluginVue.configs['flat/recommended']],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'] },
    },
    rules: {
      // El contenido que se pinta con v-html pasa siempre por `renderMarkdown` (marked + DOMPurify), con su test.
      'vue/no-v-html': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/require-default-prop': 'off',
    },
  },
  // Los tests del frontend arrancan el servidor real dentro del proceso: también usan Node.
  {
    files: ['web/src/**/*.test.ts', 'web/src/test/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  eslintConfigPrettier,
);
