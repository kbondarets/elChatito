import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Фронтенд живёт в папке client, но сборка кладётся в dist,
// который раздаёт наш бэкенд (server/index.js) в "боевом" режиме.
export default defineConfig({
  root: 'client',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    // В режиме разработки запросы /api уходят на бэкенд (порт 3000),
    // чтобы ключ и логика жили только на сервере.
    proxy: {
      '/api': 'http://127.0.0.1:3000',
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
