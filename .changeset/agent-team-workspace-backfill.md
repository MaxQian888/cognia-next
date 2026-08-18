---
"cognia-next": patch
---

Agent Teams created before workspace isolation no longer leak into every
workspace.

Teams persisted before Dexie v86 carried no owning workspace and were shown in
every workspace "until re-saved" — and a workspace purge never removed them.
On the next load they are stamped with the default workspace, `updateTeam`
stamps a missing owner on save, and the mode selector shows only the active
workspace's teams.
