const parser = require('@typescript-eslint/parser');
const typescript = require('@typescript-eslint/eslint-plugin');
const rxjs = require('eslint-plugin-rxjs');

module.exports = [
  { ignores: ['dist/**'], linterOptions: { noInlineConfig: true } },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parser,
      parserOptions: { project: './tsconfig.json', tsconfigRootDir: __dirname },
    },
    plugins: { '@typescript-eslint': typescript, rxjs },
    rules: {
      'no-debugger': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', {
        'ts-ignore': true, 'ts-expect-error': true, 'ts-nocheck': true,
      }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { args: 'none' }],
      'rxjs/no-async-subscribe': 'error',
      'rxjs/no-exposed-subjects': 'error',
      'rxjs/no-ignored-error': 'error',
      'rxjs/no-ignored-subscription': 'error',
      'rxjs/no-internal': 'error',
      'rxjs/no-nested-subscribe': 'error',
      'rxjs/prefer-observer': 'error',
    },
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    ignores: ['src/main.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: 'CallExpression[callee.name=/^(setTimeout|setInterval)$/]', message: 'Use o SchedulerLike injetado.' },
        { selector: 'CallExpression[callee.property.name=/^(setTimeout|setInterval)$/]', message: 'Use o SchedulerLike injetado.' },
        { selector: 'ImportDeclaration[source.value=/^(node:)?timers(\\/promises)?$/]', message: 'Use o SchedulerLike injetado.' },
        { selector: 'CallExpression[callee.object.name="Date"][callee.property.name="now"]', message: 'Use o Clock injetado.' },
        { selector: 'NewExpression[callee.name="Date"]', message: 'Use o Clock injetado.' },
        { selector: 'CallExpression[callee.object.name="process"][callee.property.name="exit"]', message: 'Descarte os recursos do processo.' },
        { selector: 'CallExpression[callee.property.name="tap"] ArrowFunctionExpression[async=true]', message: 'Use um callback síncrono em tap.' },
        { selector: 'CallExpression[callee.name="tap"] > :function[async=true]', message: 'Use um callback síncrono em tap.' },
      ],
    },
  },
];
