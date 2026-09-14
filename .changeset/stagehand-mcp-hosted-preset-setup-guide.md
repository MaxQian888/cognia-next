---
"cognia-next": minor
---

The Stagehand Browser plugin now ships two MCP presets instead of one: the upstream-recommended hosted Streamable-HTTP endpoint (`stagehand-hosted` — no local Node.js, Browserbase covers the default Gemini model cost, API key sent as a vaulted `x-bb-api-key` header) alongside the self-hosted `npx @browserbasehq/mcp` preset, and `/stagehand` opens a proper setup guide modal (environment check, per-preset deep links into Settings → MCP Servers, `/stagehand hosted|local` focus args) instead of a toast. The plugin also gained its own en/zh-CN i18n bundle and declares the `extension:ui` + `shell:execute` permissions that flow requires.
