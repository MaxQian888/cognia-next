---
"cognia-next": minor
---

Faster scheduled agent runs. Chat, agent, and skill tasks now start the agent host up to two minutes before they are due, and a run's independent setup reads now happen in parallel. Project environments can opt into "Reuse setup when nothing changed", which skips the setup script when the last setup in that root succeeded and its definition, input files, and required outputs are unchanged. Identical setups running at the same time in one root now run only once. Each run records where its time went (fire delay, session, agent options, workspace, environment setup, first response, agent turn), shown in the run sheet. The desktop alarm clock now finds the next due task with a heap instead of scanning every armed task, and re-reads the wall clock at least every 30 seconds so tasks that come due while the machine sleeps fire promptly after wake.
