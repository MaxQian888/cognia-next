# wasm-example-formatter

End-to-end reference for a `type: "wasm"` cognia plugin. Demonstrates:

- **notification** — pops a toast on activation
- **filesystem read/write** — uses the WASI sandboxed plugin data dir
- **process spawn** — invokes `rustfmt` via the `cognia:plugin/process` import
- **agent tool** — registers the `format_rust` tool the agent can call
- **workflow node** — adds `action.wasm-example-formatter.format` to the visual workflow palette

## Prerequisites

```bash
rustup target add wasm32-wasip2
cargo install --locked cargo-component
# rustfmt is part of the default Rust toolchain
```

## Build

```bash
cd plugins/wasm-example-formatter
cargo component build --release
```

Output: `target/wasm32-wasip2/release/wasm_example_formatter.wasm`.

## Install (development)

```bash
# From the cognia repo root, with `cognia` CLI in PATH:
cognia plugin build .
# Then open cognia → Settings → Plugins → "Install local WASM plugin"
# and pick the generated `.zip` under target/cognia/.
```

## Try it

After install + grant, you can:

- **Agent tool**: ask the assistant to "format this Rust code: \`fn main() { let x = 1; }\`". It calls `format_rust` via the cognia agent runtime.
- **Workflow node**: open Settings → Workflows → new workflow → drag the **Format Rust** node onto the canvas, wire it to a string input, and run.

The plugin returns a JSON envelope:

```json
{
  "formatted": "fn main() {\n    let x = 1;\n}\n",
  "stderr": "",
  "exit_code": 0
}
```

## Capability boundary

The plugin **cannot**:

- Access any file outside `<app_data>/cognia/plugins/wasm-example-formatter/data/`
- Spawn any process if the user revokes `process:spawn`
- Read or write the network (no `network:fetch` declared)
- Touch the OS clipboard or keyring (no `clipboard:*` / `secrets:*` declared)

Revoke `process:spawn` from Settings → Plugins → wasm-example-formatter
→ Permissions, then call `format_rust` again — the call traps with
`capability process:spawn not granted to plugin wasm-example-formatter`.
