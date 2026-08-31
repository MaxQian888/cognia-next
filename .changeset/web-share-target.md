---
"cognia-next": minor
---

Sharing to Cognia now works from an installed web PWA, not only from Android's native share sheet. The share-target screen with its session picker has shipped since Wave 3, but the web app manifest never declared a `share_target`, so no browser could route a share into it and the page was unreachable for every web user.

The page also stopped throwing away the title. Android and most link shares send a headline alongside the text and URL, and reading only two of the three lost the one line that says what was actually shared. It now shows in the preview, leads the composed message, names the new session, and is skipped when the text already opens with it so a shared selection does not say itself twice.
