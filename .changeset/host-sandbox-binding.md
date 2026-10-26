---
"cognia-next": minor
---

Multi-tenant Hosts bind every sandbox to the org, workspace, actor and run they admitted: workspaces mount read-only without write access, each task gets private scratch, mount roots must sit under `COGNIA_WORKSPACE_ROOTS_DIR`, and injecting a credential needs `credential.use`, with placement reports labelling brokered versus injected credentials.
