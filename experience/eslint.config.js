import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules', 'public/runtime', 'test-results', 'playwright-report'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['error', { allow: ['error', 'warn'] }],
    },
  },
  {
    // Product code must never import the fixture adapter directly (only the runtime loader may).
    files: ['src/features/**/*.{ts,tsx}', 'src/renderer/**/*.{ts,tsx}', 'src/data/**/*.{ts,tsx}', 'src/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['**/fixture/**', '**/fixture'], message: 'Product code must go through RuntimeClient, never the fixture adapter.' }] }],
    },
  },
  {
    files: ['content/**/tools/*.ts', 'scripts/**/*.{js,mjs}', 'tests/**/*.{ts,tsx}'],
    rules: { 'no-console': 'off' },
  },
);
