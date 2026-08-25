---
"cognia-next": minor
---

RepoWiki gets a reader panel, a side conversation, and a chat mode — and any plugin panel can now hand its text to a conversation.

The right rail gains a wiki reader (page outline, page body, Mermaid diagrams, and citations that open the project editor at the line) and an "Ask the wiki" side chat grounded in the repository's overview and reading order. A "RepoWiki" mode for the main conversation answers from the wiki with citations, read-only by construction.

Selecting text in any declarative plugin panel now offers two destinations: stage it as a context chip on the main conversation, or quote it into that resource's side chat. Before this, a plugin's own surface had no route into a conversation at all.

`ctx.editor` and `ctx.notifications` are now reachable from Python plugins, which is what lets a citation click open a file.
