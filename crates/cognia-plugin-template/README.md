# Cognia Plugin Template

Minimal starter for a `type: "wasm"` cognia plugin compiled to a
WebAssembly component against the cognia v0.2 WIT contract.

The sample implements all four guest exports, declares one agent tool and one
workflow node so neither export is dead weight, and reads an optional
per-plugin secret on activation to show how a denied or unavailable capability
is meant to be handled.

## Prerequisites

```bash
rustup target add wasm32-wasip2
cargo install --locked cargo-component
```

## Build

```bash
cargo component build --release
```

The artifact lands at
`target/wasm32-wasip2/release/cognia_plugin_template.wasm`.

## Install in cognia

1. Open cognia → Settings → Plugins.
2. Click **Install local WASM plugin**.
3. Pick the `.wasm` file produced above (or the `.zip` bundle if you
   ran `cognia plugin build` from the cognia CLI).
4. Review the capability grant sheet and confirm.

## Layout

| File            | Purpose                                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `Cargo.toml`    | Crate manifest. `[package.metadata.component]` points cargo-component at `wit/world.wit` so the bindings are auto-generated. |
| `wit/world.wit` | A copy of the cognia v0.2 WIT contract. Do not edit.                                                                         |
| `src/lib.rs`    | Your plugin code. Implement `Guest` and re-export.                                                                           |
| `plugin.json`   | Cognia manifest — install metadata, capabilities, declared permissions.                                                      |

## Extending

- **Use a capability.** Add the matching string to `permissions[]` in
  `plugin.json` (`notification`, `filesystem:read`, `process:spawn`, …)
  then call the corresponding `bindings::cognia::plugin::*` function.
- **Register an agent tool.** Declare it under `tools[]` in
  `plugin.json` and dispatch in `tool_execute` by the `name` argument.
- **Register a workflow node.** Declare it under `workflows.nodes[]`
  and dispatch in `workflow_node_execute` by the `kind` argument.
- **Handle host errors by code.** Every `result<..., string>` carries
  `"<CODE>: <message>"` with a fixed set of codes (`CAPABILITY_DENIED`,
  `HOST_UNAVAILABLE`, `TIMEOUT`, `INVALID_REQUEST`, `PAYLOAD_TOO_LARGE`,
  `CANCELLED`, `PROVIDER_ERROR`, `WORKFLOW_REJECTED`). The codes are stable for
  the life of the 0.2 contract and the text is not, so branch on the code. See
  `split_host_error` in `src/lib.rs`.
- **Sign the bundle.** Generate a keypair with
  `cognia plugin keygen` (TODO M3.1), embed the public key in
  `author.publicKey`, then `cognia plugin sign target/.../bundle.zip`
  → produces `<bundle>.zip.sig`.

## Troubleshooting

| Symptom                                  | Fix                                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `cargo-component not found`              | `cargo install --locked cargo-component`                                                     |
| `unknown target wasm32-wasip2`           | `rustup target add wasm32-wasip2` (needs Rust ≥ 1.82)                                        |
| `error: failed to resolve cognia:plugin` | Make sure `wit/world.wit` matches the cognia version listed in `plugin.json.engines.cognia`. |
