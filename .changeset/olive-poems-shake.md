---
"cognia-next": minor
---

Chat rendering: keep streaming and finalised markdown visually identical, fix image layout shift, share one lightbox per message, and let plugins render their own tool results.

- Images, tables, GitHub alerts and task lists now render the same while a reply streams as they do once it finishes, so a turn no longer re-lays-out when it completes. `<details>` and `<kbd>` reach the shared renderer too, but only through markdown syntax: raw HTML still waits for the finalised branch, because parsing it per token would put `rehype-raw` on the streaming path.
- Images reserve their space while loading (the loading skeleton was previously invisible and the page shifted when an image landed), hint the browser to decode asynchronously, and no longer print alt text as a visible caption.
- Every image in a message — markdown, attachments, tool screenshots — opens in one lightbox you can page through, and optical-compaction archive frames are now zoomable.
- New `tool-renderer` plugin capability: a plugin that ships an MCP tool can contribute the result card for it, via `manifest.toolRenderers[]` or `ctx.toolResult.registerToolResultRenderer()`.
