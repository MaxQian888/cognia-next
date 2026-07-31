---
"cognia-next": patch
---

Fix dead quick-start cards on the welcome page and unify every "new chat" entry point

- The welcome page's starter cards did nothing: they sent into a session that did not exist yet, so the send guard dropped the prompt (with a toast only on the first click). They now start a conversation — respecting the selected guild — and send the prompt into it.
- `Cmd+N` / File → New Chat / the tray / `--new-chat` now start a real conversation instead of clearing the workspace, which had closed every open pane and created nothing.
- Removed a duplicate `menu://new-chat` listener that fired the handler twice per menu click, and scoped the menu/tray "new chat" handlers to the main window — they are broadcast to every window, so with the pet overlay open they would otherwise start one conversation per window.
- Fixed the workflow editor's chat starters, which threw on a malformed payload and surfaced an opaque error toast.
- "No session selected" is now translated instead of hard-coded English.
