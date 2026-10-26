import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// API_PORT / WEB_PORT let a second dev instance run beside the default one (defaults: 4300 / 5300).
const apiPort = process.env.API_PORT ?? '4300';
const webPort = Number(process.env.WEB_PORT ?? '5300');

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  resolve: { alias: { '@shared': path.resolve(import.meta.dirname, '../shared') } },
  server: { port: webPort, proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } } },
  build: { outDir: 'dist', emptyOutDir: true },
});
