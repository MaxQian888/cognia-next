// Claude subscription OAuth credential vault (ADR 0010).
//
// Stores the OAuth bearer + refresh token pair the user obtains via the
// Claude Code public OAuth flow (Pro/Max subscription mode) or the Console
// flow (API-billing mode). The active credential drives the sidecar's
// Authorization header at spawn time (see api_key.rs + claude/sidecar.rs).
//
// Credentials live in the OS keyring. The service name is namespaced and
// versioned so a future breaking change to the payload schema can ship a
// new entry rather than corrupting the existing one. The account name is
// hard-coded to "default" until multi-account support lands (out of scope).
//
// Cognia-next never writes to ~/.claude/.credentials.json — that file is
// owned by the Claude Code CLI itself, and double-writing would race with
// `claude login`. Our credentials are independent.

pub mod commands;
pub mod credential;
