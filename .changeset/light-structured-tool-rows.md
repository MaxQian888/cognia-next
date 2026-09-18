---
"cognia-next": minor
---

Render every remaining tool call — WebFetch, WebSearch, wiki/RAG/runtime queries, plan signals, spawn-task, computer-use, workflow proposals, plugin and unknown MCP tools — as the same compact inline row used by Bash and file tools, replacing the nested generic card chrome. The generic fallback body now renders bounded `input`/`output`/`error` blocks in the same theme-matched chrome instead of prose-scale "Parameters"/"Result" sections. WebFetch and WebSearch bodies are surface-free: a quote-rail answer, favicon/domain source rows with single-line snippets, and a left-railed prose body with redirect notice, content-type-aware rendering, and a faded clamp instead of filled cards.
