---
"cognia-next": minor
---

The conversation list now groups by workspace by default, and the right rail stops showing the previous conversation's contents.

Sidebar: a new grouping selector (workspace / direct-messages-and-team / date / agent / none, in the display menu and in Settings → Conversation) replaces the date-grouping toggle. Grouping by workspace lists conversations from every workspace, with the active one first and the rest folded; picking a conversation from another workspace switches the whole app into that workspace so artifacts, terminals and the workspace panel follow it. The rail's Direct-messages / Team buttons now filter the list only in the "team" mode. Collapse choices persist per group.

Right rail: switching conversation now drops the pending panel/workspace reveals it published, so the workspace panel no longer renders the previous conversation's file; opening an artifact from the "recent" scope shows it in the conversation you are actually looking at instead of silently re-parking the one it belongs to; the artifact each conversation was parked on survives a restart; and the artifact list's search box and type/runtime filters reset on a conversation switch instead of quietly narrowing every conversation after the one they were typed in.
