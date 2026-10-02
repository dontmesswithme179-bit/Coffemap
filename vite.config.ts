import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build works on GitHub Pages under /<repo>/.
  base: './',
  // MapLibre resolves its worker via import.meta.url; pre-bundling would break that path.
  optimizeDeps: { exclude: ['maplibre-gl'] },
  // MapLibre's worker is an ES module worker.
  worker: { format: 'es' },
  build: { chunkSizeWarningLimit: 1500 },
});
