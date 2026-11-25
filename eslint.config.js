import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'coverage/'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    rules: {
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always'],
      'object-shorthand': 'error',
      'no-console': 'off',
    },
  },
  // Server, scripts and tests run on Node.
  {
    files: ['src/**', 'scripts/**', 'test/**', '*.js'],
    languageOptions: { globals: globals.node },
  },
  // The dashboard runs in the browser (ES modules, no build step).
  { files: ['public/**'], languageOptions: { globals: globals.browser } },
  // theme.js is a classic <script> that must run before first paint.
  {
    files: ['public/assets/js/theme.js'],
    languageOptions: { sourceType: 'script' },
    rules: { 'no-var': 'off' },
  },
];
