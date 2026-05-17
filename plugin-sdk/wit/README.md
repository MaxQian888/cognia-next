# Cognia plugin WIT contract — mirrored

This directory mirrors the canonical WebAssembly Interface Types contract used by Cognia WASM plugins. **Do not hand-edit `cognia-plugin.wit` here.** The source of truth is `src-tauri/wit/cognia-plugin.wit`; this copy exists so external WASM plugin authors can reference the contract without checking out the host crate.

## Workflow

After editing the canonical file under `src-tauri/wit/`:

```bash
pnpm sync:plugin-sdk-wit
```

This rewrites `plugin-sdk/wit/cognia-plugin.wit` to match the canonical file exactly.

To verify the two files have not drifted (e.g. in CI or before a commit):

```bash
pnpm lint:plugin-sdk-wit
```

The check script exits non-zero with a unified diff if the files differ.

## Versioning

The contract is versioned via the `package cognia:plugin@<semver>;` directive at the top of the file. Host runtime version compatibility is also embedded as a `cognia:api-version` custom section in built `.wasm` artifacts; see ADR-0013 for the routing strategy across major revisions.

Version `0.1.0` ships seven imports (logger, notification, secrets, process, clipboard, ai, workflow) and four exports (init, on-event, workflow-node-execute, tool-execute). Additive minor revisions add new interfaces / functions; breaking changes bump the major.
