/**
 * The canonical WASM plugin WIT contract and every copy of it in the tree.
 *
 * Shared by `scripts/gates/check-plugin-sdk-wit.mjs` (the gate) and
 * `scripts/sync/sync-plugin-sdk-wit.mjs` (the writer) so the two can never
 * disagree about what is mirrored.
 *
 * All paths are repo-relative. Both consumers compare CONTENT, never filenames,
 * which is why the two guest copies can be called `world.wit` — `cargo
 * component` reads `<crate>/wit/` by directory convention and does not care
 * about the filename.
 */

export const CANONICAL = "src-tauri/wit/cognia-plugin.wit"

export const MIRRORS = [
  // Published SDK copies. Shipped in the npm package's `files[]`.
  "plugin-sdk/wit/cognia-plugin.wit",
  "packages/plugin-sdk/wit/cognia-plugin.wit",

  // Guest-side copies. These were ungated until the v0.2 cutover and had
  // silently drifted: both still carried the pre-hardening `process.exec` doc
  // comment ("v0.1.0 hosts may simply allow any program") long after the host
  // moved to a deny-by-default `shellCommands` allowlist. The template one
  // matters most — it is `include_str!`-embedded into the shipped CLI, so every
  // scaffolded plugin inherited the stale text.
  "crates/cognia-plugin-template/wit/world.wit",
  "plugins/wasm-example-formatter/wit/world.wit",
]
