---
"cognia-next": patch
---

Deployment wiring for the unified sign-in. The compose suite and the Kubernetes base pass the collaboration server its bootstrap credential hash and Logto M2M app, and the gateway its native client id and social providers. The Logto image is pinned. LOGTO.md documents social connectors, the M2M app, credential rotation and the callback modes. ADR-0149 and the deployment docs record the shipped model.
