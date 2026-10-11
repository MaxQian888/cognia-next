---
"cognia-next": minor
---

A new `container` sandbox tier runs a conversation's sandboxed Bash, Edit and Write in the project's runtime environment on an always-on host: a container from the host's sandbox pool, as the environment's user, in the task workspace under the same paths. A project without a runtime selection gets the deployment's default environment; anything that cannot be placed is refused, never run on the host. A run in this tier counts as sandboxed for the unattended permission profile. Each conversation's containers are removed once it no longer uses them, and ones a previous host process left behind are cleaned up at start. The tier can be chosen per character; on a desktop or phone it shows as available only on the always-on host. The Docker proxy binary also no longer deletes a non-socket file at its listen path.
