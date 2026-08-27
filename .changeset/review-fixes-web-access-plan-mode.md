---
"cognia-next": patch
---

Fixes from review of the composer, external-agent and scheduler work.

External agents: "Brings its own web search" now actually persists and now actually does something. Editing an existing agent silently discarded the setting — the store rebuilds a config from a field whitelist that never copied it — so the declaration could only ever be made when the agent was first created, and setting it back to "work it out" had no spelling that survived a partial update. The declaration is also read at last: a turn on an agent that brings its own search no longer gets Cognia's `web_search` / `web_fetch` appended on top of it.

The composer's `+` menu read plan mode from the focused conversation while writing it to its own, so in a background pane the row showed someone else's state and toggled away from a mode this chat had never been in. Both the desktop menu and the mobile sheet now read the conversation they write to. The web-search globe reads the same web-access resolution the turn builder does, instead of re-deriving "is a provider configured" by hand — with web tools switched off it used to stay lit over an agent that had none. The "turn this into a scheduled task?" row is confined to general direct chat: it offered to navigate away to the scheduler from the workflow editor's chat tab, abandoning the graph being authored.

Shortcut hints show ⌘/⌥ again on an iPad with a keyboard attached, where an OS-family check had started printing Ctrl/Alt on keys that say otherwise. A turn that failed inside its own dispatch no longer collects a "the turn has gone silent" warning ninety seconds after it finished. A bulk scheduler action that fails on more than five items now says how many it could not list, instead of naming five and counting eight.
