---
"cognia-next": patch
---

Fix remote workflow approvals on headless hosts: a cloud host answered `workflow_approval_list` from a Rust waitpoint mirror nothing ever writes there, so the phone's pending-approvals card stayed empty and every approval gate ran out its timeout onto the rejected branch. Headless hosts now route both approval RPCs to the brain, which holds the only copy.
