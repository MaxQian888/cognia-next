---
"cognia-next": patch
---

Fix six defects across the outbound queue, plugin logs, workbench review, the browser pane, external links and account provisioning:

- A queued message no longer disappears when the Host is waiting on a human. The interactive admin lease is now taken as a pre-flight gate instead of inside the dispatch, so a `REMOTE_CONSENT_REQUIRED` answer freezes the row at its place in the channel rather than retrying it into the deadletter lane, the offline banner says which approval is pending and its code, and the queue resumes the moment the approval is answered on another screen.
- A plugin's Logs link now opens a panel with something in it. Nothing in the app ever emitted a log tagged as the plugin source, so the deep link landed on an empty list for every plugin. The frontend and Python runtime rings are now bridged into the unified log pipeline.
- The workbench review and file-reveal actions work on Windows. Their containment check matched a forward-slash prefix by hand, so every `C:\repo\…` path was judged outside its own root and the action silently did nothing.
- Re-clicking a link the browser pane already visited reopens it. The request is now carried with a token, so the same address stated twice is two requests rather than a state change React could not see.
- A modifier-clicked external link reaches the OS browser under Tauri and Capacitor, where `target="_blank"` does nothing.
- Two tabs opening a fresh development profile no longer destroy each other's vault. Provisioning is serialized across contexts and the registry refuses a duplicate account id before any vault is written.
