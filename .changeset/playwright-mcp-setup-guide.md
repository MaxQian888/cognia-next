---
"cognia-next": minor
---

Playwright Browser plugin rework: `/browser` now opens a localized (en/zh-CN) setup guide modal that compares all four Playwright MCP modes — the static `playwright` and `playwright-existing-browser` presets plus two new plugin-contributed ones, `playwright-isolated` (disposable in-memory profile, `--isolated --headless`) and `playwright-cdp` (attach to a Chrome/Edge you launched with `--remote-debugging-port`) — and deep-links each card into Settings → MCP Servers via the `?preset=` param. The modal can verify `node`/`npx` availability through a shell-allowlisted environment check. Plugin-contributed MCP presets now also surface in Discover: the overlay registry gained a revision/subscribe stream and the discover query reads the merged catalog.
