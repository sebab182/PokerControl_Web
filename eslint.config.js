import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'db/migrations/**', '**/playwright-report/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
