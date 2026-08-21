---
"cognia-next": patch
---

Import conversations: dropping a Cognia backup into the third-party import
dialog now says it is a backup and points at Backup & restore (an encrypted one
too), instead of failing with a generic "could not recognize the format". The
file picker's accepted extensions are derived from the registered importers
rather than hard-coded to JSON, and a non-JSON export is handed to importers as
raw text — so a plugin-contributed importer for a `.zip`, `.jsonl` or `.txt`
export is now actually reachable.
