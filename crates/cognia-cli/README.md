# cognia — plugin author CLI

Companion CLI for `type: "wasm"` cognia plugins. Bundled with the
cognia desktop app as a separate Rust crate so plugin authors can install
it independently of the GUI (`cargo install --path crates/cognia-cli`).

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

| Command                                        | Purpose                                                                                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `cognia plugin new <name>`                     | Stamp the bundled template into `./<name>`.                                                                                         |
| `cognia plugin build`                          | Run `cargo component build --release`, inject the `cognia:api-version` custom section, and package the artifact as a `.zip` bundle. |
| `cognia plugin sign <bundle.zip> --key <priv>` | Ed25519-sign the bundle bytes. Writes `<bundle>.zip.sig`.                                                                           |
| `cognia plugin verify <bundle.zip>`            | Verify a `<bundle>.sig` against the public key in the bundle's `plugin.json`.                                                       |
| `cognia plugin keygen`                         | Generate an Ed25519 keypair into `./.cognia/`.                                                                                      |
| `cognia plugin dev`                            | Watch the crate, rebuild + bundle on save. Optional `--reload-url` to ping a running cognia.                                        |
| `cognia plugin embed-version <wasm> <ver>`     | Manually inject the api-version custom section (normally automatic).                                                                |

## Typical flow

```bash
# One-time setup
rustup target add wasm32-wasip2
cargo install --locked cargo-component

# Per-plugin setup
cognia plugin new hello-cognia
cd hello-cognia
cognia plugin keygen
# → embed the printed public key in plugin.json author.publicKey

# Iterate
cognia plugin dev
# (edit src/lib.rs, watch rebuilds happen automatically)

# Release
cognia plugin build
cognia plugin sign target/cognia/hello-cognia-0.1.0.zip --key .cognia/plugin.private.b64
cognia plugin verify target/cognia/hello-cognia-0.1.0.zip
```

## Toolchain requirements

- Rust ≥ 1.82 (for the `wasm32-wasip2` target)
- `cargo-component` ≥ 0.21 (`cargo install --locked cargo-component`)
- `wasm32-wasip2` rustup target installed

The CLI verifies these are available before running `build` / `dev` and
emits actionable error messages if not.

## Versioning

The cognia CLI ships its own version (independent of the host app).
It writes the **WIT contract version** (currently `0.1.0`) into every
built bundle so the host can route to the matching linker. If you bump
your plugin's `wasm.apiVersion` past what the host supports, the host
will refuse to load with `"no linker registered for v0.N.x"`.
