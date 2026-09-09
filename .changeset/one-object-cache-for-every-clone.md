---
"cognia-next": minor
---

Every repository clone now shares one object cache, on the desktop app and on a headless server alike: the second clone of a repository reuses what the first one fetched instead of going to the network for it. Self-hosted GitHub Enterprise remotes get their credential again, and a clone that runs out of time now actually stops rather than continuing to write in the background.
