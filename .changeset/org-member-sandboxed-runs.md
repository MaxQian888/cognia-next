---
"cognia-next": minor
---

A multi-tenant cognia-server can now run an organization member's agent safely. The agent runs in a gVisor sandbox inside the member's own personal workspace. It uses the organization's model access through the Host and never sees the key. Only agents the organization allows can run. Each personal workspace has a size limit (`COGNIA_PERSON_WORKSPACE_MAX_BYTES`, 5 GiB by default), and a run that outgrows it is stopped. Purging a member now also stops their runs and deletes their workspace. Members can't start these runs from a paired device yet.
