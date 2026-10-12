---
"cognia-next": minor
---

Bots that run an external coding agent now have a "Model route": run on a Cognia model, so every model call passes the gateway's sensitive-data check and the run's cost ceiling is a hard limit, or explicitly let the agent use its own provider login (clearly labelled: no gateway check, and the ceiling is only checked between calls). An agent that can use a Cognia model waits for this choice instead of starting on whatever login the machine has. A Bot's cost ceiling is now enforced, and Bot checkouts of private repositories use the GitHub account the Bot is bound to (including GitHub Enterprise and pull requests from forks) rather than the machine's own Git credentials.
