## Project Playbook

- Run locally with `npm run dev`.
- Build the web assets with `npm run build`.
- Package the macOS app with `npm run package:mac`.
- After backend or Doctor changes, smoke-test `http://127.0.0.1:5173/api/scan`.
- Preserve generated image assets and app icons unless the user explicitly asks to replace them.
- Generated images are move-only in the app; never add a cleanup path that deletes them.

## Done When

- `node --check server.mjs` passes after server edits.
- `git diff --check` passes.
- `npm run build` passes after UI or bundle changes.
- `npm run package:mac` passes after Electron, icon, or packaging changes.
