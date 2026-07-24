---
"cognia-next": minor
---

`cognia-agent chat --backend codex|claude-code` now starts the agent before the composer opens, and says which agent is answering.

Previously the external process was spawned lazily on the first turn, so every way it can fail — an unsupported platform, a missing sandbox launcher, an agent binary that isn't installed, a mistyped `--backend` — was discovered only after you had typed and submitted a message. The startup gate now runs `trust folder → connect → chat`, with a single line naming the step in progress ("starting codex … checking sandbox"). Trust always comes first: an untrusted folder never has a process spawned against it, because the sandbox hands that folder to the agent as a writable root. When the agent can't start you get a page that names the step it failed on and offers Retry / use the built-in agent / run `/doctor` / quit, instead of a composer whose first message is doomed. Falling back to the built-in agent is always an explicit choice, never silent.

The TUI also stops reporting the wrong identity. The banner, the footer and `/status` used to render the built-in provider and its catalog model — `--backend codex` displayed "anthropic · claude-opus-4-8" while Codex answered, pinned to the top of the screen all session in the default fullscreen layout. They now name the backend and the preset actually launched, and the `% ctx` gauge and cost segment hide themselves rather than deriving numbers from a model that never ran. `/status` additionally lists what the active backend cannot do, sourced from a single capability set that merges the preset's declaration with what the agent negotiated during its handshake — so features like `/compact`, `/limits` and MCP forwarding are reported as unavailable with a reason rather than silently doing nothing.

New `/backend` command switches the hosting agent without restarting: it drops the live session, reconnects through the same staged flow, and states outright that the conversation on screen is not visible to the new agent. The turn now reuses the process started at launch instead of spawning a second one.
