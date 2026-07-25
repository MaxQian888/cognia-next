# User paths and coverage audit

## 1. Evidence priority

Establish facts in this order:

1. Current diff and product/protocol source.
2. Current-branch specs, helpers, mocks, config, governance ledger, and run results.
3. Current `AGENTS.md`, E2E README, package scripts, and CI jobs.
4. Source-controlled product-path or coverage documents that still match the UI.
5. Git history or archived plans, only to explain drift.

Do not edit untracked path assets or treat dated coverage counts as current truth.

## 2. One path, one observable result

```text
precondition | entry | action/request sequence | observable result | diagnostic signal
```

- Split platform, runtime-mode, permission, provider, or failure branches when they produce independent contracts.
- UI steps use current accessible names.
- Protocol steps name the public request/event and key state transition.
- Do not bury multiple failure branches in one happy path.

## 3. Coverage status

- `✅ covered`: same precondition, action, and result have effective assertions.
- `⚠️ partial`: the route is exercised but a key result, failure, persistence, reload, or native assertion is missing.
- `❌ uncovered`: no owning test, or the candidate proves a different layer.
- `⏭️ skipped`: runtime condition or project gate skips it; name the affected combinations and governance entry.
- `🧱 blocked`: no stable entry, helper, mock route, observable signal, platform, or environment.

Read arrange/action/assert, not only file or test names. Match runtime skips to source conditions and the exact debt ledger occurrence.

## 4. Gap ledger

| Path/contract | Evidence (source + current test) | Status | Missing assertion or harness | Owning layer/project | Verification command |
|---|---|---|---|---|---|

Each row must:

- cite real files and symbols/test names, avoiding line numbers that drift;
- state an executable gap, not “coverage insufficient”;
- distinguish product missing, harness missing, platform unavailable, and environment unavailable;
- choose the narrowest owning layer;
- identify whether static export, Pixel, WebKit, or Tauri evidence is required.

## 5. Priority

Prioritize:

1. P0/P1 zero coverage, permanent skip, or expired governance debt.
2. Data loss, permissions, account/runtime lifecycle, offline/reconnect, protocol compatibility, and native boundary failures.
3. Regressions that reached users or escaped lower-layer tests.
4. High-value combinations supported by current helpers.
5. Stub contracts whose executor now exists and can replace editor-only theatre.

Deprioritize duplicate happy paths, implementation details, and behavior dominated by nondeterministic external systems without a stable contract.

## 6. Audit procedure

1. Derive behavior contracts from the request/diff.
2. Locate product entry, observable state, persistence, and error UI/protocol.
3. Search specs/helpers for those symbols and adjacent actions.
4. Read full candidate arrange/action/assert and project gates.
5. Run target `--list`, governance audit, and the closest focused spec.
6. Fill the ledger and conclude add/update/exempt.
7. If implementing, start with the highest-value row that does not require a speculative harness.
