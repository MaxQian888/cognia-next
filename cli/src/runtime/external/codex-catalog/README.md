# Vendored Codex model catalog

`codex-catalog.json` holds two files from [openai/codex](https://github.com/openai/codex) at tag `rust-v0.163.0` (commit `83086188ae0614bd882818ff1aa23f3194962012`), Apache-2.0 (see `LICENSE` and `NOTICE`):

- `models`: `codex-rs/models-manager/models.json`, the catalog Codex bundles.
- `fallbackInstructions`: `codex-rs/models-manager/prompt.md`, the instructions Codex gives a model its catalog does not list.

Codex's `model_catalog_json` replaces the bundled catalog, and `spawn_agent` only accepts a model the active catalog lists. A gateway task that names a sub-task model therefore writes its own catalog. The materializers (`../gateway-task.ts` and `crates/cognia-sandboxd/src/gateway_task.rs`) build it from this file: a bundled slug keeps its bundled entry, and any other slug gets the entry Codex itself would build for an unlisted model.

The entries are copied unmodified. A task changes its own copy in two ways only. It sets the context window and compaction limit the routed model reports. It also appends to a bundled entry's `supported_reasoning_levels` any effort the routed provider accepts that the entry lacks, because Codex validates a sub-agent's effort against those levels. To refresh the entries, replace `models` and `fallbackInstructions` from a newer tag and update `source`.
