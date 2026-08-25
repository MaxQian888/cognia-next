---
"cognia-next": minor
---

Adds RepoWiki, a Python plugin that generates a browsable wiki for any repository.

Point it at a folder you have open or at a git URL and it produces an overview, a page per module, a Mermaid dependency diagram, a reading order ranked by PageRank over the real import graph, and cited search across both the code and the prose it wrote. `since` re-analyses only the modules whose files changed. Exports to markdown, JSON, or one self-contained HTML file that makes no external request and runs no script.

The generator is vendored from [RepoWiki](https://github.com/he-yufeng/RepoWiki) (MIT) with its algorithms and tests intact. Three layers were replaced so it runs as a plugin rather than as a command-line tool: model calls go through the host's agent API instead of the user's provider key, its two SQLite files land in the plugin's own data directory instead of `~/.repowiki`, and file enumeration goes through the workspace API — so `.gitignore` is honoured, credential files are never handed over, and a clone gets the host's guard rails.
