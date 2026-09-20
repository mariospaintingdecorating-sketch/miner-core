import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';
import { createMinerViteConfig } from './vite.config';

// Compiled tests are not independent test cases. Count/run source tests once.
export default mergeConfig(createMinerViteConfig({}), defineConfig({
  test: { exclude: [...configDefaults.exclude, 'dist-electron/**', 'release/**'] },
}));
