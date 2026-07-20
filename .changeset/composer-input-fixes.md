---
"cognia-next": patch
---

Fix data-loss and polish issues in the chat composer (input box). Staged attachments are no longer silently destroyed when a send is cancelled or fails — declining the oversize-attachment dialog now keeps your images/documents intact (they were previously cleared and their blob URLs revoked before the send was confirmed). Switching to a conversation with no saved draft now clears the input instead of leaving the previous conversation's text behind and persisting it into the new one.

Compact composer layout now keeps the familiar paperclip on desktop (the mobile "+" menu's camera/album entries all collapsed to the same file picker there). The rows above the input (ephemeral skills, folded-paste chips, the re-paste reminder, and the goal / loop / plan-mode banners) now slide open and closed instead of making the composer jump, the send → stop button icon genuinely cross-fades, and the character counter only announces to screen readers as you approach the limit. Trigger/mention detection and inline ghost-text also stay in sync with the caret after picking a suggestion, pasting, or recalling history.
