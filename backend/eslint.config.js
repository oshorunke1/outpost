import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist/**', 'coverage/**'] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      // In-memory fakes implement async interfaces without awaiting anything.
      '@typescript-eslint/require-await': 'off',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  { files: ['scripts/**/*.ts', 'src/cli/**/*.ts'], rules: { 'no-console': 'off' } },
  { files: ['**/*.js'], extends: [tseslint.configs.disableTypeChecked] },
);
