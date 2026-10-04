---
"cognia-next": patch
---

A paired phone now actually sends the conversation actions it queues for its Host. The outbound runner only started when the phone's runtime mode read exactly "paired", but that device-local setting is often missing on a working pairing (`/pair` never records it, and each paired Host has its own database), while the boot path links the Host for any pairing that is not "standalone". Drafts, sends and list actions were queued and shown as "N pending — waiting for the Host" with zero attempts, even though the Host link was up. The runner now uses the same rule as the boot path.

Rows queued before a Host restart are delivered too. A Host moves to a new generation on every restart and refuses actions stamped with an older one. A row that no Host has seen yet is now re-stamped onto the Host's current generation when it is sent. A row the Host may already hold keeps its original stamp so it is never applied twice, and a refused row the user retries is re-stamped on retry. A burst of queued draft saves now goes out as the latest draft of each conversation, instead of one row per save that the Host rejected as revision conflicts.
