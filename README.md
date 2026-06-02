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

The app scans local Codex paths, shows the biggest session, log, cache, image, and memory buckets, and keeps risky actions guarded. `Speed Check` records a stable local readiness score using scan time, state DB latency, log DB latency, WAL size, active transcript size, stale threads, and oversized transcript counts; it also records a live timing score that accounts for current Codex process load, background terminal commands, subagent fan-out settings, MCP startup pressure, lifecycle hook load, automatic approval review, and memory-injection weight. Speed Proof history compares latest, best, trend, active-folder change, and live process-count change after cleanup. Hard Mode shows the score drivers, while Smart Optimize shows a conservative projected score lift before you run it. `Codex Doctor` adds a ranked Next Moves queue plus docs-informed guidance for local state, live Codex process load, background terminal work, subagent fan-out, MCP startup, lifecycle hooks, approval review, memory context, auth cache health, model/reasoning settings, Fast Mode, workflow context, trusted project playbooks, and task-size profiles such as Fast Lane, Small Tasks, and Deep Work. You can also run the official `codex doctor --json` check on demand; Refit summarizes the redacted report and offers safe copyable action snippets instead of slowing every scan. In Hard Mode, Doctor also shows durable config advice for shell snapshots, auth credential storage, the active service tier, approval flow, Goal Mode, memory use/generation, MCP startup health, lifecycle hook load, reusable AGENTS guidance, named profile files, project `AGENTS.md` and local-environment readiness, live helper pressure, background command pressure, concurrency pressure, trusted project count, enabled tool surface, subagent depth/thread caps, and a copyable Fix Kit for safe next steps. Destructive deletion actions stay locked until you switch to Hard Mode and enable `Deletes On`. SQLite state changes create backups under the app data directory.

`Smart Optimize` builds a plan from the current scan. `Safe` runs non-destructive cleanup first: move archived transcripts out of active sessions, archive stale thread rows, compact state, prune/checkpoint logs with a backup, clear crash dumps, and clean rebuildable browser caches. `Recover Space` can delete old archived conversations and old Refit backups after the selected age, but only after deletes are explicitly allowed. `Full Pass` can also move older generated-image folders from `~/.codex/generated_images` to `~/.codex/archived_generated_images`; generated images are never deleted by Codex Refit.

## Codex Speed Playbook

Codex Refit checks three kinds of speed pressure:

- Local state: active transcripts, archived pointers still sitting in active sessions, SQLite log/WAL size, crash dumps, and rebuildable browser caches.
- Runtime and config: official Doctor findings, CLI/app version drift, live app-server/helper load, background terminal commands, subagent depth/thread fan-out, MCP/plugin startup surface, lifecycle hook load, approval flow and auto-review mode, memory context settings/storage, auth cache metadata, Fast Mode eligibility, model and reasoning effort, shell snapshot, web search mode, and trusted project entries.
- Workflow context: empty or missing global/project `AGENTS.md`, missing `.codex` local setup/actions, overly broad concurrent threads, and task/model mismatch.

The app does not silently rewrite Codex config or inspect auth token contents. It surfaces the next move and copyable snippets so you can decide whether to run cleanup, close idle Codex threads and terminals, inspect background work with `/ps`, stop obsolete background terminal work with `/stop`, cap subagent fan-out, review MCP servers with `/mcp verbose`, review lifecycle hooks with `/hooks`, review approval flow, review memories, refresh login with `codex doctor`/`codex login`, fix terminal/auth/update/MCP findings from the official Doctor report, create a named `speed.config.toml` profile, add a project playbook, switch model/effort for a small task, check `/fast status`, align CLI/app versions, remove stale trusted paths, or add concise AGENTS guidance. This follows the Codex manual guidance that `codex doctor` can check config/auth/runtime health, login details are cached in `auth.json` or an OS credential store, `gpt-5.5` is best for complex work, `gpt-5.4-mini` is faster for lighter coding, Codex-Spark is a near-instant iteration model when available, project local environments can define worktree setup scripts and common actions, Fast Mode can accelerate supported models at higher credit use, shell snapshots speed repeated command setup, configured MCP servers launch when a session starts, required MCP servers can fail startup if initialization breaks, automatic approval review can add model calls for eligible interactive approvals, `/ps` shows background terminals, `/stop` stops background terminals, matching hooks from multiple files can all run, turn/tool-scope hooks can add latency around frequent actions, `/hooks` shows loaded hook sources, `agents.max_threads` defaults to 6, `agents.max_depth` defaults to 1, raising subagent depth can increase token use, latency, and local resource consumption, memories can inject useful local context into future sessions, and empty AGENTS files are skipped.

The imagegen concept comp lives at `public/design-comps/codex-refit-interface-concept.png`.
The generated menu bar icon source lives at `public/app-icons/codex-refit-menubar-source.png`, with transparent app assets in `public/app-icons/` and white-only tray-sized PNGs in `electron/`.
