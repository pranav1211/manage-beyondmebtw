// Minimal ESLint flat config (ESLint 9). Dependency-light: no shareable config
// package required. Catches undefined refs and unused vars without being noisy.

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'apps/manage/dist/**',
      'data/**',
      'content/**',
      'coverage/**'
    ]
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        // Node
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        fetch: 'readonly',
        structuredClone: 'readonly',
        AbortSignal: 'readonly',
        // Browser (apps/manage)
        document: 'readonly',
        window: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': 'warn',
      'no-undef': 'error',
      'no-var': 'error',
      'prefer-const': 'warn'
    }
  }
];
