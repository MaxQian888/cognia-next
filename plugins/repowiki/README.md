# RepoWiki

Generates a browsable wiki for a repository: an overview, a per-module page, a
Mermaid dependency diagram, a reading order ranked by PageRank over the real
import graph, and cited search across both the code and the generated prose.

Written in Python, running in Cognia's Python plugin host.

## Provenance

`repowiki/` is vendored from [RepoWiki](https://github.com/he-yufeng/RepoWiki)
(MIT, © 2026 Yufeng He) — see `LICENSE.upstream`. The algorithms are upstream's
and unchanged: the scanner's filters, the dependency graph, the analyzer's
passes and prompts, the BM25 + TF-IDF retrieval, the chunker, the exporters.

Three layers were replaced, all of them behind `repowiki/host.py`:

| Layer       | Upstream                                           | Here                                                        | Why                                                                                                                                                                                                                                                                                                  |
| ----------- | -------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model calls | `litellm.acompletion` with the user's provider key | `ctx.agent.run`                                             | The host owns provider routing, the PII gate, cost accounting and trace spans. A plugin that could read `ANTHROPIC_API_KEY` is a plugin that could exfiltrate one.                                                                                                                                   |
| Storage     | two SQLite files in `~/.repowiki`                  | the plugin's own data directory, from `ctx.fs.getDataDir()` | A plugin has no business writing to the user's home directory, and uninstalling should reclaim what it wrote. The RAG index also stopped pickling its IDF map — that row is JSON now.                                                                                                                |
| File IO     | `os.walk` + four `git` subprocesses                | `ctx.workspace.acquire` / `walk` / `changedSince`           | Enumeration is where containment lives: `.gitignore` semantics from the `ignore` crate, a refusal to hand over credential files, and clone guard rails (https only, host allow-list, shallow, timed, size-bounded) that apply to every plugin rather than to whichever one remembered to write them. |

Reading file _contents_ stays local. The host has already ruled on the paths;
re-fetching a thousand files over RPC would buy latency, not safety.

## Not ported

- The Click CLI and the FastAPI server, with its Vite frontend. Cognia is the
  interface; a second one would drift. `test_smoke.py` asserts those modules
  stay absent so a later edit cannot quietly drag Click and FastAPI back in.
- `export/site.py`, the docsify site — every asset came from a CDN, so it was
  a directory that only worked online.
- The `projects` table in the analyzer cache: written, never read.
- `WikiData.file_index`: computed, never read.

## Exports

`markdown`, `json`, and one self-contained `html` file. The HTML is genuinely
self-contained, which upstream's was not — it pulled Mermaid from jsDelivr and
hid every page but one behind an `onclick` handler, so an export opened offline
showed one page and no diagrams. Here there are no scripts and no external
requests at all: every page is stacked into one document with anchor
navigation, and Mermaid blocks keep their source in a `<pre data-mermaid>`,
which reads as the diagram it is and is the hook a host-side renderer would
upgrade in place.

## Tools

| Tool                  | What it does                                                                          |
| --------------------- | ------------------------------------------------------------------------------------- |
| `repowiki_scan`       | Acquire, ingest, analyse, build. `since` re-analyses only modules with changed files. |
| `repowiki_map`        | Files ranked by dependency PageRank. No model calls.                                  |
| `repowiki_get_page`   | One page, as markdown.                                                                |
| `repowiki_search`     | Hybrid TF-IDF + BM25 over code and pages. Returns cited excerpts.                     |
| `repowiki_export`     | Write the wiki to disk.                                                               |
| `repowiki_list`       | Repositories scanned this session.                                                    |
| `repowiki_project_id` | Resolve a source to its stable id without scanning.                                   |

## Tests

```bash
pnpm plugin:repowiki:test
```

202 tests. Upstream shipped 164; the rest came from rewriting the suites the
layer swap invalidated rather than deleting them — the properties they pinned
(project-id determinism, the "empty changed-set means re-analyse everything"
contract, the PageRank ranking) all survive the port, only their transports
changed.

The manifest is covered separately by `manifest.test.ts` in the repo's Jest
run: a manifest that fails validation means the plugin never loads, which is
the failure mode where every Python test is green and the feature does not
exist.
