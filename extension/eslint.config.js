// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Extension lint surface: app/lib/entrypoints/tests only.
 * Build output, WXT generated files, and probe tools stay out of CI noise.
 */
export default tseslint.config(
  {
    ignores: [
      'output/**',
      '.output/**',
      '.wxt/**',
      'node_modules/**',
      'test-results/**',
      'playwright-report/**',
      'tools/**',
      '**/*.mjs',
      'vitest.config.ts',
      'playwright.config.ts',
      'wxt.config.ts',
      'eslint.config.js',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    rules: {
      // Browser-extension / WXT patterns.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'prefer-const': 'error',
      'eqeqeq': ['error', 'smart'],
    },
  },
  {
    // E2E talks to chrome.* via page/SW evaluate; any is unavoidable at boundaries.
    // Playwright fixtures use `async ({}, use)` when no parent fixtures are needed.
    files: ['e2e/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-empty-pattern': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
);
