// CCSwitch (github.com/farion1231/cc-switch) interop. CCSwitch keeps a
// library of provider/subscription records, MCP servers, prompts, and
// skills in a single SQLite database at `~/.cc-switch/cc-switch.db`.
// Cognia-next reads that database **read-only**: CCSwitch is the writer,
// we are a consumer. The frontend uses the Tauri commands here to:
//   - probe the DB for presence + counts (status banner / drift detection)
//   - enumerate providers (so the user can pick one as cognia-next's
//     active provider, optionally propagating to selected external agents)
//   - enumerate MCP servers / prompts / skills (so the user can import
//     them into cognia-next via the existing per-domain import paths)
//
// Writes back to cc-switch.db are not supported. If a future feature needs
// to edit, that requires a separate ADR.

pub mod commands;
pub mod db;
pub mod paths;
pub mod watcher;
