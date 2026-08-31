---
"cognia-next": minor
---

The branches an isolated agent run leaves behind are now on the workspace page, where the repository that holds them is. They lived in a tab of the agent-teams workspace, a route that was taken out of navigation, so after a run settled the only durable trace of what it did was reachable only by someone who still had the old URL. The move also fixes their scope: that tab listed branches under one squad's configured working directory, while the branches actually accumulate in the checkout. The same tab mounted a third copy of the execution-environment inventory, scoped to a squad rather than a workspace, and that copy is gone.
