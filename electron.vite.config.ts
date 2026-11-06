// SPDX-License-Identifier: AGPL-3.0-only
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

const alias = { '@shared': resolve('src/shared') };

export default defineConfig({
  main: {
    // Keeps package.json dependencies (7zip-bin, zod) external: 7zip-bin ships a native binary that must stay on disk.
    build: { externalizeDeps: true },
    resolve: { alias },
  },
  preload: {
    // Sandboxed preloads can't be ES modules: emit CommonJS as out/preload/index.cjs.
    build: {
      externalizeDeps: true,
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
    resolve: { alias },
  },
  renderer: {
    resolve: { alias },
    plugins: [react()],
  },
});
