import { defineConfig } from 'vite';

export default defineConfig({
  // Relative URLs work locally and below GitHub Pages' /Kartenpause/ path.
  base: './',
  // Worker-only imports must be optimized before the first edit; discovering
  // them lazily can reload the page and discard an in-progress drawing.
  optimizeDeps: {
    include: [
      'io/GeoJSONReader', 'io/GeoJSONWriter', 'operation/polygonize/Polygonizer',
      'operation/union/UnaryUnionOp', 'operation/valid/IsValidOp',
      'algorithm/RobustLineIntersector', 'algorithm/InteriorPointArea',
      'algorithm/PointLocation', 'geom/Coordinate', 'geom/Envelope', 'index/strtree/STRtree'
    ].map(path => `jsts/org/locationtech/jts/${path}.js`)
  },
  build: {
    outDir: 'dist'
  }
});
