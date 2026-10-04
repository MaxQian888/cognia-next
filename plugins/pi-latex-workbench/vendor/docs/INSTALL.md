# INSTALL — prerequisites, provisioning, verification

Everything below runs on the recorded dev host (macOS arm64, Node v26.5.0,
Tectonic 0.17.0, Pi 0.87.0 — see [ENVIRONMENT.md](ENVIRONMENT.md) for the
probe outputs). The core works on any OS with Node ≥ 24; the page-render
helper is currently darwin/arm64-only.

## Prerequisites

| Requirement | Needed for | Check |
|---|---|---|
| Node.js ≥ 24 | everything: `node:sqlite`, native TypeScript type stripping (no build step) | `node -e "require('node:sqlite')"` |
| npm ≥ 10 | workspaces install | `npm --version` |
| `tectonic` on `PATH` (verified: 0.17.0) | the only LaTeX engine; `provision-toolchain` downloads its **bundle**, not the binary — install it first, e.g. `brew install tectonic` | `tectonic --version` |
| `swiftc` (Xcode Command Line Tools), macOS arm64 | compiling the Swift/PDFKit render helper (page images, text extraction, page review) | `swiftc --version` |
| Pi ≥ 0.85 (verified: 0.85.1, 0.87.0) | the controlled agent session; `doctor` also reports it as required | `pi --version` |
| ~3 GB disk | the provisioned tectonic bundle | `provision-toolchain` output |
| `python3` (dev only) | regenerating contract types / the command vocabulary | `python3 --version` |

Not required:

- **latexmk** — never used on the local path; it only exists inside the
  optional docker image.
- **Docker** — the docker runner is implemented but `environment-blocked`
  without a daemon and an image listed in host-policy `approvedImages`
  (empty by default). The local Tectonic preset is the production path.
- **pdflatex/lualatex/biber** — refused with `ENGINE_MISMATCH`, never
  emulated. Tectonic is XeTeX-family; bibliographies use BibTeX or a shipped
  `.bbl`.

## Install

```bash
git clone <repo> && cd pi-latex-workbench
npm install            # workspaces install; there is no compile step
```

Packages publish and consume `.ts` source directly
(`exports: {".": "./src/index.ts"}`), so `npm install` is the whole build.

## Put `latexwb` on PATH (optional)

```bash
# Option A: npm link the cli workspace bin
cd packages/cli && npm link          # exposes `latexwb` globally
latexwb doctor

# Option B: run the entrypoint directly (what the docs show)
node packages/cli/src/bin.ts doctor
```

`latexwb` is exactly `node packages/cli/src/bin.ts` — same argv either way.

## Provision the toolchain and renderer

```bash
node packages/cli/src/bin.ts provision-toolchain
```

Downloads the pinned bundle `default_bundle_v33.tar` (~2.9 GB) into
`runtime/toolchain/bundle` (gitignored), verifies a hash sample, generates the
per-file `SHA256SUM` index, runs an offline smoke compile and rewrites
`runtime/toolchain-lock.json` with the resolved digest and the tectonic binary
sha256 (`6ffe0558…` on the dev host). The lock file is tracked in git, so a
re-provision on another host shows up as a local diff. Builds then run fully
offline: `tectonic -X compile -b <bundle> --only-cached --untrusted`.
Exit 3 if the smoke compile fails.

```bash
node packages/cli/src/bin.ts provision-renderer   # macOS arm64 only
```

Compiles `packages/runtime/render-helper/` with the host `swiftc` and pins the
binary + manifest sha256 into `runtime/render/manifest.json` (gitignored). The
helper's sha256 is re-verified before every call. Without it builds, patches
and source checks work normally; `latex_render`, the render-dependent release
checks (text extraction, page dimensions, font coverage, visual coverage) and
page review are unavailable and report `unsupported`/`needs-review`.

## Verify

```bash
node packages/cli/src/bin.ts doctor   # DoctorReport JSON
npm run typecheck                     # tsc --noEmit
npm test                              # full suite (333 tests: 332 pass, 1 docker skip on this host)
npm run test:contracts                # schema/validator tests (37)
```

**Reading the doctor report.** `capabilities[]` holds one entry per probe:
`node`, `node:sqlite`, `pi`, `tectonic`, `latexmk`, `docker`, `python3`,
`render-helper.swift-pdfkit`, `toolchain-resolved`,
`runner.local-tectonic`, `runner.docker-texlive-latexmk`.
`diagnostics[]` uses a fixed severity contract:

| Severity | Codes | Meaning |
|---|---|---|
| `info` | `BUILD_READY`, `LATEXMK_MISSING`, `OCI_UNAVAILABLE` | facts: which runner builds, which optional tools are absent |
| `warning` | `RUNTIME_UNAVAILABLE` (docker runner down), `RENDERER_UNAVAILABLE` (helper not provisioned), `PYTHON_MISSING` | real capability gaps on a working host; never blocking |
| `error` | `NO_BUILD_RUNNER`, `TOOLCHAIN_UNRESOLVED`, `NODE_UNSUPPORTED`, `SQLITE_UNAVAILABLE`, `PI_UNAVAILABLE`, `RENDERER_UNAVAILABLE` (provisioned helper fails verification) | listed in `blockingCodes`; `doctor` exits 2 |

A healthy host prints `BUILD_READY` for `local-tectonic` and exits 0. Note
that `doctor` treats Pi as required: without `pi` on `PATH` it reports
`PI_UNAVAILABLE` and exits 2, although every CLI command other than
`doctor` still works.

## Load the workbench in Pi

After provisioning, register the repository root as a Pi package once:

```bash
pi install /absolute/path/to/pi-latex-workbench
```

The root `package.json` (`pi.extensions`) loads only
`packages/adapter-pi/extensions/workbench.ts`. Unbound, it is inert: ordinary
Pi sessions keep their tools and prompts. Bind a dedicated LaTeX worker per
session with `LATEXWB_PROJECT` and an absolute `LATEXWB_STATE` — never set
them globally. See [PI-SESSION.md](PI-SESSION.md#install-and-invoke-as-an-agent)
for invocation, model selection and follow-up editing.

## First project

```bash
node packages/cli/src/bin.ts import fixtures/domains/mathematics/healthy --project demo
node packages/cli/src/bin.ts build --project demo --target default
node packages/cli/src/bin.ts jobs --project demo            # job rows carry artifact ids
node packages/cli/src/bin.ts artifact-save <pdfArtifactId> out.pdf --project demo
```

State lands in `./.latexwb/` by default (`--state <dir>` to move it). The full
command reference, state layout, backup and recovery model are in
[RUNBOOK.md](RUNBOOK.md).
