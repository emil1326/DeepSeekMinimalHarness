import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built straight into the daemon, which serves it, so `dsh ui` is the only way in.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../daemon/dist/public',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    proxy: { '/api': 'http://127.0.0.1:1' },
  },
});
