---
"cognia-next": patch
---

Attachments now load on a phone or browser paired to a headless host. The request reached the host and the answer was sent, but the frame carrying it had no handler on the receiving side, so every read ended in a thirty-second timeout reported as a temporary failure. Oversized attachments are now refused with a clear reason instead of the same timeout, and a host running an older brain says so immediately rather than making the device wait.
