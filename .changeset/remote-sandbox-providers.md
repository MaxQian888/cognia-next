---
"cognia-next": minor
---

Project agents can run in remote sandboxes created on demand on E2B or a Kubernetes cluster, from the desktop (Settings → Remote sandboxes) or an always-on host (`COGNIA_SANDBOX_PROVIDERS_FILE`). A project picks where it runs (automatic, this host's own sandbox, or a named provider); a remote sandbox clones the repository from its remote, pushes its work to a `cognia/` branch when the session ends, and never holds a model, git or provider key.
