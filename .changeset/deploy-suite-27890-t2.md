---
"cognia-next": minor
---

Self-host deploy suite refresh: cognia-server moves to port 27890 everywhere (compose, k8s, Caddy, Prometheus, smoke — re-pair devices after upgrading; 7890 collides with the Clash proxy default), the T2 split execution plane actually works (workspace volume+subpath mounts, runner image auto-pull on first spawn, locked-down socket proxy without exec), the runner image ships every allowlisted agent CLI (cline added, cursor-agent aligned), k8s gains mandatory publicUrl + per-tenant Logto OIDC wiring, and the tier-2 smoke can run against Kubernetes via COGNIA_SMOKE_EXEC.
