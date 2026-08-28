---
"cognia-next": patch
---

Remote browser (ADR-0085): a workspace runtime's secret is now read under the name the shipped deployments actually write — `<secret-dir>/<workspace-id>`, what the runtime container's entrypoint writes and what a `--from-literal=<workspace-id>=…` Kubernetes Secret projects — with the previously required `<workspace-id>.secret` kept as a fallback. Following the documented T2/T3 steps could not resolve a runtime before this. Development gains a single-runtime topology: `COGNIA_WORKSPACE_RUNTIME_URL` plus a shared `COGNIA_WORKSPACE_RUNTIME_SECRET`, accepted only for a loopback host, so `pnpm dev:web-headless` can start the runtime alongside the web app and the Host and serve the remote browser out of the box.
