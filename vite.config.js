import { defineConfig } from 'vite';

export default defineConfig({
  // Relative URLs work locally and below GitHub Pages' /Kartenpause/ path.
  base: './',
  build: {
    outDir: 'dist'
  }
});
