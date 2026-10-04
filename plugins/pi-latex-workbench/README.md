# Pi LaTeX Workbench for Cognia

**English** · [简体中文](README.zh-CN.md)

An installable Cognia desktop plugin that packages the
[Pi LaTeX Workbench](https://github.com/Arxtect/pi-latex-workbench) — a
controlled agent workbench for LaTeX projects in which every edit lands on a
content-addressed snapshot, protected content stops at host-only approval
gates, and a release ships only after a digest-bound grant and a clean-room
rebuild.

The plugin offers the workbench three ways:

1. **Cognia agents** use the workbench's host CLI (`latexwb`) through 27
   declarative `latexwb_*` tools, guided by five skills.
2. **Your own Pi** can install the workbench as a Pi package.
3. **A Cognia-hosted Pi agent** can opt in to load the workbench extension and
   become a controlled LaTeX worker.

In all three, approvals come from you, never from a model.

## Prerequisites

| Requirement                                                              | Needed for                                                |
| ------------------------------------------------------------------------ | --------------------------------------------------------- |
| Node.js ≥ 24 on `PATH` (`node:sqlite`, native TypeScript type stripping) | every tool; the plugin declares it in `requires.binaries` |
| npm ≥ 10                                                                 | the one-time dependency step (`prepare`)                  |
| `tectonic` on `PATH` (verified 0.17.0, e.g. `brew install tectonic`)     | builds — the only LaTeX engine                            |
| ~3 GB disk                                                               | the provisioned offline Tectonic bundle                   |
| macOS arm64 + Xcode Command Line Tools (`swiftc`)                        | page rendering, text extraction and page review           |
| Pi ≥ 0.85.1                                                              | installing into Pi and hosted Pi agents only              |

Desktop only: the plugin is blocked in the browser, mobile and headless
shells because its tools spawn host processes.

## Build and install the plugin

From the repository root (the build reuses the root install's `esbuild` and
`jszip`; `dist/` is gitignored build output):

```bash
pnpm exec node plugins/pi-latex-workbench/build.mjs
```

That writes `plugins/pi-latex-workbench/dist/index.js` and
`plugins/pi-latex-workbench/dist/cognia-pi-latex-workbench-0.1.0.zip`. The
manifest's `main` is `dist/index.js`, which is gitignored build output, so the
plugin cannot load until that build has run — which is also why installing
from a GitHub URL does not work (the repository carries no `dist/index.js`).
Then install it into a running Cognia desktop instance in one of two ways:

- **Cognia CLI** (installs the ZIP; the CLI resolves a relative path):

  ```bash
  cognia plugin install plugins/pi-latex-workbench/dist/cognia-pi-latex-workbench-0.1.0.zip --json
  ```

- **Load unpacked**: in **Plugins**, use the toolbar's **Load unpacked…** and
  pick the `plugins/pi-latex-workbench` directory (after the build above).
  Cognia copies the directory into its plugin store.

The Plugins panel's own archive action installs WASM plugins only; it refuses
this frontend plugin. The ZIP carries exactly the `bundle_include` allowlist:
these docs, `pi/`, `skills/` and the `vendor/` snapshot — never
`node_modules`, a provisioned toolchain or workbench state.

## One-time host setup

These run on your machine, outside any agent:

1. **Install dependencies.** Open **Plugins → Pi LaTeX Workbench → Pi
   packages** and run **Prepare**. After you approve the exact command, Cognia
   runs, without a shell, inside the plugin's `vendor/` directory:

   ```bash
   npm install --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund
   ```

   It installs only `ajv`/`ajv-formats` and links the workbench's own
   packages. `--omit=peer` keeps `@earendil-works/pi-*` and `typebox` out of
   the package, as Pi requires (Pi maps them to its own copies). The
   `latexwb_*` tools need this step too.

2. **Provision the toolchain and renderer** (host commands — the ~2.9 GB
   download exceeds the 600 s limit of a tool call, so no tool offers it).
   From the plugin's install directory:

   ```bash
   node vendor/packages/cli/src/bin.ts provision-toolchain   # pinned offline Tectonic bundle
   node vendor/packages/cli/src/bin.ts provision-renderer    # Swift/PDFKit helper, macOS arm64
   node vendor/packages/cli/src/bin.ts doctor                # BUILD_READY = ready
   ```

   They write `vendor/runtime/toolchain/` and `vendor/runtime/render/`, which
   a plugin update replaces — re-run them after updating.

## Use it in Cognia

**Settings** (Plugins → Pi LaTeX Workbench → Configure):

| Setting      | Default    | Meaning                                                                                                                             |
| ------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `project`    | empty      | default workbench project id; also binds hosted Pi agents (empty = unbound, inert)                                                  |
| `protection` | `strict`   | hosted Pi agents only: `authoring` lets new protected content apply without a per-patch grant. Cognia's own tools always run strict |
| `stateDir`   | `.latexwb` | workbench state (SQLite db, blobs, job dirs), relative to the workspace                                                             |

**Skills.** `latex-workbench` explains the governed loop to the agent
(import → inspect → propose → apply → write back → build → check → render)
and maps the upstream recipes in `vendor/resources/skills/*/references/guide.md`
onto these tools. Four explicit skills start a task: **LaTeX: write**,
**LaTeX: revise**, **LaTeX: tune layout**, **LaTeX: check** (pick them in the
composer's skill picker). The upstream Pi skills themselves are not registered
— they name Pi's `latex_*` tools, which a Cognia agent does not have.

**Tools.** Each call runs
`node <plugin dir>/vendor/packages/cli/src/bin.ts <command> …` with the
workspace as working directory. The `cli:execute` prompt shows that exact
command with the absolute script path. Path parameters are confined to the
workspace, and IDs must match the workbench id grammar.

| Tool                                                     | Command                                                         | Access                       |
| -------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------- |
| `latexwb_doctor`                                         | `doctor`                                                        | read                         |
| `latexwb_import`                                         | `import <dir> [--project]`                                      | write                        |
| `latexwb_inspect`                                        | `inspect`                                                       | read                         |
| `latexwb_jobs`                                           | `jobs`                                                          | read                         |
| `latexwb_build`                                          | `build [--snapshot] [--target] [--preset] [--clean]`            | write                        |
| `latexwb_check_run` / `latexwb_check_report`             | `check-run` / `check-report`                                    | write / read                 |
| `latexwb_render_pages` / `latexwb_render_text`           | `render-pages` / `render-text`                                  | write                        |
| `latexwb_artifact_save`                                  | `artifact-save <id> <dest>`                                     | write                        |
| `latexwb_materialize`                                    | `materialize --dir [--snapshot]`                                | write                        |
| `latexwb_patch_propose` / `_show` / `_apply` / `_revert` | `patch-propose` / `patch-show` / `patch-apply` / `patch-revert` | write / read / write / write |
| `latexwb_release_prepare` / `_freeze` / `_package`       | `release-prepare` / `release-freeze` / `release-package`        | write                        |
| `latexwb_release_status` / `_list`                       | `release-status` / `release-list`                               | read                         |
| `latexwb_workflow_start` / `_resume` / `_cancel`         | `workflow-start` / `workflow-resume` / `workflow-cancel`        | write                        |
| `latexwb_workflow_status` / `_list`                      | `workflow-status` / `workflow-list`                             | read                         |
| `latexwb_assets_inspect`                                 | `assets-inspect <assetId>`                                      | write                        |
| `latexwb_review_coverage`                                | `review-coverage`                                               | read                         |

Every tool except `doctor` passes `--state <stateDir>` and `--project` (optional
only for `import`), and every tool runs with `LATEXWB_PRINCIPAL=cognia-agent`, so audit rows name the agent.

## Trust boundary

The workbench's rule is that **the model never approves its own work**. The
CLI treats whoever invokes it as the host operator, so the plugin exposes no
command that grants, records or bypasses an approval:

| Not exposed                                  | Why                                                         |
| -------------------------------------------- | ----------------------------------------------------------- |
| `approve` (patch and action grants)          | grants are the operator's decision                          |
| `approvals-list`, `approvals-revoke`         | the approval ledger stays a host surface                    |
| `review-page`                                | page verdicts are human review (`human.review`)             |
| `materialize --takeover`                     | adopting a never-synced folder overrides the conflict check |
| `materialize recover`                        | journal recovery is an operator repair                      |
| `provision-toolchain`, `provision-renderer`  | host provisioning; the download exceeds the 600 s tool cap  |
| `jobs --watch`                               | unbounded polling                                           |
| `artifact-cat`, `events`, `cancel`, `export` | raw bytes, outbox and aliases covered by other tools        |

`latexwb_patch_apply` is exposed because the CLI applies with **strict**
semantics: a patch with protected changes (math, labels, citation keys,
reported numbers, quotations, unfamiliar commands, template files) applies
only if you already granted a host approval bound to its digest; otherwise it
returns `POLICY_DENIED` and the agent reports the patch id and the grant
needed. `latexwb_release_package` finalizes `blocked` until every page has
your verdict and the digest-bound `release.package` grant exists.
`manifest.test.ts` pins this list.

You grant on your machine, from the workspace:

```bash
node <plugin dir>/vendor/packages/cli/src/bin.ts approve --patch <patchId> --project <id> --state .latexwb
node <plugin dir>/vendor/packages/cli/src/bin.ts review-page --artifact <pageImageId> --verdict approved --project <id> --state .latexwb
node <plugin dir>/vendor/packages/cli/src/bin.ts approve --action release.package --digest <approvalDigest> --snapshot <snapshotId> --project <id> --state .latexwb
```

or with `/latex approve` inside a workbench Pi session.

## Install into your Pi

**Plugins → Pi LaTeX Workbench → Pi packages → Install** (user or project
scope) runs `pi install <plugin dir>/vendor` once **Prepare** has run (or
records the path in Pi's `settings.json` when Pi is not reachable). Pi then
loads `vendor/package.json` → `packages/adapter-pi/extensions/workbench.ts`.
Unbound it is inert; bind a session per the upstream docs:

```bash
LATEXWB_STATE=$PWD/.latexwb LATEXWB_PROJECT=demo pi
```

See `vendor/docs/PI-SESSION.md` for the eight `latex_*` tools, `/latex`
commands, `/latex-write|revise|tune|check` and the approval dialog.

## Hosted Pi agents (opt-in)

A Cognia `pi-rpc` agent can opt in to `cognia-pi-latex-workbench/latex-workbench`.
Cognia then loads `pi/cognia-workbench.ts` with `-e` and forwards the plugin
settings as `COGNIA_PIPKG_*` variables: `LATEXWB_PROJECT` ← `project`,
`LATEXWB_PROTECTION` ← `protection`, `LATEXWB_WORKSPACE` = `local`, and
`STATE_DIR` + `WORKSPACE_DIR`, which the entry joins into `LATEXWB_STATE`
(refusing a state dir outside the workspace). Variables you already set win.
The entry then loads the vendored extension unchanged. The package
**controls the session**: the agent can reach only the eight `latex_*` tools,
and approvals come from you through the session dialog or `/latex approve`.

## Layout

```text
plugin.json            manifest: cliTools, skills, configuration, piPackages, bundle allowlist
src/index.ts           activation lifecycle (declarative; no imperative registration)
pi/cognia-workbench.ts Pi extension entry for hosted sessions
pi/env-binding.ts      COGNIA_PIPKG_* → LATEXWB_* binding (pure)
skills/                the five Cognia skills
scripts/sync-vendor.mjs  deterministic vendor refresh + check
vendor/                untouched upstream snapshot (VENDOR.md, vendor-lock.json)
manifest.test.ts       manifest contract, trust boundary, upstream parity
build.mjs              esbuild + install ZIP from bundle_include
```

## Maintenance

```bash
pnpm test -- plugins/pi-latex-workbench          # all plugin tests
pnpm plugin:pi-latex-workbench:check             # vendor/ == vendor-lock.json
node plugins/pi-latex-workbench/scripts/sync-vendor.mjs --upstream <checkout> --ref <ref>
```

`vendor/` is excluded from Cognia's TypeScript, Jest, ESLint, Prettier and
author-import gates: it is upstream's own strict-ESM project. Refresh it only
with the script, then re-derive the `cliTools` flags from
`vendor/packages/cli/src/bin.ts`; `manifest.test.ts` fails when the flags, the
workflow ids or the hosted tool list drift from the snapshot.

## License

The upstream repository has **no LICENSE file** at the vendored commit, so this
plugin claims no license (`"license": "UNLICENSED"`). Distribution terms must
be confirmed with the upstream owner (Arxtect) before the plugin — or any
artifact containing `vendor/` — is published outside this repository. See
[VENDOR.md](VENDOR.md).
