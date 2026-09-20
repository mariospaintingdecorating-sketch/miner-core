import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import { createMinerViteConfig } from './vite.config';

// Vite's default transformer filter omits .cts; Electron's NodeNext build
// correctly compiles these helpers to .cjs. Exercise the same source in tests.
export default defineConfig(({ mode }) => ({
  ...createMinerViteConfig(loadEnv(mode, process.cwd(), '')),
  oxc: { include: /\.[cm]?[jt]sx?$/ },
}));
