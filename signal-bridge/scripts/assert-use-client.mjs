// Guards the invariant the react entry depends on: dist/react.js must open
// with a 'use client' directive, or Next treats the whole entry as server
// code and every hook import breaks. esbuild preserves the source directive
// today; this catches the bundler config or version change that stops it.
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../dist/react.js', import.meta.url), 'utf8');
const firstLine = source.split('\n', 1)[0].trim();

if (!/^['"]use client['"];?$/.test(firstLine)) {
  console.error(
    `dist/react.js must start with a 'use client' directive, found: ${JSON.stringify(firstLine)}`,
  );
  process.exit(1);
}
console.log("dist/react.js: 'use client' directive verified.");
