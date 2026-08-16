---
"cognia-next": patch
---

Fixed a batch of defects found in review of the agent-composition and inline-completion work:

- **External agent sandbox.** The one `node` exception in the external-agent binary allowlist (the managed DeepSeek Harness launcher) was pinned to the whole Cognia data root, which contains the agent-writable `workspaces/` directory — an agent could drop its own `launcher.mjs` there and run arbitrary code. It is now pinned to the runtime home itself, on both the Node and Rust hosts.
- **DeepSeek Harness runtime settings** now work on desktop. The Tauri commands required a data root, Node version and source directory that the renderer had no way to supply, so every action in the card failed; the host derives them itself, as the headless backend already did, and the runtime artifacts ship as a bundled resource.
- **`run_code` tool calls are validated.** Tool arguments produced by generated code now go through the tool's schema before reaching its handler, so defaults and limits (e.g. `content_search`'s result cap) apply on this path as they do everywhere else. The typed SDK the model is shown also carries real field names instead of `input: unknown`.
- **Ghost text.** A completion provider that times out no longer caches its empty result (retyping the same draft retries instead of showing nothing for 30s) and its in-flight request is now cancelled. Slash-command drafts are no longer completed from history, which could produce a runnable command line the user never wrote. In the CLI, custom and plugin slash commands registered after startup now appear in autosuggest.
- **Runtime selector.** A chosen external agent whose plugin adapter had not finished registering at startup is no longer silently reset to the built-in runtime on every restart.
- **Agent modes.** Editing the composition while in Plan mode no longer drops plan behaviour on the legacy send path.
- **Plugin tools.** A tool schema declaring a nullable enum (`["a","b",null]`) again accepts `null`.
