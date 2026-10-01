---
"cognia-next": minor
---

Collaboration and multi-device hardening (ADR-0206/0207/0208):

- **Live feed:** shared issues, plans, runs and memberships now arrive over a per-organisation change feed instead of a 60-second poll. Polling remains as the fallback.
- **Field-level merges:** edits to different fields of the same shared issue or plan merge. Only an edit to the same field conflicts, and the conflicts panel names that field, both values and who changed it.
- **Collaboration notifications:** being assigned, mentioned in an issue comment (new teammate picker), asked to approve a high-risk shared run, or invited to a shared conversation now notifies you through the "Collaboration" notification source. That reaches the center, OS, phone and IM according to your existing preferences. Reading one on any device clears it everywhere, and a named invite can be accepted straight from its notification.
- **Device pairing alert:** existing devices are alerted when a new device pairs.
- **Paired-phone deletes:** deletions now propagate to paired phones for every synced table, so deleted skills, plugins, runs and others no longer linger there.
- **Conversation links:** "open this conversation" links, used by plan notifications, a memory's source and issue runs, now actually open the conversation.
- **Relay data-lane quota:** the relay data lane enforces a per-room byte quota, and clients pause relayed data until the window resets.
