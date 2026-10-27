# wasm-example-formatter

End-to-end reference for a `type: "wasm"` cognia plugin. Demonstrates:

- **notification** — pops a toast on activation
- **filesystem read/write** — uses the WASI sandboxed plugin data dir
- **process spawn** — invokes `rustfmt` via the `cognia:plugin/process` import
  (allow-listed by `"shellCommands": ["rustfmt"]` — `process.exec` is
  deny-by-default and refuses any program the manifest does not name)
- **agent tool** — registers the `format_rust` tool the agent can call
- **workflow node** — adds `action.wasm-example-formatter.format` to the visual workflow palette

## Process input and compatibility

The formatter uses `cognia:plugin@0.2.1`'s additive `process.exec-with-stdin`.
It saves the source inside the plugin data directory, then sends the source
bytes over stdin to host rustfmt with fixed `--emit stdout --edition 2021`
arguments. No guest path is passed to the host process. Tool calls and workflow
nodes return the same formatted text, diagnostics and exit code as rustfmt.

Existing v0.2.0 plugin binaries keep their original `process.exec` signature,
record layouts, null stdin, output-size behavior and ordinary error strings.
The host still runs those binaries without rebuilding them.

The new operation accepts up to 4 MiB of binary input and 8 MiB per output
stream, closes stdin for EOF, drains both streams concurrently, and reports
`PAYLOAD_TOO_LARGE` rather than returning incomplete output. Execution is
bounded by the smaller of the requested timeout and `wasm.callTimeoutMs`.
Stopping/unloading the plugin cancels its process; timed-out children are
killed and reaped. On Unix, cleanup covers the process group.

The child's environment is cleared. In the plugin settings, `rustfmtProgram`
can name an executable or an absolute native binary. For a rustup installation,
run `rustup which rustfmt` and use the returned path; a rustup shim may require
host environment that plugins deliberately do not inherit.

## Prerequisites

```bash
rustup target add wasm32-wasip1
cargo install --locked cargo-component
# rustfmt is part of the default Rust toolchain
```

## Build

```bash
cd plugins/wasm-example-formatter
cargo component build --release
```

Output: `target/wasm32-wasip1/release/wasm_example_formatter.wasm`.

## Install (development)

```bash
# From plugins/wasm-example-formatter, with the `cognia` CLI in PATH:
cognia plugin build
```

That writes `target/cognia/wasm-example-formatter-0.1.0.zip`. In the desktop
app open **Plugins** (`/plugins`) → **Install** → under **WASM bundle** pick
**From local file…**, and choose that `.zip`.

## Try it

After install + grant, you can:

- **Agent tool**: ask the assistant to "format this Rust code: \`fn main() { let x = 1; }\`". It calls `format_rust` via the cognia agent runtime.
- **Workflow node**: open **Workflows** (`/workflows`) → create a workflow → drag the **Format Rust** node onto the canvas, wire it to a string input, and run.

Both return a JSON envelope. Non-zero rustfmt exits keep their diagnostics:

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
