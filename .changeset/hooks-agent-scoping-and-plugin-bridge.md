---
"cognia-next": minor
---

Hooks: scope a hook to a specific agent, run one from a plugin, and make every rail agree

- **Agent-scoped hooks.** A hook group takes a new `agents` selector alongside `matcher` — one narrows by tool, the other by which agent produced the turn (chat, teammate, subagent, plan step, connector, scheduler, …). Hook payloads now carry `agent_kind` and `agent_ref`; previously the only identity a hook ever saw was the session id, so a teammate turn was indistinguishable from you typing. Note that real Claude Code reads the same `settings.json` and ignores this field, so a group narrowed this way runs unconditionally there; the settings panel says so inline.
- **Plugin hook handlers.** A hook handler can now be `{ "type": "plugin", "pluginId": …, "hookId": … }`, running an installed plugin's own handler. Gating a tool or prompt additionally requires the plugin to declare `hooks:chat-intercept`; everything else fails open. Plugins get a read-only `ctx.hooks` API to check whether their contribution is live and to get the exact binding entry.
- **The CLI runs the real hook engine.** CLI turns bypassed hook injection entirely and fell back to a reduced runner that never read a hook's output — so the default-on context loader silently did nothing, and CLI subagents and headless runs had no hooks at all. All three now run the same engine as the desktop.
- **The same matcher means the same thing everywhere.** The CLI anchored its regex fallback while the desktop did not, so `^Notebook` matched on one and silently matched nothing on the other. All three rails now share one conformance table.
- **Plan steps, teammates and dispatched subagents fire hooks.** A blocking hook pauses a plan rather than failing it. Subagents dispatched by cognia now emit `SubagentStart`/`SubagentStop` like the ones dispatched by the model.
- **"Why didn't my hook fire?" is answerable.** Hook audits were emitted and then discarded; they now appear in Logs → Traces. The Hooks settings panel also lists the three surfaces lifecycle hooks deliberately do not cover.
- **Fixes** a plugin's `onPreCompact` hook never running, disabled plugins still receiving some hooks, and the handler-type list hiding prompt/agent/MCP-tool handlers that had been working for some time.
