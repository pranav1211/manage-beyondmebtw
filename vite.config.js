import { defineConfig } from 'vite';

// Single root config. The frontend app lives under apps/manage/.
// Vanilla JS/HTML/CSS + ES modules — no framework.
export default defineConfig({
  root: 'apps/manage',
  server: {
    port: 5180,
    // Dev proxy so the frontend talks only to the Manage API (never Argus).
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:7100',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
