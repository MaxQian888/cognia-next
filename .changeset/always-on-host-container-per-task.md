---
"cognia-next": minor
---

An always-on host now runs the work you dispatch to it in a container by default, never in its own process. This covers phone chats, Bots, scheduled tasks, goals, Agent Teams, delegations and plugin agent calls. Built-in turns get sandboxed Bash, Edit and Write in the project's runtime environment, with the other host-writing tools turned off. External agents start in the same environment, and an agent already running elsewhere is restarted there. A project with no runtime selection uses the deployment's default image. A run that cannot be placed is refused. A project can opt out with the new **Run as host processes on an always-on host** switch in its environment's runtime settings, which other devices ignore. On the T2 Compose stack, task working copies now live inside the workspaces volume (`COGNIA_TASK_WORKSPACE_EXECUTION_ROOT`), so a scheduled task's lease can be mounted into its container.
