import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// En WSL, los discos de Windows (/mnt/c) no emiten eventos de archivos: Vite tiene que sondear.
const onWindowsDrive = realpathSync(process.cwd()).startsWith('/mnt/');

export default defineConfig({
  plugins: [react()],
  envDir: '../..',
  server: {
    port: 5173,
    strictPort: true,
    watch: onWindowsDrive ? { usePolling: true, interval: 300 } : undefined,
  },
  cacheDir: join(tmpdir(), 'pokercontrol', 'vite-cache'),
});
