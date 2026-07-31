---
"cognia-next": minor
---

Branch a conversation without losing the one you are in.

Branching used to mean one thing: fork the whole thread into a new session in the sidebar. That is the right move for a direction you mean to keep, and the wrong one for a question you want to ask on the side and fold back in a minute. The branch dialog now asks where the branch goes — a new conversation, or an **aside** that lives in the dock beside the thread it came from. Asides can be renamed, cleared, deleted, and promoted into a conversation of their own once one turns out to matter.

You can also choose what a branch carries. Alongside "copy verbatim" and "seed with a summary", the dialog now lets you pick individual messages, so a branch can start from the three turns that matter instead of the forty that preceded them. Selecting text in a message and choosing "Ask in an aside" does the same thing in one step.

Branches are visible from the thread they left: a message that has been branched from shows how many branches hang off it and lets you step between them, and the sidebar and session row show a session's branch count before you delete it.

**Editing a question no longer destroys the answers below it.** "Edit and resend" used to truncate the log from that message down — reword a question halfway up a long thread and everything after it was permanently gone. The edited message now joins the original as a sibling branch, and the edit is selected so you see your own version rather than the one that was pinned before. Deleting from a point is still available, but it is now its own explicit action ("Delete from here") behind a dialog that says how many messages go and warns that branch variants go with them.

Two storage fixes underneath. Branch rows and workbench sidechats were built by hand rather than through `createSession`, so both omitted the workspace id — and because the sidebar reads sessions through a compound index, rows missing that field were not mis-filed but absent: branches vanished from the sidebar on the first reload after creation, and sidechats outlived the workspace they belonged to, along with all of their messages. Both are backfilled on upgrade. Workbench sidechats also gain an indexed binding, so opening one is a lookup instead of a scan of every session in the database.
