---
"cognia-next": minor
---

External agents now report one capability answer everywhere. What the CLI's `--backend` selection, the TUI's feature rows, the capability panel in Settings and the execution resolver say about a backend all come from the same negotiated profile, so a feature can no longer be offered on one surface and refused on another. Concretely: OpenCode no longer claims steering it cannot do, MCP is only reported on the protocols that can actually carry a server, model selection works on the Codex ACP shim, and Codex's native compaction and resume are no longer greyed out.

Several things that quietly did not work are fixed along the way. Adding, editing or deleting an external agent in Settings now reaches the running agent instead of only the saved list — previously a new agent was not registered until the next restart, an edit left the old configuration connected, and a delete could leave the process running. A sandboxed OpenCode agent keeps its session store, so resuming no longer starts over. Pi and OpenCode turns report the tokens they spent and the provider's own cost, which were being dropped. A teammate pinned to an external runtime this machine cannot reach now fails with a clear error instead of quietly finishing on the built-in engine.

Windows and other unsupported platforms are told up front that external agents need a sandbox the platform cannot provide, rather than at spawn time after the agent has been configured and saved. The protocol picker no longer offers three protocols that never had an adapter.
