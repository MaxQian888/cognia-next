# wasm-example-formatter

End-to-end reference for a `type: "wasm"` cognia plugin. Demonstrates:

- **notification** — pops a toast on activation
- **filesystem read/write** — uses the WASI sandboxed plugin data dir
- **process spawn** — invokes `rustfmt` via the `cognia:plugin/process` import
  (allow-listed by `"shellCommands": ["rustfmt"]` — `process.exec` is
  deny-by-default and refuses any program the manifest does not name)
- **agent tool** — registers the `format_rust` tool the agent can call
- **workflow node** — adds `action.wasm-example-formatter.format` to the visual workflow palette

## Known limitation: formatting does not complete yet

`rustfmt` runs as a **host** process, but the source file this plugin writes
lives at a WASI guest path (`/format-input.rs`, which is the plugin's data
directory inside the sandbox). The host process cannot open that path, and
`cognia:plugin/process@0.2.0`'s `exec` has no stdin channel to pipe the
source through instead. So every call reaches rustfmt, rustfmt reports the
input missing, and the plugin returns:

```text
HOST_UNAVAILABLE: format_rust cannot hand the source to rustfmt on this host. …
```

It does not return an empty "formatted" string. The plugin still exercises the
notification, filesystem, allow-list and process-capability gates end to end;
the fix is a WIT contract change (a `stdin` field on `exec-options`), not a
guest change. The host also starts the child with an empty environment, so
`rustfmt` must be resolvable without your shell's `PATH`.

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
# From plugins/wasm-example-formatter, with the `cognia` CLI in PATH:
cognia plugin build .
```

That writes `target/cognia/wasm-example-formatter-0.1.0.zip`. In the desktop
app open **Plugins** (`/plugins`) → **Install** → under **WASM bundle** pick
**From local file…**, and choose that `.zip`.

## Try it

After install + grant, you can:

- **Agent tool**: ask the assistant to "format this Rust code: \`fn main() { let x = 1; }\`". It calls `format_rust` via the cognia agent runtime.
- **Workflow node**: open **Workflows** (`/workflows`) → create a workflow → drag the **Format Rust** node onto the canvas, wire it to a string input, and run.

Until the limitation above is lifted, both return the `HOST_UNAVAILABLE`
error. Once the host can pipe stdin, the plugin returns a JSON envelope:

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

Revoke `process:spawn` from **Plugins** (`/plugins`) → wasm-example-formatter →
Permissions, then call `format_rust` again — the call fails with
`capability process:spawn not granted to plugin wasm-example-formatter` plus a
pointer back to that permission.
