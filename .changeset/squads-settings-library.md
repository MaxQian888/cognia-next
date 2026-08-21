---
"cognia-next": minor
---

Squads move into Settings, as a library you can actually read.

Agent teams used to have a top-level page that was six things at once — a list, a command centre, a template gallery, a kanban board, a chat tab and eleven accordions of governance — and could not be read as any one of them. A Squad is a cross-conversation asset, like an MCP server or a model provider, so it now lives where those live: **Settings → Squads**.

The library is a list on the left and one Squad on the right: its name, what it is for, who is on it, and a way to delete it. The template gallery is one entry in that list rather than a competing tab. Each Squad is deep-linkable (`?section=squads&squadTab=squad:<id>`), and a link to a Squad you have since deleted lands on a neighbouring one instead of a blank pane.

The section is called **Squads** now, not "Agent teams" — the app has two things named "team" and only one of them is this. Searching Settings for "team", "agent team", "multi-agent" or 团队 still finds it.

Deleting a Squad no longer silently strands the conversations bound to it: they fall back to a single agent, and runs it already produced stay in the run history.
