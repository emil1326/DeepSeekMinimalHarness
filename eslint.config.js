import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'legacy/**', '**/*.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      // `!= null` is the cheap way to catch both null and undefined, and it is
      // what the intent is everywhere it appears here.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
    },
  },
  {
    // The preview script, the probe rig and the test fixtures that stand in for a
    // worker are plain Node, not TypeScript, so they need their globals.
    files: ['tools/**/*.mjs', 'probes/**/*.mjs', '**/tests/fixtures/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        TextDecoder: 'readonly',
        AbortSignal: 'readonly',
        performance: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
      },
    },
  },
  {
    files: ['packages/ui/**/*.tsx', 'packages/ui/**/*.ts'],
    rules: {
      // React JSX with the automatic runtime does not need React in scope.
      'no-undef': 'off',
    },
  },
);
