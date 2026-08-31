---
"cognia-next": minor
---

A squad run's consensus and delegations are now in the run cockpit, beside its activity and changes. They were tabs of the agent-teams workspace, a route taken out of navigation, so the decisions a run reached were only reachable by someone who still had the old URL. Both panels used to read whichever squad the app had last selected rather than the one the run belongs to, which meant that dropping them anywhere outside that workspace would have shown the wrong squad's data. They now take the squad to show, resolved from the run record itself, and they resolve it from an id that is present even while a run is live and streaming (the run's own id is not). On a device that does not carry squad run records the tab says so instead of rendering an empty list, which would have claimed the run reached no decisions at all.
