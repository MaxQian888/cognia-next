---
"cognia-next": minor
---

Issues: sub-issues can be grouped into ordered stages, and the parent is woken as each stage completes (wakeups can also wait for a specific stage). An issue can wait in triage — chats and wakeups will not start an agent on it until someone accepts it — and GitHub import can file new open, unassigned issues there. A wakeup can wait for a linked pull request to merge (import-mode GitHub projects), and PRs a run opens are linked onto its issue. Agents can hand over results with `issue_link_artifact`; the inspector lists them as versioned deliverables with inline previews, shows a run history strip, and collapses repeated run failures in the activity trail.
