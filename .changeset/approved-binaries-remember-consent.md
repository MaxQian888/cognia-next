---
"cognia-next": minor
---

Add an explicit "remember this binary" opt-in to the plugin consent prompt, wiring up the `approvedBinaries` consent ledger. Approving a plugin-shipped executable now offers a default-off checkbox that records a durable approval pinned to the binary's SHA-256 — any change to the bytes re-prompts, and the grant covers no other binary and implies no trust in the plugin's publisher. Leaving the box unticked keeps consent session-scoped exactly as before. Approvals are listed and revocable under the plugin's Permissions tab.
