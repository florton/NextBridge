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
    // Its own config so only this bundle gets the client directive. No
    // `treeshake` here: tsup's rollup pass strips the banner (esbuild's own
    // ESM shaking still drops the server half of stream.ts).
    entry: { react: 'react.tsx' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    external: ['react'],
    banner: { js: "'use client';" },
  },
]);
