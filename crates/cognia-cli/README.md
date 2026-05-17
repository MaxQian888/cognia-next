# cognia — plugin author CLI

Companion CLI for cognia plugins (WASM Component Model + frontend TypeScript). Shipped with the cognia desktop app as a separate Rust crate so plugin authors can install it independently of the GUI (`cargo install --path crates/cognia-cli`).

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

| Command                                        | Purpose                                                                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `cognia plugin new <name> [--kind wasm\|ts]`   | Stamp a starter project. Default `wasm`. `--kind ts` produces a frontend TypeScript scaffold (esbuild + jest).    |
| `cognia plugin lint [--path .] [--json]`       | Validate `plugin.json` against the host's manifest schema. Run implicitly by `build`.                             |
| `cognia plugin build [--path .] [--out P]`     | Dispatch on `manifest.type`: WASM → cargo-component → zip; frontend → esbuild → zip.                              |
| `cognia plugin info <bundle.zip>`              | Inspect a built bundle: manifest, files, signature status, public-key fingerprint, embedded `cognia:api-version`. |
| `cognia plugin sign <bundle.zip> --key <priv>` | Ed25519-sign the bundle bytes. Writes `<bundle>.sig`.                                                             |
| `cognia plugin verify <bundle.zip>`            | Verify a `.sig` against the public key in the bundle's `plugin.json`.                                             |
| `cognia plugin keygen`                         | Generate an Ed25519 keypair into `./.cognia/`.                                                                    |
| `cognia plugin install <bundle.zip>`           | Install a bundle into a running cognia desktop instance (loopback HTTP bridge).                                   |
| `cognia plugin uninstall <id> [--purge-data]`  | Remove a plugin from a running cognia desktop instance.                                                           |
| `cognia plugin dev [--reload-url URL]`         | Watch the crate, rebuild + (optionally) hot-reload a running cognia.                                              |
| `cognia plugin embed-version <wasm> <ver>`     | Manually inject the api-version custom section (normally automatic during `build`).                               |

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
cognia plugin install target/cognia/hello-ts-0.1.0.zip   # against a running cognia
```

The frontend build uses `npx --no-install esbuild …` so authors stay in control of their `package.json` and lockfile — the CLI refuses to silently install a global esbuild. Make sure `pnpm install` (or equivalent) ran first.

## Talking to a running cognia

`install` / `uninstall` / `dev --reload-url` use a small loopback HTTP bridge that the cognia desktop binds on startup. Discovery is automatic: cognia writes `<config_dir>/cognia/cli-endpoint.json` with its base URL and a per-launch dev token; the CLI reads it. If no cognia is running, the CLI returns a clear error rather than hanging.

The bridge accepts only loopback connections (`127.0.0.1`) and gates every request on the dev token, which rotates each app launch. There is no LAN / WAN reach for these endpoints by design — the mobile-pairing companion API (port 7890) is a separate listener with its own JWT auth.

## Toolchain requirements

- **All plugins:** Rust ≥ 1.82 (the MSRV for the CLI itself).
- **WASM plugins:** `wasm32-wasip2` rustup target + `cargo-component ≥ 0.21`.
- **Frontend plugins:** Node.js (any LTS) + a package manager (pnpm / npm / yarn) installed and on `$PATH`. The CLI invokes `npx --no-install esbuild`.

The CLI verifies these are available before running `build` / `dev` and emits actionable error messages if not.

## Versioning

The cognia CLI ships its own version (independent of the host app). For WASM plugins it writes the WIT contract version (currently `0.1.0`) into every built bundle so the host can route to the matching linker. If a plugin's `wasm.apiVersion` outruns what the host supports, the host refuses to load with `"no linker registered for v0.N.x"`.

Frontend plugin versions don't carry a contract section — they version against the host's TypeScript plugin SDK, declared in `plugin.json.engines.cognia`.
