---
"cognia-next": patch
---

Key companion sync cursors by the host's cursor namespace (`{accountNamespace}:{hostId}`) instead of the device id it issued at pair time, and decide the mirror wipe from what the active database actually holds. Re-pairing to the same desktop now keeps its watermark instead of forcing a full re-pull of every mirrored table, and switching between hosts that each have their own runtime-target database no longer clears either one's cached sessions, messages or characters. Two hosts sharing a single database still get the wipe, and cursors written by earlier builds are adopted on first run rather than mistaken for another host's.
