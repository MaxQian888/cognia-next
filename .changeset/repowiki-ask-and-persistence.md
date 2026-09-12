---
"cognia-next": minor
---

RepoWiki plugin: wikis now survive a host restart — the assembled wiki snapshot and search index persist to `wiki.db`/`indexes.db`, and panels, search, and the new grounded-Q&A tools work on restored snapshots (marked with a "Snapshot" badge and a rescan path back to live files). New tools: `repowiki_ask` (one-shot cited Q&A with query expansion), `repowiki_deep_research` (multi-round investigation), and `repowiki_codemap` (verbatim-cited step-by-step guides that persist as wiki pages). Retrieval is now hybrid: chunks carry `ctx.ai.embed` vectors as a third score beside TF-IDF/BM25, degrading to lexical when no embedding provider answers. Also adds `repowiki_delete`, include/exclude file filters on scans, rescan-by-source for URL-ingested repos, and optional `projectId` on the read tools.
