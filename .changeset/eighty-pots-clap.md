---
"cognia-next": patch
---

A conversation whose managed workspace was marked as conflicting can recover. Reconciliation now looks at conflicting workspaces, which is what lets one return to normal once it makes sense again, and it corrects a workspace that recorded Git isolation it never actually had instead of conflicting it on every pass. Those workspaces refused every message with "managed workspace is not active" and nothing could clear them. A repository that has since been deleted from disk also no longer stops the whole workspace service from starting.
