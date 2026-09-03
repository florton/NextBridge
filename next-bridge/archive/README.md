# Archive — historical iterations

Design history for Next Bridge, kept for reference only. **Not shipped** in the
npm package (the `files` allowlist in the root `package.json` publishes only
`next-bridge/src/`) and **not** part of the typecheck (the root `tsconfig.json`
includes `next-bridge/src`, `next-bridge/demo12` and `next-bridge/test` by name,
so this folder is left out).

- `suss0.ts` … `suss11.tsx` — successive library prototypes (v0 was Zustand-based;
  v8 used `useState`; v11 was the pre-rewrite Pub/Sub monolith).
- `demo0.tsx` … `demo11.tsx` — matching usage examples (multiple app files
  crammed into one per file, for documentation).
- `v11README.md` — the README as of v11.
- `finalthoughts.txt` — the pre-rewrite checklist. Its items are resolved in the
  current README's "Design notes — v11 → v12" table.

The current library is `src/core.ts` + `src/client.tsx`; the current example is
`demo12/`.
