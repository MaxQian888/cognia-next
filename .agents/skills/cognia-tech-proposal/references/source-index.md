# Cognia proposal evidence index

Use this as a discovery map. Always verify the selected files exist and reflect the current branch.

## Repository authority

| Need | Start here |
|---|---|
| Global working/testing rules | `AGENTS.md`, `CLAUDE.md`, nearest nested instructions |
| Product architecture | `README.md`, `CONTEXT.md`, `WORKFLOW.md` |
| Build and CI | `package.json`, `pnpm-workspace.yaml`, `Cargo.toml`, `.github/workflows/`, `CI_CD.md` |
| Testing | `TESTING.md`, `jest.config.ts`, `playwright.config.ts`, `tests/e2e/README.md` |
| ADRs | `docs/content/docs/en/adr/` and matching `docs/content/docs/zh/adr/` |
| Current proposals/remediation | `docs/plans/` |
| Historical evidence | `docs/plans/archive/`, only with explicit date/status |
| Deployment | `deploy/`, `services/`, Dockerfiles, service manifests |
| Plugin contracts | `plugins/`, `plugin-sdk/`, `packages/plugin-sdk/`, WIT and gate scripts |

## Exemplar selection

Choose 1–2 documents matching the **same subsystem and document type**:

- architecture/protocol: relevant ADR plus current cross-layer plan;
- migration/remediation: current `docs/plans/YYYY-MM-DD-*.md` with evidence labels and work packages;
- E2E governance: `tests/e2e/README.md` plus the current module coverage plan;
- plugin/SDK: plugin contract ADR and current conformance audit;
- mobile/remote runtime: owning ADR plus current remediation/deployment plan.

Do not copy conclusions, counts, line numbers, or status from an exemplar. Copy only effective structure and evidence discipline.

## Evidence capture

For each important claim record:

| Claim | Status | Source | Verification |
|---|---|---|---|
| | confirmed/inferred/open | file + symbol/section | command or reading |

Prefer symbols/test names over absolute line ranges. Keep error messages verbatim when they drive the design.

## External sources

Use primary, current sources for version-sensitive library/API/cloud facts. Record version and retrieval date. Repository behavior still requires local source verification.

For Lark PRDs/designs, fetch the complete relevant document/section through the proper Lark skill. Do not embed private document tokens in the reusable skill or proposal template.
