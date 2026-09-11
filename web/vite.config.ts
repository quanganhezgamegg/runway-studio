import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Dev: Vite chay o 5173, proxy /api va /catalog.json sang Express o 3000.
// Build: xuat ra ../public/dist de Express phuc vu trong production.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/catalog.json': 'http://localhost:3000',
      '/outputs': 'http://localhost:3000',
    },
  },
  build: {
    outDir: resolve(__dirname, '../public/dist'),
    emptyOutDir: true,
  },
});
