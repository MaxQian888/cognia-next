# Cognia k8s deployment (ADR-0059 D9 — T3 topology)

Kustomize tree for running the self-host suite on Kubernetes. One tenant =
one namespace stamped from `tenant-template/`; the shared services
(signaling, share) live once in the base.

```
cluster/          # cluster-scoped prerequisites (RuntimeClasses)
base/             # cognia-server StatefulSet + signaling + share + guardrails
tenant-template/  # per-tenant overlay — copy, set NAMESPACE + secrets, apply
overlays/kind/    # local kind smoke (no sandboxed runtime, 1 replica)
```

## Quick start (kind)

```bash
kind create cluster --name cognia
kustomize build deploy/k8s/overlays/kind | kubectl apply -f -
kubectl -n cognia-kind wait --for=condition=ready pod -l app=cognia-server --timeout=300s
kubectl -n cognia-kind port-forward svc/cognia-server 7890:7890
node scripts/smoke/compose-smoke.mjs --tier server   # COGNIA_SERVER_URL=https://localhost:7890
```

## Production notes (docs-only in D9)

- **Sandboxed runtime**: apply `cluster/runtimeclass-gvisor.yaml` (or kata)
  and set `runtimeClassName: gvisor` on the cognia-server pod spec via the
  tenant overlay. Requires containerd + runsc on the nodes — see the gVisor
  install docs; NOT provisioned by these manifests.
- **TLS/ACME**: terminate at your ingress controller (cert-manager +
  ingress-nginx or Caddy ingress), re-proxying to the cognia-server Service
  over its self-signed HTTPS exactly like `deploy/compose/Caddyfile` does.
- **Master key**: each tenant needs a `cognia-secrets` Secret with
  `COGNIA_MASTER_KEY` (64 hex). Rotation: `kubectl exec ... -- cognia-server
rotate-master-key --new-key ...`, then update the Secret.
- **Runners (T2-in-T3)**: `ExecBackend::Container` targets the Docker API;
  on k8s the equivalent is the pods-create/exec Role in
  `base/cognia-server-rbac.yaml` — the container backend's k8s flavor is
  tracked with R13 follow-ups.
