---
"cognia-next": minor
---

The performance panel's Managed Processes tab now covers three kinds of long-lived child process it previously could not see or stop: Node plugin hosts, headless shell sessions, and the cloudflared tunnel. All three are also stopped on app exit instead of being orphaned. The Hotspots empty state no longer suggests running a workflow, which is never recorded.
