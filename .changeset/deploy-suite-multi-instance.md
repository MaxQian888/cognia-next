---
"cognia-next": patch
---

Self-host deploy suite: several compose instances can now share one host and one Docker daemon. `COGNIA_INSTANCE` names the compose project, the T2 workspaces volume and the runner ownership label, every published host port is overridable, and `cognia-server` stamps a persisted per-deployment id on the agent containers it creates so the boot-time orphan sweep never removes another deployment's live runners. The `cognia-web` front-door image is now published by `images.yml`, the production override requires `COGNIA_PUBLIC_URL`, and the deploy-agent, ops-controller, web and workspace-runtime images build on the repository's pinned Rust, Node and pnpm versions (guarded by the new `audit:deploy-suite` gate).
