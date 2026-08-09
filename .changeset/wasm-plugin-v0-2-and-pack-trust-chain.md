---
"cognia-next": major
---

WASM plugin host API v0.2.0 (breaking) plus the Character Pack trust chain and determinate plugin-activation progress.

**Breaking — every existing WASM plugin must be rebuilt.** The host now registers only the `cognia:plugin@0.2.0` linker; loading a v0.1 plugin fails with `UPGRADE_REQUIRED` naming the plugin and the steps to fix it. `notification.notify` returns `result<_, string>`, which changes the component's import types, so a v0.1 binary cannot be linked at all — authors must bump `wasm.apiVersion` to `0.2.0`, replace `wit/world.wit` from the SDK, handle `notify`'s new `Result`, swap the `network:fetch` grant for `ai:chat`, and run `cognia plugin build`.

- Clipboard, notification, AI, and workflow capabilities are backed by real host services instead of returning `cognia:not-implemented`. Errors carry a stable `"<CODE>: <message>"` prefix (`CAPABILITY_DENIED`, `INVALID_REQUEST`, `PAYLOAD_TOO_LARGE`, `TIMEOUT`, `CANCELLED`, `HOST_UNAVAILABLE`, `PROVIDER_ERROR`, `WORKFLOW_REJECTED`).
- `ai.generate-text` now requires `ai:chat` rather than `network:fetch`, and `workflow.emit-event` now requires `extension:workflow`.
- Signed `.cognia-pack.json` files are verified with Ed25519 over the RFC 8785 canonical JSON of the pack. Unsigned packs are still accepted and are now visibly labelled; a signed pack that fails verification is refused. New `cognia pack sign` / `cognia pack verify` CLI commands.
- Character packs can declare `requires.themePacks` / `connectors` / `providers`; missing entries warn and never block.
- Enabling a plugin shows determinate seven-phase progress, and the `/plugins` toggles now actually activate through the plugin manager instead of only writing the database flag.
- Fixed: exporting a signed pack silently dropped its signature; notification titles and bodies were written to the log; and `Progress` never published `aria-valuenow`, leaving every progress bar in the app accessibly indeterminate.
