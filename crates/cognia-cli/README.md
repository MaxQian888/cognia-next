# cognia — author and Headless operator CLI

Companion CLI for cognia plugins (WASM Component Model, frontend TypeScript, Python, hybrid, and VS Code-extension bundles). Shipped with the cognia desktop app as a separate Rust crate so plugin authors can install it independently of the GUI (`cargo install --path crates/cognia-cli`).

## Install

From a clone of the cognia-next repo:

```bash
cargo install --locked --path crates/cognia-cli
cognia --help
```

Or from a release tarball (once published):

```bash
cargo install --locked cognia-cli
```

## Subcommands

| Command                                                                                                                                                                                     | Purpose                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cognia plugin new [name] [--dir DIR] [--kind wasm\|ts\|python\|hybrid\|vscode-extension] [--author NAME] [--author-email EMAIL] [--description TEXT] [--with-keygen true\|false] [--json]` | Stamp a starter project. Default `ts`; WASM, Python, hybrid, and VS Code-extension scaffolds are also available.                                    |
| `cognia plugin contract [--capability ID] [--contribution FIELD] [--plugin-type TYPE] [--point ID] [--point-kind KIND] [--permission PERMISSION] [--json]`                                  | Read the generated canonical authoring contract. Selectors are repeatable; the command never writes to the workspace.                               |
| `cognia plugin lint [--path .] [--json]`                                                                                                                                                    | Validate `plugin.json` against the host's manifest schema. Run implicitly by `build`.                                                               |
| `cognia plugin build [--path .] [--out P] [--skip-build] [--json]`                                                                                                                          | Dispatch on `manifest.type`: WASM → cargo-component → zip; frontend → esbuild → zip; python/hybrid/vscode-extension → package existing entry files. |
| `cognia plugin info <bundle.zip\|directory> [--detailed] [--json]`                                                                                                                          | Inspect a built bundle or unpacked plugin directory: manifest, files, signature status, embedded `cognia:api-version`.                              |
| `cognia plugin sign <bundle.zip> --key <priv> [--out sig] [--json]`                                                                                                                         | Ed25519-sign the bundle bytes. Writes `<bundle>.sig` unless `--out` is provided.                                                                    |
| `cognia plugin verify <bundle.zip> [--public-key b64] [--signature sig] [--json]`                                                                                                           | Verify a `.sig` against the public key in the bundle's `plugin.json` or an explicit key.                                                            |
| `cognia plugin keygen [--out-dir .cognia] [--json]`                                                                                                                                         | Generate an Ed25519 keypair into `./.cognia/` or a custom key directory.                                                                            |
| `cognia plugin install <bundle.zip\|directory> [--json]`                                                                                                                                    | Install a bundle or unpacked plugin directory into a running cognia desktop instance.                                                               |
| `cognia plugin uninstall <id> [--purge-data] [--json]`                                                                                                                                      | Remove a plugin from a running cognia desktop instance.                                                                                             |
| `cognia plugin list [--json]`                                                                                                                                                               | List plugins currently known to the running desktop bridge.                                                                                         |
| `cognia plugin reload [--plugin-id ID] [--json]`                                                                                                                                            | Ask the running desktop bridge to hot-reload an installed plugin.                                                                                   |
| `cognia plugin reload --path <bundle.zip\|directory> [--json]`                                                                                                                              | Re-install a built bundle or unpacked plugin directory through the bridge and emit the hot-reload event. `--bundle` remains a compatibility alias.  |
| `cognia plugin status [--json]`                                                                                                                                                             | Probe the running desktop bridge without exposing the per-launch dev token.                                                                         |
| `cognia plugin dev [--path .] [--reload-url URL] [--once] [--json]`                                                                                                                         | Watch the crate, rebuild + hot-reload on changes; `--once` builds/reloads once and exits, with optional JSON for CI/editor smoke checks.            |
| `cognia plugin embed-version <wasm> <ver> [--out wasm] [--json]`                                                                                                                            | Manually inject the api-version custom section (normally automatic during `build`).                                                                 |
| `cognia acp`                                                                                                                                                                                | Bridge newline-delimited ACP JSON-RPC on stdin/stdout to the running cognia companion WebSocket endpoint.                                           |
| `cognia host categories [--format json\|table]`                                                                                                                                             | Summarize the stable Headless command domains, risk/operation counts, and matching embedded skills.                                                 |
| `cognia host resources [--category CATEGORY] [--format json\|table]`                                                                                                                        | Browse stable resource groups within a domain before selecting an exact RPC.                                                                        |
| `cognia host commands [filters]`                                                                                                                                                            | Browse the embedded loopback Headless RPC catalog without connecting to a server.                                                                   |
| `cognia host schema <command>`                                                                                                                                                              | Inspect the concrete input schema and opaque-output marker for one Headless RPC.                                                                    |
| `cognia host call <command> [--data JSON\|-\|@FILE] [--dry-run]`                                                                                                                            | Validate and invoke one named Headless RPC with durable idempotency and risk confirmation.                                                          |
| `cognia host doctor [--offline]`                                                                                                                                                            | Diagnose Headless URL, TLS, data-directory, credential, readiness, and safe-RPC access.                                                             |
| `cognia host events [--since SEQ] [--event TYPE]`                                                                                                                                           | Stream replayable Headless events as NDJSON.                                                                                                        |
| `cognia host skills list\|read`                                                                                                                                                             | Read the agent-safe command-selection and confirmation guidance embedded in the binary.                                                             |
| `cognia host skills install --scope user\|project`                                                                                                                                          | Install every embedded skill into the standard `.agents/skills` discovery location with conflict-safe managed upgrades.                             |
| `cognia release-key [--json]`                                                                                                                                                               | Inspect the embedded public key and policy used to verify downloaded `cognia` CLI release artifacts.                                                |
| `cognia release-verify <artifact> --checksums <checksums.txt> [--artifact-name NAME] [--signature PATH] [--json]`                                                                           | Offline-verify a downloaded CLI release artifact against `checksums.txt` and the embedded release key policy.                                       |

## Headless host usage

`cognia host` is a same-host operator and agent interface for `cognia-server`; it is not a
remote-device API. Service credentials are accepted by the server only from loopback. In Compose
or Kubernetes, run the CLI inside the server container or Pod:

```bash
docker compose exec cognia-server cognia host doctor
kubectl exec <pod> -- cognia host commands --query session
cognia host categories
cognia host resources --category development
cognia host commands --resource git --operation read
cognia host skills install --scope project
cognia host skills read cognia-host-development
cognia host skills read cognia-host-safe-git
cognia host schema session_list
cognia host call session_list --data '{"limit":20,"offset":0}'
```

The CLI reads `COGNIA_SERVICE_TOKEN` when supplied; otherwise it invokes a colocated
`cognia-server issue-service-token` and keeps the 24-hour token in memory. High- and critical-risk
commands require a terminal confirmation or a user-approved global `--yes`. Agents must never add
`--yes` without that confirmation. `cognia host categories` maps every RPC into one of nine stable
domains; `cognia host resources` exposes generated resource groups such as `git`, `files`,
`task-workspaces`, and `provider-catalog`. Use `commands --resource <id>` to narrow discovery without
guessing an RPC name. Run `cognia host skills list --kind core|domain|workflow` for the full skill
inventory and `cognia host skills read cognia-host` for the shared safety/output contract. The six
workflow skills cover read-only observation, safe Git, agent incidents, backup recovery, extension
rollout, and connector delivery.

### Installing Agent Skills

`cognia host skills install` is offline and requires an explicit scope. `--scope user` installs all
16 skills under `$HOME/.agents/skills`; `--scope project` uses `.agents/skills` at the nearest Git
worktree root, or the current directory when it is not inside Git. Codex, Gemini CLI, OpenCode, and
other Agent Skills clients can discover that shared layout. Refresh the client's skill inventory or
restart its session after installation.

The installer records `.cognia-host-manifest.json` with the CLI bundle version and SHA-256 hash of
every managed file. Re-running it leaves identical files alone, upgrades files that still match the
previous manifest, and removes retired unmodified files. It preflights the complete bundle before
writing: a modified file, an untracked file inside a managed Cognia skill, a corrupt manifest, or a
symlinked `.agents`, skills root, or managed destination returns `skill_install_conflict` without
writing anything. Fully written Cognia temporary files that match the current bundle are recovered
on the next successful retry, and the manifest is replaced last; other temporary content conflicts
instead of being deleted. Preserve intentional edits elsewhere, restore the reported paths from
`cognia host skills read`, or move all Cognia-managed skill directories and the manifest aside before
retrying. The installer never overwrites user edits and has no force mode.

## Querying the authoring contract

The contract command combines `packages/plugin-sdk/contract/catalog.json` with the point projection generated from `PLUGIN_POINT_CONTRACTS`. With no selectors it returns every plugin type, capability, manifest contribution, permission, runtime-entry rule, path-field contract, and UI/hook/activation/runtime point. JSON v2 uses full-catalog and selected-record counts; unknown selectors emit a structured `stage: "input"` failure and exit non-zero.

```bash
# Plan a new frontend plugin with a tool and context panel.
cognia plugin contract \
  --plugin-type frontend \
  --capability tools \
  --contribution contextPanels \
  --point chat.input.actions \
  --point-kind ui-slot \
  --permission extension:ui \
  --json

# Inspect the records needed to extend an existing hybrid plugin.
cognia plugin contract \
  --plugin-type hybrid \
  --capability python \
  --contribution tools \
  --json

# Compare runtime entry rules before selecting a runtime.
cognia plugin contract --plugin-type frontend --plugin-type hybrid --json
```

Read `support`, `pythonExecution`, `execution`, point `status`/`stability`, UI `formFactor`, replacement ids, permissions, entry paths, minimum host versions, and path rules before changing files. Treat experimental records as requiring explicit author confirmation and use the replacement for deprecated points. If a contribution requires JavaScript execution, a Python-only or WASM runtime is incompatible: select a compatible runtime such as `frontend` or `hybrid` before writing. The command reports the contract only; it never scaffolds, edits, signs, installs, or publishes a plugin.

## Typical flow — WASM plugin

```bash
# One-time setup
rustup target add wasm32-wasip2
cargo install --locked cargo-component

# Per-plugin setup
cognia plugin new hello-wasm
cd hello-wasm
cognia plugin keygen
# → embed the printed public key in plugin.json author.publicKey

# Iterate
cognia plugin dev
# (edit src/lib.rs, watch rebuilds happen automatically; if cognia is
#  running, every save also hot-reloads it in place)

# Release
cognia plugin build
cognia plugin sign target/cognia/hello-wasm-0.1.0.zip --key .cognia/plugin.private.b64
cognia plugin verify target/cognia/hello-wasm-0.1.0.zip
```

## Typical flow — frontend TypeScript plugin

```bash
cognia plugin new hello-ts --kind ts
cd hello-ts
pnpm install                          # or npm install
pnpm test                             # jest tests should be green on a fresh scaffold

# Iterate
cognia plugin dev

# Release
cognia plugin lint                    # explicit validate before publishing
cognia plugin build                   # esbuild → dist/index.js → zip
cognia plugin info target/cognia/hello-ts-0.1.0.zip
cognia plugin info .                    # inspect the unpacked plugin directory
cognia plugin status --json           # verify the running desktop bridge is reachable
cognia plugin list                    # inspect the running desktop bridge state
cognia plugin reload --plugin-id hello-ts
cognia plugin reload --path .         # re-install unpacked directory and emit hot-reload
cognia plugin install target/cognia/hello-ts-0.1.0.zip   # against a running cognia
cognia plugin install .               # load the unpacked plugin directory without packaging first
```

The frontend build uses `npx --no-install esbuild …` so authors stay in control of their `package.json` and lockfile — the CLI refuses to silently install a global esbuild. Make sure `pnpm install` (or equivalent) ran first.

## Typical flow — Python plugin

```bash
cognia plugin new hello-python --kind python
cd hello-python
python -m py_compile main.py
cognia plugin lint
cognia plugin build                   # package plugin.json + main.py
cognia plugin info target/cognia/hello-python-0.1.0.zip
cognia plugin dev --once --json       # one build + optional reload, no watcher
```

The Python scaffold uses the host-injected `cognia` module and registers one sample tool with `@tool`. Outside the desktop host, use the repo's `plugin-sdk/python` package for local type checking or tests.

## Typical flow — hybrid plugin

```bash
cognia plugin new hello-hybrid --kind hybrid
cd hello-hybrid
node --check frontend/index.js
python -m py_compile backend/main.py
cognia plugin lint
cognia plugin build                   # package plugin.json + JS/Python/styles entries
cognia plugin info target/cognia/hello-hybrid-0.1.0.zip
```

The hybrid scaffold activates a build-free frontend lifecycle module and a Python backend tool from the same manifest. `cognia plugin build` packages the declared `main`, `pythonMain`, optional `styles`, and any `bundle_include[]` files.

## Typical flow — VS Code-extension plugin

```bash
cognia plugin new hello-vscode --kind vscode
cd hello-vscode
node --check extension/out/extension.js
cognia plugin lint
cognia plugin build                   # package plugin.json + vscodeMain + styles + package.json
cognia plugin info target/cognia/hello-vscode-0.1.0.zip
```

The VS Code-extension scaffold ships a CommonJS `activate` / `deactivate` entry for the Cognia sidecar and keeps `package.json` in `bundle_include[]` so extension metadata is available at runtime.

## Build-free runtime packaging

For `type: "python"`, `type: "hybrid"`, and `type: "vscode-extension"`, `cognia plugin build` is a validation + packaging step. It copies `plugin.json`, the relevant manifest entry files (`pythonMain`, `main`, `vscodeMain`, optional `styles`), and any `bundle_include[]` files into the zip. Those files must already exist on disk; missing or path-escaping entries are hard errors.

Global output flags keep human and automation surfaces separate. `-v/--verbose` emits one human command diagnostic to stderr with the parsed command context. `-q/--quiet` suppresses that diagnostic and all non-error success output. Per-command `--json` also suppresses verbose stderr so stdout remains a single parseable payload.

`cognia plugin build --json`, `cognia plugin verify --json`, and `cognia release-verify --json` are safe for CI pipelines: success emits `{ "ok": true, "action": ... }`; expected validation, checksum, read, key, or signature failures emit `{ "ok": false, ... }` on stdout, exit non-zero, and do not duplicate human diagnostics on stderr. `build --json` failure payloads include `stage: "input" | "lint" | "toolchain" | "build" | "embed" | "pack"` so automation can distinguish missing plugin roots from manifest diagnostics and later build stages. `verify --json` failure payloads also include `stage: "bundle" | "public-key" | "signature" | "verify"` so automation can route local input failures separately from cryptographic mismatches.

## Talking to a running cognia

`status` / `list` / `install` / `uninstall` / `reload` / `dev --reload-url` use a small loopback HTTP bridge that the cognia desktop binds on startup. `install` accepts either a built `.zip` bundle or an unpacked directory containing `plugin.json`; both forms use the same collision preflight before replacing an existing plugin id. `reload --path` accepts the same file-or-directory input when you want to reinstall and emit a hot-reload event in one step; `--bundle` remains accepted for existing scripts. Discovery is automatic: cognia writes `<config_dir>/cognia/cli-endpoint.json` with its base URL and a per-launch dev token; the CLI reads it but never prints the token. If no cognia is running, the CLI returns a clear error rather than hanging.

For CI, `status --json`, `install --json`, `uninstall --json`, `reload --json`, and `dev --once --json` emit schema-versioned reports on stdout. `status --json` reports unavailable bridges as `{ "schemaVersion": 1, "ok": false, "action": "status", "running": false, "endpointFile": "...", "baseUrl": null, "error": ... }` and exits non-zero without duplicating human diagnostics on stderr. If the bridge rejects an install, uninstall, or reload request, those commands emit `{ "ok": false, "stage": "bridge", "error": ... }` on stdout, exit non-zero, and keep stderr empty. `install --json` also folds local manifest preflight warnings into the `warnings[]` array so stdout remains parseable JSON. `dev --once --json` builds exactly once, attempts reload only when an endpoint is discoverable, reports skipped reloads as `"reload": { "attempted": false, "skippedReason": "no-endpoint" }`, and reports bridge reload rejections as `{ "ok": false, "stage": "reload", "reload": { "attempted": true, "ok": false }, "error": ... }`; plain watch mode rejects `--json` so stdout is never a partial long-running JSON stream.

The bridge accepts only loopback connections (`127.0.0.1`) and gates every request on the dev token, which rotates each app launch. There is no LAN / WAN reach for these endpoints by design — the mobile-pairing companion API (port 7890) is a separate listener with its own JWT auth.

## ACP editor bridge

`cognia acp` is a top-level utility for editors and ACP clients, not a `cognia plugin` subcommand. Configure an editor with `{"command": "cognia", "args": ["acp"]}`. The command resolves a running companion endpoint from `COGNIA_ACP_URL` + `COGNIA_ACP_TICKET` or, when those are absent, from the desktop CLI bridge ticket broker. It keeps stdout reserved for newline-delimited ACP JSON-RPC frames; connection status goes to stderr and is suppressed by `--quiet`.

## Verifying CLI release artifacts

`cognia release-verify` is an offline companion to the desktop downloader's verification path:

```bash
cognia release-key
cognia release-verify cognia-x86_64-pc-windows-msvc.tar.gz --checksums checksums.txt
```

The command always enforces the SHA-256 entry from `checksums.txt`. Use `--artifact-name` when the local path cannot infer the release asset name or was renamed before matching `checksums.txt`; the value must be the release asset filename only, not a path or blank string. After the embedded release key is provisioned, the detached signature is required; by default the CLI reads `<artifact>.sig`, and `--signature <path>` can override that sidecar path. The signature file may contain either a raw 64-byte Ed25519 signature or a base64 text signature. While the release key is still the placeholder, the command reports `signatureStatus: "skipped-placeholder-key"` and `signatureVerified: false`; checksum verification remains mandatory. In `--json` mode, missing or invalid artifact names, unreadable artifact/checksum files, missing checksum rows, checksum mismatches, and signature failures emit the same schema-versioned payload on stdout, exit non-zero, and keep stderr empty.

## Toolchain requirements

- **All plugins:** Rust ≥ 1.82 (the MSRV for the CLI itself).
- **WASM plugins:** `wasm32-wasip2` rustup target + `cargo-component ≥ 0.21`.
- **Frontend plugins:** Node.js (any LTS) + a package manager (pnpm / npm / yarn) installed and on `$PATH`. The CLI invokes `npx --no-install esbuild`.
- **Python / hybrid / VS Code-extension plugins:** no CLI-managed compiler; check or build the declared entry files with your own toolchain before running `cognia plugin build`.

The CLI verifies these are available before running `build` / `dev` and emits actionable error messages if not.

## Versioning

The cognia CLI ships its own version (independent of the host app). For WASM plugins it writes the WIT contract version (currently `0.1.0`) into every built bundle so the host can route to the matching linker. If a plugin's `wasm.apiVersion` outruns what the host supports, the host refuses to load with `"no linker registered for v0.N.x"`.

Non-WASM plugin versions don't carry a `cognia:api-version` custom section — they version against the host plugin SDK/runtime through `plugin.json.engines.cognia` and their manifest entry-point contract.
