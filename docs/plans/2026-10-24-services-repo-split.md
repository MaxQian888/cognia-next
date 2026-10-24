# Split `services/` into `cognia-labs/cognia-services`

Date: 2026-10-24. Status: P0–P2 done (cognia-services pushed, this repo consumes it at the pin); P3 secrets and environments are the operator's. Ownership guide: `docs/development/services-extraction.md`.

## Decisions (user, 2026-10-24)

| #   | Decision                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | One public repository, `cognia-labs/cognia-services`. Every service keeps building on its own (own lockfile, own CI lane, own deploy).                    |
| D2  | `services/workspace-runtime` stays in this repo: the desktop bundles it as the local browser runtime, it builds from the repo root and the root lockfile. |
| D3  | The services repository **owns** the shared wire contracts: `cognia-signaling-core`, `@cognia/sync-protocol`, and the status v1 contract.                 |
| D4  | Git history is kept (`git filter-repo`), including the pre-relocation `signaling-server/` and `share-server/` paths.                                      |

Precedent: `cognia-labs/cognia-website` (e412204bd) and `cognia-labs/cognia-browser-extension`
(fc7a8a307, pin file `integrations/browser-companion.json` + `scripts/ci/check-browser-companion-contract.mjs`).

## Evidence gathered

- Rust: copied out of the tree, `cargo metadata --offline` resolves for `signaling-server`,
  `signaling-server/worker`, `share-server`, `diagnostic-server`. All are their own Cargo workspaces
  (root `Cargo.toml` lists signaling/share under `exclude`), each with its own `Cargo.lock`; the
  Dockerfiles build with the service directory as context.
- Node: every Worker has its own `package.json` + `pnpm-lock.yaml` + Vitest; root Jest/ESLint ignore them.
- History: filtered history = 89 commits from 2026-05-17, ~2 MB `.git` (scratch copy in
  `~/.services-split/repo`, branch `src`, built from `origin/dev` fc7a8a307).
- Secret scan: `gitleaks` over the filtered history reports 40 `generic-api-key` hits, all triaged
  as test material: sync-protocol fixtures (counting-byte keys), Worker test configs
  (`SHARE_GRANT_KEY` = ASCII `0123…`, `IP_BUCKET_SECRET: "test-ip-bucket-secret-…"`), and the
  RFC 6455 sample `Sec-WebSocket-Key`. Production configs only hold `REPLACE_WITH_…` placeholders.
- Licence: AGPL-3.0 (copied as is).

### Coupling inventory

Outbound (service → this repo):

| Service             | Coupling                                                                                                                                                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `diagnostic-server` | none                                                                                                                                                                                                                                                                              |
| `identity-server`   | none in code; `scripts/build/build-sign-in-icons.mjs` here generates `src/pages/page-icons.ts` from `public/icons/cognia-mobile-spots/png`                                                                                                                                        |
| `update-server`     | none (the offline signer `scripts/release/update-catalog.mjs` stays here, it only calls the admin API)                                                                                                                                                                            |
| `logto-email`       | no `package.json`; its `*.test.ts` run under the root Jest; `scripts/smoke/logto-email-runtime.mjs` borrows `identity-server`'s `node_modules`                                                                                                                                    |
| `share-server`      | Rust `tests/grant_wire_parity.rs` and `worker/src/grant-parity.test.ts` read `crates/cognia-tenant-auth/fixtures/grant-wire-vector.json`                                                                                                                                          |
| `signaling-server`  | `core/` is a path dependency of `src-tauri`, `cognia-companion`, `cognia-companion-connectivity`; `webrtc:crypto-vector` runs its Rust half from here                                                                                                                             |
| `sync-server`       | `link:../../packages/sync-protocol` + its `fixtures/v1*.json`                                                                                                                                                                                                                     |
| `status-server`     | ~60 relative imports of `lib/status/{contract,config,derive,signing,validate,fixtures}.ts`, `lib/signaling/relay-health.ts`, `lib/constants/external-urls.ts` (via `config.ts`); deploy needs the status-only export built by `scripts/build/build-status-site.mjs` from this app |

Inbound (this repo → services): root `package.json` scripts (`update:worker:*`, `webrtc:crypto-vector`,
`webrtc:smoke`), `eslint.config.mjs` / `jest.config.ts` ignores, `scripts/smoke/{signaling-smoke,logto-email-runtime}.mjs`,
`scripts/gates/check-deploy-suite.mjs`, `scripts/ci/workflow-contract.test.mjs`, workflows
(`signaling-server`, `share-server`, `sync-server`, `identity-server`, `deploy`, `images`, `compose-e2e`,
`server-build-benchmark`, `quality` L237-238, `test` diagnostic lane), `deploy/compose/*.yml` image
defaults `ghcr.io/maxqian888/cognia-{signaling,share}`, CLAUDE.md / AGENTS.md / CI_CD.md / README, docs pages.

## Target layout of `cognia-services`

```
services/<diagnostic|identity|logto-email|share|signaling|status|sync|update>-server…   paths unchanged
packages/sync-protocol/       @cognia/sync-protocol (unchanged, source-only TS)
packages/status-contract/     @cognia/status-contract ← lib/status/{contract,config,derive,signing,validate,fixtures}
                              + lib/signaling/relay-health + STATUS_PAGE_URL
integrations/cognia-next.json pin of the app revision whose static export feeds the status Worker
.github/workflows/            one lane per service + images + deploy (ported, not rewritten)
```

Keeping `services/` paths unchanged means imported history and the relative imports inside
`status-server` (probe ↔ worker ↔ `signaling-server/worker/tests/synthetic-room.mjs`) stay valid.

## Consumption model in this repo (D3)

One pin, `integrations/cognia-services.json` `{ repository, revision }` (40-hex SHA), mirrored into:

- Cargo: `cognia-signaling-core = { git = "https://github.com/cognia-labs/cognia-services", rev = "<sha>" }`
  in `src-tauri`, `crates/cognia-companion`, `crates/cognia-companion-connectivity`.
- pnpm (≥ 11.7 keeps `path` in the lockfile; we run 11.18):
  `"@cognia/sync-protocol": "git+https://github.com/cognia-labs/cognia-services.git#<sha>&path:/packages/sync-protocol"`,
  same for `@cognia/status-contract`; root and `cli/package.json`.
- A gate (`scripts/ci/check-cognia-services-pin.mjs` + test) fails when any of those three spellings
  disagrees with the pin file.
- A pinned-consumer CI job checks out `cognia-services@pin` and verifies the cross-repo vectors:
  grant-wire vector byte-equality (tenant-auth here ↔ share-server copy there) and the signaling
  room-id vector (TS `lib/signaling/crypto.test.ts` here, Rust core there).

Contract changes therefore land in `cognia-services` first, then a pin bump PR here.

## Phases

### P0 — Create the repository (outward-facing; needs explicit go)

1. Re-run the filter on the then-current `origin/dev` (scratch recipe below), re-run gitleaks.
2. Add a bootstrap commit: README (what lives here, how each service builds, the pin model),
   LICENSE, `.gitignore`, `.nvmrc` (Node 26), `rust-toolchain.toml` (copy of ours).
3. `gh repo create cognia-labs/cognia-services --public`, push `main`.

### P1 — Make `cognia-services` self-sufficient (all work in that repo)

1. `packages/status-contract`: move the six `lib/status` leaf files + tests and
   `lib/signaling/relay-health{,.test}.ts` with `git mv` (history follows), inline `STATUS_PAGE_URL`,
   add `package.json` (source-only, same `cognia-source` export shape as sync-protocol), `tsconfig`,
   Vitest. Drop `lib/status/public-status.ts` (it is the app's barrel). Rewrite the status-server
   imports to `@cognia/status-contract` via `link:` (as sync-server already does).
2. `services/logto-email`: `package.json` + Vitest config; move `scripts/smoke/logto-email-runtime.mjs`.
3. `services/share-server`: copy `grant-wire-vector.json` into `share-server/fixtures/`, repoint the
   Rust and Worker parity tests.
4. Move `scripts/smoke/signaling-smoke.mjs` (+ its route-config test) next to signaling-server.
5. Port workflows with paths re-rooted: signaling, share (+ update Worker), sync, identity,
   status (new lane: worker/probe/admin tests), diagnostic (from `test.yml`), logto-email,
   images (`ghcr.io/cognia-labs/cognia-{signaling,share,diagnostics}`), compose-e2e (diagnostic
   compose project), deploy (all Workers + Fly). The status deploy job checks out
   `MaxQian888/cognia-next@<integrations/cognia-next.json>` to run `build-status-site.mjs --dest`.
6. Exit check: every lane green on `cognia-services` from a fresh clone.

### P2 — Switch this repo (one change, after P1 is green)

1. Pin file + Cargo git deps + `Cargo.lock`; pnpm git deps + `pnpm-lock.yaml`; `tsconfig.json`
   paths, `jest.config.ts` mapper, `next.config.ts` `transpilePackages` → the installed packages.
2. `lib/status/public-status.ts` re-exports `@cognia/status-contract` (+ its local helper); direct
   `lib/status/<leaf>` importers move to the package; `lib/signaling/relay-health.ts` importers
   (`lib/network/net-meter.ts`, `lib/signaling/relay-probe.ts`, `hooks/use-network-meter.test.ts`)
   likewise; `lib/constants/external-urls.ts` re-exports `STATUS_PAGE_URL`.
3. Delete `services/*` except `workspace-runtime`, `packages/sync-protocol`, the moved `lib/status`
   leaves; drop the root scripts, ESLint/Jest ignores, moved smoke scripts, moved workflows/jobs.
4. Add the pin gate and the pinned-consumer job; `webrtc:crypto-vector` keeps its TS and host halves.
5. `build-sign-in-icons.mjs`: `--identity-root <cognia-services checkout>` for the identity module.
6. `deploy/compose/*.yml` defaults → `ghcr.io/cognia-labs/cognia-{signaling,share}`; compose-e2e and
   server-build-benchmark build from the pinned checkout.
7. Docs: CLAUDE.md Subsystem Map rows (Relay, Public status, Official account, Diagnostic service,
   Public share links), AGENTS.md, CI_CD.md, README(_zh), subsystem docs links. ADRs stay as written.
8. Gates: `audit:colocated-tests` baseline rows for deleted paths, `workflow-contract.test.mjs`,
   `check-deploy-suite`, `pnpm install --frozen-lockfile`, typecheck, the affected Jest suites
   (`lib/account-sync`, `components/status`, `hooks/status`, `lib/signaling`, `cli/src/account-sync`),
   `cargo check -p app_lib` (git dep resolution). No changeset: internal-only.

### P3 — Cut-over (needs the user)

1. Recreate GitHub Environments `staging` / `production` on `cognia-services` with the same secret
   and variable names as `deploy.yml` (Cloudflare token/account, D1/KV ids, Fly token, `DEPLOY_ENABLED`);
   org-level secrets are an option. Values are not readable from here.
2. One staging deploy from `cognia-services`, then remove the deploy jobs here (done in P2.3 but
   gated on this step if P2 lands first).
3. Old `ghcr.io/maxqian888/cognia-{signaling,share}` images stay published for existing compose users.

## Risks

| Risk                                                                            | Mitigation                                                                                   |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Source-only TS from a git dependency is not transpiled (Next, Jest, CLI bundle) | `transpilePackages` + Jest mapper; P2 gates include CLI build and `pnpm build` in CI         |
| Contract change now needs two PRs                                               | Accepted by D3; the pinned-consumer job catches drift on every pin bump                      |
| Status Worker deploy now depends on a pinned app revision                       | Pin file in `cognia-services`; bumping it is the release step for status UI changes          |
| Other sessions edit `services/` here between P0 and P2                          | Re-run the filter on the latest `origin/dev` right before push; diff `services/` at P2 start |
| Local disk (≈4 GB free) for cargo/`pnpm build` verification                     | Heavy builds run in CI; locally only `cargo metadata/check` and targeted Jest                |

## Scratch recipe (history import)

```bash
S=~/.services-split; git init -q -b main $S/repo && cd $S/repo
git fetch -q --no-tags /Users/bytedance/Project/cognia-next refs/remotes/origin/dev:refs/heads/src
git symbolic-ref HEAD refs/heads/src
git filter-repo --force --refs src --path services/ --path signaling-server/ --path share-server/ \
  --path packages/sync-protocol/ --path lib/status/ \
  --path lib/signaling/relay-health.ts --path lib/signaling/relay-health.test.ts
git filter-repo --force --refs src --invert-paths --path services/workspace-runtime/
gitleaks git --log-opts=src --redact .
```
