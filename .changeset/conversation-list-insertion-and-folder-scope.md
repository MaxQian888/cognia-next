---
"cognia-next": patch
---

Conversation sidebar: a newly created chat no longer lands at the bottom of the list. Once a section has been drag-reordered, `setSessionOrder` renumbers every row in it, so anything that arrived afterwards — a new conversation, one you just pinned, one you just filed or un-archived, or a row a quick filter was hiding during the drag — carried no rank and was appended after the whole arrangement. Un-ranked rows are now slotted in where the active sort puts them relative to the arranged rows, so a brand-new chat opens its section and a freshly pinned one goes to the top of Pinned.

A conversation created while the list is narrowed is now revealed instead of hidden: the Archived view, a search still in the field, a quick filter left on, or a folded section are undone one at a time — and only while the new row is genuinely off screen, so opening a search result or reading an unread chat never disturbs the narrowing. Covers every entry point (sidebar "+", welcome CTA, command palette, Cmd+N, tray, CLI).

Folders are also honored as workspace-scoped: a conversation can no longer be filed — by drag or by the row menu — into a folder that belongs to another workspace, where the membership would have vanished on the next workspace switch. The archived-view toggle is read straight from the shared store on both surfaces, so desktop and mobile no longer overwrite each other's choice with a stale copy.
