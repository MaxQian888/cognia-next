---
"cognia-next": minor
---

Chat right rail: fix cross-session bleed and three interaction breaks in the Context Workbench.

- Artifact tabs and the active artifact are now tracked per conversation, so switching chats no longer leaves the dock showing one session's tab strip and preview beside another's artifact list and browser. The 12-tab cap is per conversation too.
- The narrow-screen Sheet takes its visibility from one field, so a new artifact can no longer throw it back over a conversation the user just dismissed, and a terminal link or Edit/Write review reveal keeps the file it was pointing at.
- Collapsing the dock with ⌘J, the Views menu or the header toggle now leaves focus mode, instead of reopening as a full-screen takeover.
- The narrow/wide highlight follows the dock's real width rather than the mode a panel asked for.
- The embedded browser and the project workspace survive an artifact tab switch, keeping the page, the open editors and the file tree.
- The activity rail has an explicit order (preview first), the selection composer moved into the artifact's AI panel where the rail can reach it, and the artifact tabs stay visible when a conversation has tabs open but none active.
- Staged artifact references show which one is the edit target and let you switch it; a whole-artifact reference is labelled as such.
- Added a "Reset layout" entry to the workbench header for the chat dock and the canvas shell, and fixed a workspace-width drag that failed to persist below 24%.
