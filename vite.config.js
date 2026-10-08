import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages serves the project site from /ts-to-mp4/; keep dev at the root.
export default defineConfig({
  base: process.env.NODE_ENV === 'production' ? '/ts-to-mp4/' : '/',
  plugins: [react()],
  server: {
    // Reachable over the tailnet via `tailscale serve` (Host = <node>.ts.net).
    allowedHosts: ['.ts.net', 'localhost', '127.0.0.1'],
  },
  // ffmpeg.wasm spins up its own worker; pre-bundling breaks it.
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
});
