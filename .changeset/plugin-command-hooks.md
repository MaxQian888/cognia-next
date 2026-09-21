---
"cognia-next": minor
---

Plugins can now ship declarative command hooks via a new `"command-hooks"` capability and `commandHooks` manifest field (the same `settings.json` `hooks` shape). The converter translates Claude `hooks/hooks.json` — including Codex manifests — into that field, canonicalizing `${CLAUDE_PLUGIN_ROOT}`/`${CODEX_PLUGIN_ROOT}`/`${extensionPath}` to `${COGNIA_PLUGIN_ROOT}` and failing closed on events with no Cognia equivalent (e.g. `PostMarketplace`) and unsupported handler types. At runtime the desktop (Tauri + headless) and CLI collectors merge enabled plugins' groups deterministically between user settings hooks and built-ins, binding each plugin's root token to its own install directory; the field is inert unless the capability is declared.

Verified: `pnpm test` (`lib/plugin/convert/ecosystem.test.ts` 37, `cli/src/hooks/plugin-hooks.test.ts`, `cli/src/hooks/load-hooks.test.ts`, `cli/src/hooks/resolve-hooks-config.test.ts`), `cargo test -p cognia-next --lib hooks::` (66 tests), `pnpm typecheck`.
