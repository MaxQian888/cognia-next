---
"cognia-next": minor
---

TUI: an external agent now gets Cognia's real session context and Cognia's own tools.

Hosting Codex or Claude Code used to change what a session **meant**, not just how it was transported. The external path forwarded `config.systemPrompt` plus four raw config fields, while the built-in path resolved project instructions (`AGENTS.md` / `CLAUDE.md`), output style, the active agent mode, the skill catalog, tool policy, attachments and twin grounding. A setting the TUI showed as active could therefore affect the built-in agent while doing nothing — or something different — on the one actually answering.

Both backends now consume one resolver, so those settings mean the same thing whichever agent is hosting. Attachments take Cognia's OCR/text-extraction fallback, since the external wire carries a single text prompt; anything that still cannot be represented fails **before** the turn is sent rather than being dropped silently.

Cognia's own tools reach the agent too. The `cognia-tools` built-ins and the `cognia-plugin-tools` host surface (plugins, web tools, `ask_user`, `load_skill`, `dispatch_agent`) are projected through an authenticated MCP bridge, alongside — not instead of — the user's own MCP servers. For the same config, an external session now advertises exactly the Cognia tool names a built-in session would: disabled categories, agent-mode filters, `allowedTools` overlays and plan mode all still apply, and a tool they exclude is both invisible and refused if called by name.

Cognia stays the authority for those tools. It computes the visible list, re-checks workspace confinement (including credential paths, and even when the agent is sandboxed), owns approval and persisted allow rules, and executes or delegates the handler — the agent's own permission result is never taken as evidence. One Cognia tool call produces at most one prompt.

Settings that ACP bakes into `session/new` — the system prompt, agent mode, skills, MCP servers, working roots — now restart the agent's context deterministically, with one notice saying the transcript is kept but the agent starts fresh. `/resume` will not hand an agent back a conversation created under settings that have since changed.

An agent that cannot host the bridge is reported as incompatible before the composer opens, instead of surfacing one silent tool failure at a time. `/status` and `/doctor` gained a parity section: context version, Cognia built-in and host tool counts, user MCP count, bridge health, and which settings restart the context.
