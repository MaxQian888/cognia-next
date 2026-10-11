---
"cognia-next": minor
---

The always-on host and the T2 Compose setup now reach Docker through Cognia's own proxy, which reads every request: containers are created only with this instance's labels, mount only the workspaces and agent bundle volumes, and never get privileged mode, host namespaces, devices or extra capabilities, and exec, stop and remove reach only Cognia's own containers. This replaces the generic socket proxy, which let any container be created and blocked the exec calls the sandbox pool needs. The sandbox pool is on by default in this setup, and `COGNIA_RUNNER_NETWORK=host` is refused.
