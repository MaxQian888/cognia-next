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

cognia-server serves HTTPS on **27890** (tracks the companion
`DEFAULT_PORT`; 7890 is the Clash proxy default).

## Quick start (kind)

```bash
kind create cluster --name cognia
kustomize build deploy/k8s/overlays/kind | kubectl apply -f -
kubectl -n cognia-kind wait --for=condition=ready pod -l app=cognia-server --timeout=300s
kubectl -n cognia-kind port-forward svc/cognia-server 27890:27890 &
kubectl -n cognia-kind port-forward svc/signaling 7892:7892 &
kubectl -n cognia-kind port-forward svc/share 8787:8787 &

# Tier-2 smoke: COGNIA_SMOKE_EXEC reroutes the loopback-only steps
# (pair, service token) from `docker compose exec` to `kubectl exec`.
SHARE_UPLOAD_SECRET=kind-smoke-secret \
COGNIA_SERVER_URL=https://localhost:27890 \
COGNIA_SMOKE_EXEC="kubectl -n cognia-kind exec -i cognia-server-0 --" \
  node scripts/smoke/compose-smoke.mjs --tier server
```

## Production notes (docs-only in D9)

- **Public URL is mandatory**: the base wires `COGNIA_PUBLIC_URL` from the
  `cognia-config` ConfigMap key `publicUrl` (kustomize `configMapGenerator`
  in every overlay). `cognia-server pair` embeds it in the `cgnp3` payload;
  leaving it unset used to advertise an unreachable loopback default.
- **Signaling has internal and public URLs**: set `signalingUrl` to the
  cluster-internal `ws://signaling:7892/v2/signaling`, and derive
  `publicSignalingUrl` from `publicUrl` as
  `wss://<public-host>/v2/signaling`. The base Ingress sends that path to the
  `signaling:7892` Service before the `/` fallback to `cognia-server`.
- **Sandboxed runtime**: apply `cluster/runtimeclass-gvisor.yaml` (or kata)
  and set `runtimeClassName: gvisor` on the cognia-server pod spec via the
  tenant overlay. Requires containerd + runsc on the nodes — see the gVisor
  install docs; NOT provisioned by these manifests.
- **TLS/ACME**: terminate at your ingress controller (cert-manager +
  ingress-nginx or Caddy ingress), re-proxying to the cognia-server Service
  over its self-signed HTTPS exactly like `deploy/compose/Caddyfile` does.
- **Multi-user auth (Logto)**: the T3 topology is the multi-tenant rung —
  wire OIDC per tenant via the `cognia-config` keys `logtoIssuer` +
  `logtoAudience` (+ optional `logtoRequiredScopes`, `logtoJwksTtlSecs`).
  Both issuer AND audience must be set to turn OIDC on. Seed flow and the
  issuer-consistency footgun: `deploy/compose/LOGTO.md`.
- **Master key**: each tenant needs a `cognia-secrets` Secret with
  `COGNIA_MASTER_KEY` (64 hex). Rotation: `kubectl exec ... -- cognia-server
rotate-master-key --new-key ...`, then update the Secret.
- **Runners (T2-in-T3)**: external agents run as **runner Pods** via the k8s
  exec backend (`COGNIA_EXEC_BACKEND=kubernetes`, `k8s-exec` build feature —
  in the published `cognia-server` images). Enable per tenant: uncomment the
  `runners/` resource + patch + the `execBackend`/`runnerImage`/
  `workspacesPvc` literals in `tenant-template/kustomization.yaml`. Each
  agent gets one pod (agent as the container's only process, stdio over pod
  attach), mounting ONLY its workspace as a `subPath` of the shared
  `cognia-workspaces` PVC. Runner pods are pinned to the server's node
  (downward API) so an RWO PVC works; with RWX storage the pinning is
  unnecessary. Not mapped from the Docker flavor by design: seccomp profile
  (use the gvisor RuntimeClass), pids limit (kubelet config), network mode
  (NetworkPolicy in `guardrails.yaml`). The pods-create/attach Role in
  `base/cognia-server-rbac.yaml` is attached via the `cognia-server`
  ServiceAccount and is inert while the backend is off.
- **Persistent shared-browser runtimes (experimental)**: create the aggregate
  per-tenant secret first (`kubectl -n <tenant> create secret generic
workspace-runtime-secrets --from-literal=<workspace-id>=<32+ char secret>`),
  then render `workspace-runtime-template.yaml` with `WORKSPACE_ID=<id>
envsubst` and apply it in the same namespace. Each rendered runtime receives
  dedicated workspace/profile PVCs, has no service-account token, and exposes
  only an internal ClusterIP. Add `remoteBrowserEnabled=true` and
  `remoteBrowserWorkspaces=<comma-separated ids>` to `cognia-config`; the base
  server mounts the same Secret read-only and resolves runtimes through
  `workspace-runtime-{workspace}:27910`. Keep the feature flag false until the
  image, Secret, PVC, and health probe exist. Never mount another workspace,
  the host filesystem, or a container-runtime socket into these pods.
