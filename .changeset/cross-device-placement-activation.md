---
"cognia-next": minor
---

Activate the cloud↔local placement loop: Scheduled Tasks can now hand timing to a paired remote host (with a 1 / 5 / 15 minute unreachability grace, defaulting to 5) instead of every machine silently claiming it, and handing timing away disarms what this host already armed rather than letting an already-armed slot fire anyway. A workflow whose runs execute on another host now shows those handoffs on its Runs page — dispatch status, target host, the run the target minted, and the failure reason — with actions to open the target host or cancel a handoff the target has not admitted yet. A host→target dispatch that dead-letters or is refused outright now reaches the notification center and, when it belongs to a run, that run's event log, instead of only changing a status nobody reads.
