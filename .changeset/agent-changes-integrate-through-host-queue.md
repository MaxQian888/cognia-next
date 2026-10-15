---
"cognia-next": minor
---

Agent work now reaches your branches through one reviewable path: each agent's changes become a changeset pinned to a commit, reviewed for risk (protected paths such as CI, migrations and deploy files always ask for your approval), checked with your approved acceptance profiles, and integrated by a host-side queue that verifies the exact merged result, moves the branch only if nobody else moved it, and can roll it back. Agent Teams can now use `merge-all`, landing on a run branch unless you choose the base branch. History and blame are cached per commit and repositories agents work in keep a commit-graph, so large histories open faster.
