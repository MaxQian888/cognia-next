---
title: "0146 — RepoWiki as the acceptance load for the Python runtime"
description: "An existing MIT wiki generator vendored whole, with exactly three layers swapped — model calls, storage, and file enumeration — so the port proves the plugin runtime rather than re-proving the algorithms."
---

# ADR 0146 — RepoWiki as the acceptance load for the Python runtime

**Status:** Accepted
**Date:** 2026-08-25
**Related:** [ADR-0145](./0145-python-plugin-runtime-alignment), [ADR-0026](./0026-marketplace-integrations), [ADR-0060](./0060-web-reader)

## Context

[ADR-0145](./0145-python-plugin-runtime-alignment) built a reverse RPC channel,
opened eleven `ctx.*` namespaces to Python, and added two declarative panel
classes. All of that is only as good as the first plugin that leans on it, and a
demo tool that logs a line does not lean on anything.

[RepoWiki](https://github.com/he-yufeng/RepoWiki) (MIT) is a real load: it walks
a repository, builds a dependency graph, runs an LLM pass per module under a
concurrency semaphore, renders Mermaid, chunks and indexes for BM25 + TF-IDF
retrieval, caches everything in SQLite, and exports three formats. It exercises
the agent API, the workspace API, filesystem access, storage, panels, modes and
the tool surface at once — and it arrives with 164 tests that describe what it
is supposed to do.

## Decision

### Vendor the whole thing; swap exactly three layers

`plugins/repowiki/repowiki/` is upstream's source. The algorithms are untouched:
the scanner's filters (35 skipped directories, minified-source heuristics,
binary sniffing, size caps, symlink skipping), the import graph, the analyzer's
passes and prompts, the chunker, the retrieval scoring, the exporters.

Three layers changed, all of them behind one module (`repowiki/host.py`), so
"what did the port change" has a single answer:

| Layer | Upstream | Here | Why |
| --- | --- | --- | --- |
| **Model** | `litellm.acompletion` with the user's provider key | `ctx.agent.run` | The host owns provider routing, the PII gate, cost accounting and trace spans. A plugin that could read `ANTHROPIC_API_KEY` is a plugin that could exfiltrate one. |
| **Storage** | two SQLite files under `~/.repowiki` | the plugin's own data directory, from `ctx.fs.getDataDir()` | A plugin has no business in the user's home directory, and uninstalling should reclaim what it wrote. |
| **IO** | `os.walk` and four `git` subprocesses | `ctx.workspace.acquire` / `walk` / `changedSince` | Enumeration is where containment lives. |

### Enumerate through the host, read locally

The host decides *which* paths — `.gitignore` semantics from the `ignore` crate,
an outright refusal to hand over credential files, and clone guard rails (https
only, host allow-list, shallow, timed, size-bounded) that apply to every plugin
rather than to whichever one remembered to write them.

Reading the *contents* stays in Python. The host has already ruled on the paths;
re-fetching a thousand files one RPC at a time would buy latency, not safety.
The scanner keeps its own sensitive-name check even though the host refuses
those files first: a defence that exists on only one side of a boundary stops
existing the moment the other side is bypassed, and `scan_directory` is also
reachable with a caller-supplied path list.

### The parts deliberately not ported

- **The Click CLI and the FastAPI server**, with its Vite frontend. Cognia is
  the interface; a second one would drift — upstream's two copies of the same
  scan pipeline had already drifted on whether the RAG index was persisted.
  `test_smoke.py` asserts those modules stay *absent*, so a later edit cannot
  quietly drag Click and FastAPI back into the dependency set.
- **`export/site.py`**, the docsify site: every asset came from a CDN, so it was
  a directory that only worked online.
- **The `projects` table** in the analyzer cache, and **`WikiData.file_index`**:
  both written, never read.
- **Model aliases.** Upstream mapped `opus` → `anthropic/claude-opus-4-5` because
  litellm needed a fully-qualified string. The plugin hands the id to
  `ctx.agent.run` and the host resolves it against the models the user actually
  has. A second table here could only go stale and name providers the user may
  not own — the drift ADR-0087 recorded.

### The HTML export is now actually self-contained

Upstream's pulled Mermaid from jsDelivr and hid every page but one behind an
`onclick` handler, so an export opened offline showed one page and no diagrams.
Here there are no scripts and no external requests at all: every page is stacked
into one document with anchor navigation (Ctrl-F reaches the whole wiki, and it
prints), and Mermaid blocks keep their source in a `<pre data-mermaid>`, which
reads as the diagram it is and is the hook a host-side renderer would upgrade in
place. Rendering to SVG needs a browser, and this file is written by a Python
process.

### Two panels, one activity

A `kind: "a2ui"` reader (page outline as `Tree`, page body as `Markdown`,
citations routed back to the plugin so it can open the project editor at the
line) and a `kind: "chat"` side conversation grounded in a few KB — the
overview, the page list, the top of the reading order, and the instruction to
call `repowiki_search` for anything else. Pasting every page would spend the
context budget on a medium repository and still be worse than a search.

A `modes` entry declares "RepoWiki mode" for the main conversation:
`permissionMode: "plan"`, because this mode answers questions about a repository
and an answer that edits it is not an answer.

### Rewrite the tests the swap invalidated; never delete them

The suites that drove `litellm`, the `git` subprocesses, the CLI and the server
models were rewritten against the ported surfaces, because the properties they
pinned all survive the port and only their transports changed:

- project-id determinism (the key the analyzer cache, the RAG snapshot and the
  panel all hang off — a random id per scan would orphan the snapshot every run
  and make the incremental path dead code);
- "an empty changed-set means re-analyse everything, never nothing changed" —
  getting that backwards ships a wiki that silently never updates;
- the PageRank ranking behind the reading order.

## Consequences

**213 tests**, from upstream's 164. The extra coverage is the rewrites plus new
suites for the three swapped layers and the pipeline they meet in — upstream had
no test at that level, because the same eight steps lived twice.

**A wiki does not survive a restart as a wiki.** `_SCANS` is in-process. What
*is* durable is the expensive half: the analyzer cache means a re-scan makes no
model calls, and the RAG snapshot reloads in milliseconds. Projecting the pages
into Dexie would need `ctx.dexie` opened to Python, and `ctx.dexie` hands back a
live handle — see ADR-0145.

**The dependency set is heavy** (pydantic, networkx, aiosqlite), so the manifest
asks for `pythonVenv: "isolated"`. Putting that solve in the shared bucket would
constrain every other Python plugin, which is the rule ADR-0145 set: a new
plugin never makes an installed one worse.
