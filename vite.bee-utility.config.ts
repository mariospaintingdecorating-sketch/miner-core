import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'src/mining/bee/BeeMiningUtilityWorker.ts',
    outDir: 'dist-electron',
    emptyOutDir: false,
    minify: false,
    rollupOptions: {
      external: ['electron', '@teamgosh/bee-sdk'],
      output: {
        entryFileNames: 'beeMiningUtilityWorker.js',
      },
    },
  },
});
