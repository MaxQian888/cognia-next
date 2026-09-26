---
"cognia-next": patch
---

Paired web and mobile clients no longer drift from their desktop Host when organizing conversations. Pinning, filing into or out of a folder, drag-reordering, and deleting a conversation are now forwarded to the Host (like rename and archive already were), so the change lands on the Host and syncs back to every device instead of living only on the device that made it. In the other direction, filing or reordering a conversation on the desktop now reaches paired devices too, without moving the conversation in the recency order. Deleting a conversation from a paired device requires the owner grant, and a conversation frozen for a cross-host handoff refuses all of these writes — including a remote rename or archive; deleting a folder whose member is handoff-locked now fails as a whole instead of half-unfiling it.
