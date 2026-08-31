# CI/CD Pipeline Documentation

How this repository verifies itself: which checks exist, where each one runs,
what to do when one goes red, and how to set up the optional integrations.

> **Historical note, because it explains several decisions below.** The main
> pipeline (`ci.yml`) had **never completed a single run**. All 205 runs since
> the repository's first commit ended in `startup_failure`, so `quality.yml`,
> `test.yml` and `build-tauri.yml` had zero executions between them. The cause
> was a permissions escalation: `build-tauri.yml` declared
> `permissions: contents: write` while `ci.yml` calls it with the repository's
> read-only default token, and a called workflow may not request more scope
> than its caller holds. The write scope now lives on the caller
> (`release.yml`). Everything below is arranged so a failure of that shape is
> visible instead of silent.

---

## Tiers

| Tier         | Trigger                           | Runs                                                                     |
| ------------ | --------------------------------- | ------------------------------------------------------------------------ |
| **Hot path** | push to `dev`/`master`, any PR    | `ci.yml` → `quality.yml` + `test.yml` → stable `CI Gate`                 |
| **Nightly**  | `nightly.yml`, 03:00 UTC + manual | full test matrix, 4-platform Tauri bundles, Tauri E2E (Windows), iOS E2E |
| **Release**  | `v*` tag                          | `release.yml` → quality + test + signed Tauri release                    |
| **Report**   | `workflow_run` after the hot path | `report.yml` → PR comment + job summary                                  |
| **Services** | changes under `services/**`       | `share-server.yml`, `signaling-server.yml`, `compose-e2e.yml`            |
| **Deploy**   | manual, opt-in                    | `deploy.yml` (see below)                                                 |

Tauri **bundling** is deliberately off the hot path — it is the largest
wall-clock item in the repo. The Tauri crate is still compiled on every run:
`cargo-test-windows` builds the static export and then runs `cargo test`
inside `src-tauri`, which is a full compile of the desktop app.

`CI Gate` is the only check branch protection should require. It uses
`if: always()` and fails unless both reusable workflows complete successfully,
so adding, renaming, or sharding an internal job cannot silently weaken the
required-check set. Enable it only after the commit that introduces the gate is
present on `dev`; requiring a check that the default branch cannot emit locks
every PR out.

`schedule` only fires from the repository's **default branch**. That is why
the nightly tier lives in its own top-level workflow instead of a `schedule:`
key inside `test.yml`: the old arrangement silently never ran, because the
default branch's copy of `test.yml` had no schedule.

### Concurrency

Every workflow that is triggered by a ref declares a `concurrency` group keyed
on that ref. Hot-path runs use `cancel-in-progress: true` so a rapid series of
pushes does not queue; `release.yml` and `nightly.yml` use `false`, because
cancelling a half-built release is worse than letting it finish.

`build-tauri.yml` deliberately declares none. It is `workflow_call` only — it
has no ref of its own to key on, and it runs the tagged release build, so a
group that could cancel it is exactly the hazard the `false` above avoids. Its
caller (`release.yml`) owns the concurrency decision.

---

## Quality gates

The gate list lives in exactly one place: **`scripts/gates/check-all.mjs`**.

```bash
pnpm check:all                    # every gate, in CI order
pnpm check:all -- --runtime node  # skip the python/rust gates
pnpm check:all -- --group audit   # one CI group
pnpm check:all -- --bail          # stop at the first failure
```

`quality.yml` does not restate the list. Its `prepare` job calls
`check-all.mjs --list-groups --json` and the `gates` job fans out one runner
per group with `fail-fast: false`, so a single run reports **every** failure
rather than stopping at the first.

**Adding a gate**: add it to `REGISTRY` in `check-all.mjs`. Nothing in the
workflow changes — a brand-new group becomes a new matrix entry automatically.
`pnpm gates:registry` fails the build if a verification-shaped script exists
that is neither registered nor exempted with a written reason.

| Group          | What it covers                                                                                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lint`         | ESLint                                                                                                                                                                                                                                                              |
| `format`       | Prettier                                                                                                                                                                                                                                                            |
| `types`        | root `tsc`, Knip, browser-extension typecheck, web-site typecheck                                                                                                                                                                                                   |
| `i18n`         | key parity, hardcoded-string baseline, generated-bundle freshness, deterministic key ordering                                                                                                                                                                       |
| `artifacts`    | generated files match their sources (`build:packages`, skills, plugin bundles, plugin contract)                                                                                                                                                                     |
| `audit`        | repo-specific structural audits — slots, trusted publishers, silent-failure flags, PII boundaries, command parity, E2E governance, co-located tests, DB-fixture ratchet, static export, plugin-SDK WIT, plugin author imports, and repository instruction freshness |
| `sync`         | mirrored config/version files agree                                                                                                                                                                                                                                 |
| `gate-tests`   | the gate tooling's own `node --test` suites                                                                                                                                                                                                                         |
| `plugin-sdk`   | the SDK's TS / Python / Rust contract surface                                                                                                                                                                                                                       |
| `rust`         | `cargo fmt --check`, ratcheted clippy                                                                                                                                                                                                                               |
| `supply-chain` | blocking `pnpm audit` and `cargo deny`; exceptions must name an exact advisory and explain why no safe upgrade exists                                                                                                                                               |

---

## Test and build runners

Six runners, each with one owner:

| Runner                           | Scope                    | Where it runs                                                                     |
| -------------------------------- | ------------------------ | --------------------------------------------------------------------------------- |
| Jest (`node` + `jsdom` projects) | 5,600+ co-located suites | `test.yml`, 4 coverage shards                                                     |
| `node --test` (scripts)          | `scripts/**/*.test.mjs`  | `quality.yml`, `gate-tests` group                                                 |
| `node --test` (sidecar)          | `sidecar/**`             | `test.yml`, `sidecar` job                                                         |
| Playwright                       | `tests/e2e/**`           | `test.yml` — chromium + mobile-pixel-7, 2 shards each; tauri + iOS nightly        |
| `cargo test`                     | 23 crates                | `test.yml` — `--workspace --exclude cognia-next` on Linux, `src-tauri` on Windows |
| pytest                           | `plugin-sdk/python`      | `quality.yml`, `plugin-sdk` group                                                 |
| Agent conformance                | real sidecars + server   | `test.yml`, dedicated conformance job                                             |

The hot path also builds the docs site, web site, Android debug app, root
static export, and Tauri frontend contract as independent jobs. The iOS
simulator build runs on manual/nightly executions because it requires a macOS
runner. Nightly Tauri packaging does not depend on the test job, so a test
failure no longer hides whether packaging itself is broken.

`src-tauri` is excluded from the Linux workspace run because its
`tauri::generate_context!()` needs the Next.js static export at compile time;
the Windows job builds the export first and covers it there.

---

## Coverage

Two levels, and they are not the same number.

- **Changed files: ≥90% per file** for lines/branches/functions — the real bar
  for anything you touch. `pnpm test:coverage:changed -- --strict`, gated on
  every PR. One well-covered file cannot subsidize another changed file.
- **Repo-wide: layered floors** in `scripts/test/coverage-thresholds.json`,
  enforced by `scripts/test/merge-coverage.mjs --check` after the shards
  merge. They sit far below 90. `pnpm coverage:ratchet` reports which floors
  have gained enough headroom to raise; `-- --write` locks the gain in.

Jest shards run with `--coverageThreshold='{}'` because a shard only sees
partial coverage for files whose tests landed elsewhere; the real gate is the
merge job.

---

## Baselines and ratchets

Several gates record pre-existing debt instead of failing on it. In every case
the recorded list **may only shrink**, and anything new is a hard failure.

| Gate                   | Baseline file                                | Regenerate with                                  |
| ---------------------- | -------------------------------------------- | ------------------------------------------------ |
| Hardcoded i18n strings | `scripts/i18n-baseline.json`                 | `pnpm lint:i18n:baseline`                        |
| Co-located tests       | `scripts/gates/colocated-test-baseline.json` | `pnpm audit:colocated-tests -- --write-baseline` |
| Clippy                 | `scripts/gates/clippy-baseline.json`         | `pnpm rust:clippy -- --write-baseline`           |
| E2E governance         | `scripts/e2e/governance-exceptions.json`     | hand-edited, entries carry `reviewAfter`         |
| Coverage floors        | `scripts/test/coverage-thresholds.json`      | `pnpm coverage:ratchet -- --write`               |
| DB fixture migration   | `scripts/test/db-fixture-baseline.json`      | shrink only after adopting `createDbTestFixture` |
| Advisory waivers       | `pnpm-workspace.yaml` `auditConfig`          | hand-edited, entries carry a reason + date       |

Advisory waivers are the one list that lives in two files: `pnpm audit` reads
`pnpm-workspace.yaml`, and the `audit:deps` script repeats the same ids as
`--ignore` flags. JSON cannot hold the reason, so the justification and review
date belong beside the ids in the YAML.
`scripts/ci/workflow-contract.test.mjs` fails when the two lists drift or when a
waived id has no comment above it.

Regenerating a baseline to make a red build green is the failure mode these
are most exposed to. Regenerate only after _fixing_ something; the gates print
how many entries became removable so the gain is visible.

---

## Reports

Reporting is two-stage, and the split is load-bearing rather than stylistic.

1. **In-run** — every gate group writes a ✓/✗ table to `GITHUB_STEP_SUMMARY`.
   No token, no artifacts, no second workflow: it works even when stage two
   cannot run.
2. **`report.yml`** — triggered by `workflow_run`, so it executes in the base
   repository's context and may legally hold `pull-requests: write`. It
   downloads the run's artifacts, downloads the same artifacts from the trunk
   branch's last successful run as a baseline, and upserts a single PR comment.

The main pipeline cannot post comments itself. It runs on the read-only
default token, fork and Dependabot PRs get read-only tokens that `permissions:`
cannot escalate, and requesting write inside a called workflow is precisely
what broke the pipeline before.

The report covers: failed Jest tests with messages, slowest suites, Playwright
failures, **flaky specs** (passed only on retry — otherwise invisible, since
`retries: 1` reports them green), coverage deltas, and bundle-size deltas.

Nothing is persisted: no metrics branch, no committed snapshots. The trade-off
is that trends are always "versus the trunk branch's last green run", and
cross-run flake history is not available.

---

## Caching

| Cache                      | Key                                      | Job                                                                     |
| -------------------------- | ---------------------------------------- | ----------------------------------------------------------------------- |
| pnpm store                 | lockfile hash (via `actions/setup-node`) | all Node jobs                                                           |
| Next.js `.next/cache`      | lockfile + source hash                   | `build`, `build-e2e` (separate keys — the E2E flag changes the output)  |
| TypeScript `*.tsbuildinfo` | lockfile + source hash                   | `gates (types)` — advisory; stale or missing falls back to a full check |
| Playwright browsers        | lockfile hash                            | `e2e`                                                                   |
| cargo `target/`            | `Swatinem/rust-cache`                    | every Rust job                                                          |

---

## Artifacts

| Artifact              | Retention | Description                                                |
| --------------------- | --------- | ---------------------------------------------------------- |
| `jest-shard-*`        | 7 days    | per-shard istanbul map + JUnit XML                         |
| `coverage-report`     | 30 days   | merged coverage (`coverage-final.json`, lcov, HTML)        |
| `bundle-size`         | 30 days   | structured static-export measurement (feeds the size diff) |
| `playwright-report`   | 14 days   | merged HTML report                                         |
| `playwright-json`     | 14 days   | merged JSON report (feeds failure + flake reporting)       |
| `playwright-traces-*` | 14 days   | traces and screenshots, failures only                      |
| `nextjs-build`        | 7 days    | the static export                                          |
| `nextjs-build-e2e`    | 3 days    | `NEXT_PUBLIC_E2E=1` export consumed by the e2e jobs        |

`report.yml` reads `coverage-report` and `bundle-size` from **both** this run
and the trunk branch's last successful run — which is why their retention is
longer than the rest.

---

## Optional integrations and secrets

The pipeline works out of the box with **no secrets**. Each item below is
opt-in.

### Tauri updater signing (required for a real release)

- `TAURI_SIGNING_PRIVATE_KEY` — base64 of the updater private key
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — its password (`""` if none)

`bundle.createUpdaterArtifacts: true` in `tauri.conf.json` makes the build
sign the bundles; without these a tagged build **fails by design**, because an
unsigned release would be un-updatable. See `src-tauri/UPDATER.md`.

### Service deployments (`deploy.yml`, manual/opt-in)

`workflow_dispatch` only — never on push. Targets (ADR-0059 P0.1):

| Target             | Platform          | Source                              |
| ------------------ | ----------------- | ----------------------------------- |
| `signaling-worker` | Cloudflare Worker | `services/signaling-server/worker/` |
| `share-worker`     | Cloudflare Worker | `services/share-server/worker/`     |
| `signaling-fly`    | Fly.io (axum)     | `services/signaling-server/`        |
| `share-fly`        | Fly.io (axum)     | `services/share-server/`            |

Dispatch inputs: `environment` (`staging` / `production`) and `target` (`all`,
`workers`, `fly`, or one of the four above). Staging Workers deploy via the
`[env.staging]` stanzas in each `wrangler.toml`.

Three gates keep forks green with zero configuration: manual trigger only, the
repository variable `DEPLOY_ENABLED` must be the string `true`, and each
platform job requires its secret to be present. A failing gate **skips** the
job rather than failing it.

The GitHub Environments `staging` and `production` hold the same names, so the
workflow reads one set:

| Kind     | Name                       | Notes                                        |
| -------- | -------------------------- | -------------------------------------------- |
| secret   | `CLOUDFLARE_API_TOKEN`     | Workers deploy token                         |
| secret   | `FLY_API_TOKEN`            | `fly tokens create deploy`                   |
| variable | `CLOUDFLARE_ACCOUNT_ID`    |                                              |
| variable | `CF_SHARE_KV_NAMESPACE_ID` | injected into `wrangler.toml` at deploy time |
| variable | `FLY_SIGNALING_APP`        | e.g. `cognia-signaling` / `-staging`         |
| variable | `FLY_SHARE_APP`            | e.g. `cognia-share` / `-staging`             |

Give `production` protection rules (required reviewers, branch restriction)
under **Settings → Environments**. One-time provisioning per environment is
documented in each service README: R2 bucket, KV namespace,
`wrangler secret put SHARE_UPLOAD_SECRET`, `flyctl volumes create share_data`.

### Codecov

- `CODECOV_TOKEN` — the integration is commented out in `test.yml`.

### Windows code signing

- `WINDOWS_CERTIFICATE` — base64-encoded PFX certificate
- `WINDOWS_CERTIFICATE_PASSWORD`

```powershell
# Convert PFX to base64
$bytes = [System.IO.File]::ReadAllBytes("certificate.pfx")
$base64 = [System.Convert]::ToBase64String($bytes)
$base64 | Out-File certificate.txt
```

### macOS code signing and notarization

- `APPLE_CERTIFICATE` — base64-encoded `.p12`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY` — Developer ID Application identity
- `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID`

```bash
# Export the certificate from Keychain as .p12, then:
base64 -i certificate.p12 -o certificate.txt
```

App-specific password: <https://appleid.apple.com> → Security → App-Specific
Passwords.

Authenticated OS signing stays **disabled** by default; macOS still receives
the ad-hoc identity configured in `tauri.conf.json` so Apple Silicon accepts
Internet-downloaded bundles.

```json
{
  "bundle": {
    "macOS": {
      "signingIdentity": "Developer ID Application: Your Name (TEAM_ID)",
      "entitlements": "path/to/entitlements.plist"
    },
    "windows": {
      "certificateThumbprint": null,
      "digestAlgorithm": "sha256",
      "timestampUrl": "http://timestamp.digicert.com"
    }
  }
}
```

---

## Releasing

```bash
pnpm changeset          # during development, per user-facing change
pnpm release:version    # consumes the changesets, bumps + syncs every artifact
git tag v1.0.0 && git push origin v1.0.0
```

The tag triggers `release.yml`: quality → test → `build-tauri.yml` with
`tagName`. `tauri-action` creates the release **published, not draft** —
`releases/latest` only resolves to a published release, and the in-app updater
points at `releases/latest/download/latest.json`, so a draft would leave the
updater endpoint 404-ing.

---

## When something is red

```bash
pnpm check:all -- --group <group>        # reproduce one CI group locally
pnpm test -- path/to/file.test.ts        # one Jest suite
pnpm test:coverage:changed -- --strict   # the 90% bar on your changed files
node scripts/gates/check-all.mjs --list-groups   # what groups exist
```

Every gate script prints its own fix instruction. If one tells you to run a
command that does not exist, that is a bug in the gate — fix the message, not
just the symptom. (Two such dangling references existed before this document
was rewritten.)

**Tests fail in CI but pass locally** — check the Node version matches, that
`pnpm-lock.yaml` is committed, and that the suite does not depend on local
state (`pnpm clean:db`).

**Tauri build fails** — Linux: system dependencies; Windows: Rust toolchain;
macOS: Xcode Command Line Tools. Then review `src-tauri/tauri.conf.json`.

**Code signing fails** — verify the secrets exist, the certificate has not
expired, and the signing identity matches the certificate.

Never bypass a hook with `--no-verify`. If a hook fails, fix the cause,
re-stage, and make a **new** commit.

### Branch protection

The default branch is `dev`. It must require pull requests and the single
status check `CI Gate`; do not require matrix child names such as
`Quality / Gates (types)` because those are intentionally free to evolve. The
repository currently has no protection rule, so this is a required deployment
step after the repaired workflow has landed and emitted `CI Gate` at least
once.

---

## Cost

The repository is **public**, so GitHub-hosted standard runners are free and
minutes are not the constraint — wall clock and noise are. That is what the
tier split optimizes for: the hot path avoids the 4-platform Tauri matrix, and
`cancel-in-progress` discards superseded runs.

---

## Additional resources

- [GitHub Actions documentation](https://docs.github.com/en/actions)
- [Tauri documentation](https://tauri.app/)
- [Tauri code-signing guide](https://tauri.app/v1/guides/distribution/sign-macos)
- [Next.js static exports](https://nextjs.org/docs/app/building-your-application/deploying/static-exports)
