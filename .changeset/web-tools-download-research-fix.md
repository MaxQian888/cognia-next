---
"cognia-next": patch
---

Fix the Web Tools plugin: `web_download` no longer writes 0-byte files on desktop — it now routes through the host `network:download` gateway, which streams real bytes into the plugin's data sandbox with traversal-safe paths (model-supplied `filename`/`directory` are sanitized or refused). The tool fails honestly on mobile instead of silently dropping the download. `web_research` is now actually tool-enabled (`allowedTools` previously did nothing on the text channel), distills each source against the query, forwards the caller's abort signal/session for cancellation and billing, returns the raw text when structured parsing fails, collapses run failures into the `{ok:false}` envelope, and reports unreachable sources separately from fetched ones. The manifest now describes only the tools it registers, declares the `userAgent`/`downloadDirectory` settings, and marks mobile as degraded.
