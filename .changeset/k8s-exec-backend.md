---
"cognia-next": minor
---

Kubernetes exec backend (ADR-0059 R13): with COGNIA_EXEC_BACKEND=kubernetes the headless server spawns each external agent as a runner Pod (agent as the container's only process, stdio over pod attach, workspace mounted as a subPath of the shared PVC). Opt-in per tenant via deploy/k8s/tenant-template/runners/; the cognia-server ServiceAccount now carries the pods-create/attach Role.
