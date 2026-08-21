---
"cognia-next": patch
---

Finish-setup notice: mount it inside the shells instead of at the body level. It was rendered as an ordinary block after the whole app, which made it a top-strip no shell ever placed correctly — on the pairing and OAuth deep links it landed below a full-viewport page and the only sign of it was a scrollbar, on the desktop shell (`h-screen` inside an `overflow:hidden` body) it was clipped away entirely, and on mobile it sat at the bottom of the document. It is now a row of each shell's own chrome — under the desktop title bar, beside the mobile offline banner — and self-hides on the chrome-free routes that own the whole viewport.
