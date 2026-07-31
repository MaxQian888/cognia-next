# Workflow E2E

## Scope and ownership

`tests/e2e/workflows/**` covers distinct contracts:

- editor canvas, dialogs, command palette, import/export, save/reopen;
- node configuration and persistence under `nodes/**`;
- engine routing, loop, split/join, nesting, and failure under `engine/**`;
- run list/detail/history/replay under `runs/**`;
- connector, chat, cron, webhook, and GitHub trigger/delivery flows.

Read `tests/e2e/helpers/workflow-spec-helpers.ts`, `seed-workflow.ts`, the closest spec, and the owning node/runtime implementation before editing.

## Contract selection

- Editor-only contract: assert form/canvas state and persisted workflow.
- Executor contract: run the workflow and assert node outputs, status, routing, and terminal result.
- Run-history contract: assert recorded events and reload/replay behavior.
- External delivery contract: use the existing deterministic mock and assert the request payload plus product-visible state.
- Desktop automation node: a browser editor persistence assertion is not proof of a real OS action; use the owning native/integration layer for execution.

Do not present a “node can be placed and saved” spec as proof that its executor works. The governance gate tracks known stub contracts; new stub theatre is forbidden.

## Commands

```bash
rtk pnpm test:e2e:workflows -- --list
rtk pnpm exec playwright test --project=chromium \
  tests/e2e/workflows/<target>.spec.ts --workers=1
rtk pnpm test:e2e:workflows:nodes
rtk pnpm test:e2e:workflows:editor
rtk pnpm test:e2e:workflows:runs
rtk pnpm audit:e2e-governance
```

Verify exact package-script argument forwarding before relying on an appended flag or path.

## Isolation

- Reset Cognia DB before each behavior when persistent data can leak.
- Seed through existing helpers and public test bridges.
- Keep execution inputs deterministic; avoid external network calls.
- Assert persisted graph and runtime outcome separately when both are contracts.
- For cycles/loops, assert bounded iteration and terminal status rather than elapsed time.
