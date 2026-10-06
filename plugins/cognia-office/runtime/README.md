# Office file runtime discovery

This directory owns the optional `@deepseek-ai/libreoffice-kit@0.1.5` dependency.
The Office plugin's lightweight authoring and preview do not import it. The host
copies the bundle into its managed runtime cache and installs dependencies only
after an explicit runtime preparation request. Neither plugin activation nor
importing `probe.mjs` installs or loads the package.

The host package stages only `package.json`, `pnpm-lock.yaml`,
`pnpm-workspace.yaml` and `probe.mjs`. Do not ship `node_modules`, the package
store or `probe.test.mjs`. The
test uses only Node built-ins and synthetic module fixtures; it is not an engine
rendering test.

## Installation policy

Use bundled Node 26 when available; the package requires Node >=22.19.0 and the
installer is pinned to pnpm 11.18.0. The host must preserve the package and policy
files, use the runtime directory as its working directory, and run the normal
frozen-lockfile install. Do not pass `--ignore-workspace`, bypass the release-age
policy, approve lifecycle scripts or substitute a registry.

The local policy retains a 24-hour minimum release age, adds no exemptions and
explicitly denies the `koffi@3.1.1` install script. Koffi's published platform
prebuilds remain ordinary locked dependencies; no local native compilation is
authorized. Any unexpected build request must fail rather than change policy.
The lockfile is generated using `pnpm install --lockfile-only` in this directory.
No Office dependency belongs in the root or sidecar dependency manifest.

## Probe protocol

In Cognia, open a workbook preview and use **Install engine on demand** followed
by **Load and check module** when preparation finishes. **Check status** reads metadata;
**Cancel** stops an installation and **Remove engine** removes the private
runtime cache. The same explicit actions are available through
`office_engine_runtime` (`status`, `prepare`, `probe`, `cancel`, `remove`).
Preparation requests the plugin's optional shell and network permissions.
The host needs an existing matching pnpm installation; it never bootstraps a
package manager or changes machine policy. Browser-only sessions without a
connected supported host report that this capability is unavailable.

Launch `node probe.mjs` from the installed runtime directory and send one JSON
request on stdin, then close stdin:

```json
{ "schemaVersion": 1, "operation": "probe" }
```

The probe validates this exact request before dynamically importing the local
package. It calls only `discoverRuntime()` and reads installed manifests/assets.
It never creates a converter, invokes the engine/CLI, opens a document or tests
rendering. Arbitrary operations, document paths and caller-supplied installation
paths are rejected. Input is limited to 4 KiB.

A successful stdout response is `{ "ok": true, "result": { ... } }` containing
`apiVersion`, `engineVersion`, `backend`, `platform`, `arch`, `nodeVersion`,
`packageRoot`, `engineRoot`, `nodeApiPath`, `cliPath`, verified `enginePaths`, and
`documentsSupported: false`. Native executable/program paths must remain inside
the pinned engine package. WASM paths are verified files except its explicitly
virtual program directory. Package roots must stay in this runtime's local
`node_modules`, including pnpm's nested store. Parent/global packages cannot
satisfy discovery. The host must treat the returned paths as discovery data,
not additional filesystem permission.

Failures have `{ "ok": false, "error": { "code", "message" } }` and a nonzero
exit status. Codes are `invalid-arguments`, `unsupported-runtime` and
`unavailable`. Availability confirms the installation's structure and API
version, not a successful conversion, executable launch, font setup or OS
sandbox. Conversion remains unavailable until the separate confined document
execution path is implemented and verified.

## Version and licensing evidence

Official npm manifests and the downloaded published tarballs identify the API
and macOS/Windows/Linux-WASM engines as **0.1.5**. All are integrity-pinned by the
lockfile. The shipped upstream README contains older 0.1.3 examples; these are
not used as the installed version contract. macOS ARM64's 0.1.5 tarball is
67,261,855 bytes compressed and 153,160,461 bytes unpacked; actual installation
also includes the JavaScript dependency graph and host-specific prebuilds.

The dependency declares MPL-2.0 and ships NOTICE and engine-specific `sources/`
and `licenses/` records. Keep those files with any installed/distributed runtime;
do not strip them to reduce package size. Fonts are not supplied by this bundle.

Official metadata:

- https://registry.npmjs.org/@deepseek-ai%2Flibreoffice-kit/0.1.5
- https://registry.npmjs.org/@deepseek-ai%2Flibreoffice-kit-darwin-arm64/0.1.5

Run discovery-contract tests with `node --test probe.test.mjs`. Real package
installation and discovery, when performed, must be reported separately from
these synthetic fixture tests. No test here claims document-rendering coverage.

## Verified installation

On 2026-10-06, a fresh temporary staging directory containing only the four
runtime files was installed using the normal pnpm 11.18.0 frozen-lockfile command
and this unchanged policy. Installation added 20 packages and required no build
approval. The real probe returned API 0.1.5, engine 0.1.5, native backend,
darwin-arm64 and Node 26.5.0, with both native asset paths inside the staged pnpm
installation. Source package manifests, lockfiles and policies were unchanged.
This validates installation and discovery only; no converter, CLI, native engine
process or document was invoked. Windows and Linux installation/discovery remain
unverified by this check.
