import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'index.ts', server: 'server.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: true, // index and server share the core chunk
    treeshake: true,
  },
  {
    // Its own config so the client directive survives: no `treeshake`,
    // because tsup's rollup pass strips directives (esbuild's own ESM shaking
    // still drops the server half of stream.ts). esbuild preserves the source
    // file's own 'use client' at the top of the bundle — no banner needed,
    // and scripts/assert-use-client.mjs fails the build if that ever changes.
    entry: { react: 'react.tsx' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    external: ['react'],
  },
]);
