---
"cognia-next": minor
---

Issue board: run an issue with its assigned agent or squad, and see the agent
engines' tasks on the same board.

The `/issues` board now has an assignee picker (Characters as agents, Agent
Teams as squads, or you), a **Run** button on every local issue that dispatches
it to the assigned engine — an Agent task, an Agent Team run, or, for a
GitHub-linked issue whose project is bound to that repository, the GitHub issue
loop that opens a pull request — and a run history with artifacts (sessions,
branches, PRs). A run owns _In progress_ while it works; when it finishes the
issue comes back to you at _In review_, never straight to _Done_. Runs are
tracked in a new local `issueRuns` table (Dexie v174), reconciled from the
engines' own state so a reload never strands an issue.

Agent tasks and Agent Team tasks are projected onto the board as read-only
federated rows (badged "from KEY-1" when they were dispatched from an issue),
the "N agents working" pill and the "My agents and squads" view are live
instead of pinned to zero, `/workspace` opens the one workspace manager and
shows each root's trust state, and issues are searchable from ⌘K.
