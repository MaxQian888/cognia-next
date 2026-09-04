---
"cognia-next": patch
---

Local-only commands stop going out over the wire: the quick-unlock, Usage Dock, Pi session and SSH-files grant commands now carry contract descriptors, so the mobile and web shells refuse them locally instead of asking a paired host and being told 403. The headless brain now drains its own SFTP transfer queue rather than leaving rows queued forever, and the workflow portal honours the configured proxy when it renders inside the desktop shell.
