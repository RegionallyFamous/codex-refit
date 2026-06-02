# Codex Refit

A local starship-console maintenance dashboard and macOS menu bar app for large Codex state folders. It opens in Easy Mode with one `Smart Optimize` button and a `Speed Check` benchmark. Hard Mode reveals the manual controls.

Run it in the browser with:

```sh
npm run dev
```

Build and run it as a local macOS app with:

```sh
npm run package:mac
open "release/Codex Refit.app"
```

The app scans local Codex paths, shows the biggest session, log, cache, and image buckets, and keeps risky actions guarded. `Speed Check` records a local readiness score using scan time, state DB latency, log DB latency, WAL size, active transcript size, stale threads, and oversized transcript counts. `Codex Doctor` adds a ranked Next Moves queue plus docs-informed guidance for local state, model/reasoning settings, Fast Mode, workflow context, and task-size profiles such as Small Tasks, Fast Mode, and Deep Work. In Hard Mode, Doctor also shows durable config advice for shell snapshots, the active service tier, Goal Mode, reusable AGENTS guidance, concurrency pressure, trusted project count, enabled tool surface, and a copyable Fix Kit for safe next steps. Destructive deletion actions stay locked until you switch to Hard Mode and enable `Deletes On`. SQLite state changes create backups under the app data directory.

`Smart Optimize` builds a plan from the current scan. `Safe` runs non-destructive cleanup first: move archived transcripts out of active sessions, archive stale thread rows, compact state, prune/checkpoint logs with a backup, clear crash dumps, and clean rebuildable browser caches. `Recover Space` can delete old archived conversations and old Refit backups after the selected age, but only after deletes are explicitly allowed. `Full Pass` can also move older generated-image folders from `~/.codex/generated_images` to `~/.codex/archived_generated_images`; generated images are never deleted by Codex Refit.

## Codex Speed Playbook

Codex Refit checks three kinds of speed pressure:

- Local state: active transcripts, archived pointers still sitting in active sessions, SQLite log/WAL size, crash dumps, and rebuildable browser caches.
- Runtime and config: CLI/app version drift, Fast Mode eligibility, model and reasoning effort, shell snapshot, approval flow, web search mode, trusted project entries, and MCP/plugin surface.
- Workflow context: empty or missing `AGENTS.md`, overly broad concurrent threads, and task/model mismatch.

The app does not silently rewrite Codex config. It surfaces the next move and, in Hard Mode, copyable snippets so you can decide whether to run cleanup, switch model/effort for a small task, check `/fast status`, align CLI/app versions, remove stale trusted paths, or add concise AGENTS guidance. This follows the Codex manual guidance that `gpt-5.5` is best for complex work, `gpt-5.4-mini` is faster for lighter coding, Fast Mode can accelerate supported models at higher credit use, shell snapshots speed repeated command setup, and empty AGENTS files are skipped.

The imagegen concept comp lives at `public/design-comps/codex-refit-interface-concept.png`.
The generated menu bar icon source lives at `public/app-icons/codex-refit-menubar-source.png`, with transparent app assets in `public/app-icons/` and white-only tray-sized PNGs in `electron/`.
