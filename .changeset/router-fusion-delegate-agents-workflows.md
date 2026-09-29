---
"cognia-next": patch
---

Router + Fusion delegate now works from workflow steps and Squad members: the run gets its project, checkout and approved test profile, a run that needs your approval asks on the workflow or Squad run in Agent Runs and continues once you answer, and a delegate can be set to apply its verified patch to the workspace. The Run API reports the pending approval id and approval events, the E2B microVM tier falls back when it cannot take a local worktree, and patch writes no longer fall back to a non-atomic path on an authorization error.
