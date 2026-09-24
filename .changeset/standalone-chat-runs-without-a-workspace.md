---
"cognia-next": patch
---

Standalone (BYOK) chat runs again in a plain browser and in the phone's standalone mode. The first turn of every new conversation was refused with "Couldn't open the workspace", because the send path demanded a managed working copy that a shell without a local filesystem cannot build and that the in-webview engine, which has no file tools, would never open. Turns that run in the standalone engine now skip the working copy, the turn lease and the project environment, exactly as zero-tool turns already did, and a new conversation there no longer files a "Workspace unavailable" / "Host unavailable" error whose toast covered the composer. Desktop and paired shells are unchanged.
