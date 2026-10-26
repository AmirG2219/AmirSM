import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  resolve: { alias: { '@shared': path.resolve(import.meta.dirname, '../shared') } },
  server: { port: 5300, proxy: { '/api': { target: 'http://127.0.0.1:4300', changeOrigin: false } } },
  build: { outDir: 'dist', emptyOutDir: true },
});
