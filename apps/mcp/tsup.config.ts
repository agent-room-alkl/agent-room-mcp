import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node18',
  outDir: 'dist',
  clean: true,
  sourcemap: false,
  // Bundle workspace packages so the published package is self-contained
  noExternal: ['@agent-room/shared', '@agent-room/upstash-client'],
});
