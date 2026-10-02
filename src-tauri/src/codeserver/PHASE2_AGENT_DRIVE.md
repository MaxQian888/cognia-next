# Pro IDE — Phase 2: Agent-drive

This design note is retired. Agent drive shipped and was then replaced by the
managed broker; the note's transport (a WebSocket) and its "deferred" list were
both overtaken. Its full text is in git history.

The current design lives in:

- [ADR-0088](../../../docs/content/docs/en/adr/0088-pro-ide-code-server.md):
  the embedded workbench, its hosts, threat model and amendments.
- [Managed IDE Extension Platform](../../../docs/content/docs/en/subsystems/managed-ide-extension-platform/index.mdx):
  the broker protocol, security and operations (including the desktop relay).
- Code: `crates/cognia-codeserver/src/agent_channel.rs` (broker host),
  `sidecar/codeserver-agent-ext/` (the extension), `lib/plugin/ide/` (renderer
  runtime).
