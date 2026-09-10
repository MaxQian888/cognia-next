---
"cognia-next": patch
---

Every companion RPC request shape is now declared rather than recovered by parsing the Rust dispatch arms (ADR-0175 B4). The 75 `git_*` commands, whose loopback shape names an absolute repository path where the device shape names a workspace and a path inside it, gain a `servicePlaneCommands` section in the request-schema catalog, and `task_workspace_remote_source_ensure` gains the contract it shipped without. The generator now refuses to emit a spec for a command that declares neither a contract nor a Zod schema.
