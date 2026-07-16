---
"cognia-next": minor
---

Make the chat conversation timeline usable, and add find-in-conversation.

- **Fix anchor timestamps.** The timeline rail's hover card and expanded panel never showed a time: `listMessages` dropped the `createdAt` column instead of surfacing it, so every turn's timestamp was `undefined` and the whole multi-day formatter (`Yesterday 14:32`, `Mon 14:32`, `Jun 21 14:32`) was unreachable. The same fix makes each message's action-bar timestamp report its real time instead of always falling back to "now".
- **Show the timeline sooner.** It now appears past 8 messages instead of 20, where the first turn has usually scrolled out of view.
- **Navigate anchors from the keyboard.** `Ctrl/Cmd+Alt+↑` / `Ctrl/Cmd+Alt+↓` jump to the previous/next user-message anchor; both are rebindable under Settings › Keyboard shortcuts.
- **Bookmarks now survive.** Starring a message persists to its metadata and is restored when the conversation reloads — previously bookmarks were memory-only and vanished on session switch. The timeline marks bookmarked anchors and can filter down to just those.
- **Find in conversation.** `Ctrl/Cmd+F` opens a find bar over the active session: live match count, Enter / Shift+Enter (or the arrows) to cycle hits, Escape to close, and the matched message is ringed. Matching reaches text inside code blocks and A2UI surfaces, and works on both the virtualized and document-flow list paths.
