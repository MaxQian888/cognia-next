---
title: ADR-0060 — Personal Knowledge Capture & Insights
description: "Records the four-phase delivery that borrows OpenWiki's best ideas into cognia: a higher-quality web reader (Jina + platform scrapers over the CORS-free Rust fetch), a no-AI Wiki Lint (orphan pages + broken [[links]]), an Attention Radar (7-dimension info-diet analysis over memories + captures, delivered through the desktop pet), and an OpenWiki-style content-capture confirm bubble that feeds the radar. Documents the reuse-first seams, the schema additions (Dexie v95–v97), and the Phase-4 desktop-native scoping."
---

# ADR-0060 — Personal Knowledge Capture & Insights

**Status**: Accepted (2026-07-02)
**Authors**: Max Qian + Claude

## Context

We studied [kdsz001/OpenWiki](https://github.com/kdsz001/OpenWiki) — a same-stack (Tauri + Rust + React + SQLite + multi-provider AI) personal-knowledge desktop app — for borrowable ideas. cognia was already stronger on wiki compilation, RAG, OCR, ingestion/dedup, and Twin distillation, so those were **not** copied. Four genuine gaps remained, delivered here as four independently-shippable phases (reuse-first; each ends green on the standard gates).

## Decisions

### Phase 1 — Web Reader quality (`lib/web/reader/`)

`web_fetch` + Twin URL ingest previously did shallow cheerio text extraction. We added a multi-tier reader, all behind an **injected `fetchImpl`** so it is CORS-free on desktop and degrades in the browser:

1. **Platform scrapers** keyed by hostname — WeChat (`#js_content`), X/Twitter (public FxTwitter API), YouTube (InnerTube `ytInitialPlayerResponse` → caption transcript). No yt-dlp.
2. **Jina Reader** (`r.jina.ai`) fallback — only when local extraction is empty/too thin (a JS-rendered SPA), so the common case never leaves the machine. **Off by default in the pure core**; the renderer host enables it.
3. **Local cheerio** extraction as the last resort.

Wiring: `lib/claude/plugin-tool-ipc.ts:resolveWebToolDeps` now sets `deps.fetchImpl` = `createProxyFetch()` (Tauri `proxy_http_request`) / `pinnedFetch` (Capacitor). Reused the existing Rust `proxy_http_request` (no new Rust). `htmlToMarkdown` was fixed to process inline elements before block elements (links inside `<p>` were being lost).

### Phase 2 — Wiki Lint (`lib/wiki/lint/`)

Nothing audited the `[[slug]]` links the CrossRefAgent inserts. A pure, no-AI pass reuses `findDeadLinks` (`cross-ref-agent.ts`) for broken links and `collectReferencedSlugs` for orphans (an article with zero inbound links; self-refs and the non-persisted index page don't count). Surfaced via a settings card + a scheduled `wiki-lint` executor. Runs on Dexie only (works in web mode).

### Phase 3 — Attention Radar (`lib/radar/`)

A periodic 7-dimension "info-diet" report (verdict / at-a-glance / info-diet / subconscious / graveyard / blind-spots / actions + topic cloud + locally-computed heatmap). **Data source: existing stores** — long-term memories (already redacted + importance-weighted) + Phase-4 captured items — pre-filtered with an OpenWiki-style importance→dedup→top-N pass. Every item passes `hasNoLeakingPii` before the model. LLM via the existing `buildUtilityLlmClient` + `extractJson`. **Delivery: the desktop pet** — a `use-pet-insight` teaser bubble on a fresh report + a full "Insights" tab in the pet console (`radar-panel.tsx`), with config/schedule folded into the panel (no new Settings-nav entry).

### Phase 4 — Content Capture (`lib/capture/`, `components/capture/`)

OpenWiki-style confirm bubble: clipboard watch → candidate → confirm bubble with a countdown → save + async enrichment (URL → Phase-1 reader, image → OCR) + source-app tag + SHA-256 dedup. Captured items feed the radar. First-party (not a plugin — plugins are sandboxed, no window creation, no free-text pet path). The confirm bubble is a first-party in-app component (`CaptureMount` in the app layout) driven by a small capture store; source-app comes from a new Rust `get_foreground_app` command.

**Scoping (Phase 4):** the separate always-on-top *transparent* capture window and the global-shortcut auto-listen were deferred — the in-app bubble delivers the confirm UX, and the clipboard-poll watcher delivers "capture on copy". `get_foreground_app` returns the foreground **window title** on Windows (proven `GetWindowTextW` path) and the frontmost **app name** via `osascript` on macOS; a precise Windows executable name needs extra `windows`-crate process features and is a follow-up.

## Schema

Append-only Dexie versions (one per phase): **v95** `wikiLintResults` (singleton per scope), **v96** `radarReports`, **v97** `capturedItems`. New settings: `AppSettings.attentionRadar` (`types/radar`), `AppSettings.capture` (`types/capture`), `ExternalBridgeSettings.wikiLintSchedule`.

## Consequences

- cognia gains a personal-knowledge loop (capture → enrich → insight) + wiki health, entirely reusing existing subsystems (web reader transport, OCR, memories, utility LLM, pet, scheduler).
- The radar is only as rich as the memory/capture stores; on a fresh install it self-skips (min-items guard).
- Follow-ups: an always-on-top transparent capture window + global-shortcut binding; precise Windows source-exe detection; image-clipboard capture; hybrid BM25+dense in `wiki_search`.
