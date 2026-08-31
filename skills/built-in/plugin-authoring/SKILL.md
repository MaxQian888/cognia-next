---
name: plugin-authoring
description: Create or extend a Cognia plugin through the current CLI contract and public SDK surfaces.
category: development
tags: [plugin, authoring, sdk, extension]
allowed-tools:
  - Read
  - Glob
  - Grep
  - Write
  - Edit
  - Bash
metadata:
  delivery: explicit
  triggers:
    surfaces: []
    intents: [create-cognia-plugin, extend-cognia-plugin]
  capability-requirements:
    - capability: workspace
      reason: plugin authoring reads and writes only inside the active workspace
    - capability: cognia-cli
      reason: canonical scaffold, contract, build, and verification commands come from the managed CLI
  host-policies: [workspace-confined, host-consent, permission-ceiling, user-language]
---

Produce a build-ready Cognia plugin. Never infer contract facts from memory or maintain a local capability list.

This skill is explicit-only: use it only when the user attached or directly selected it. Attachment exposes guidance, not authority; workspace confinement, destructive-action confirmation, and the host permission ceiling still apply.

## Establish the contract

1. Determine whether the request creates a plugin or extends an existing plugin.
2. If the request is a whole-bundle ecosystem import, export, migration, or port, stop and use `plugin-conversion`.
3. Confirm `cognia` is available. If it is not, stop and direct the user to **Plugins → DevTools → cognia CLI** for the managed one-click install. Do not reconstruct the contract manually.
4. Inspect the workspace before planning. For an existing plugin, read `plugin.json`, runtime entries, package/build configuration, tests, public SDK imports, activation, cleanup, and every file referenced by contributions. Preserve unrelated files and configuration.
5. Query only the relevant canonical records. Repeat selectors when needed:

   ```bash
   cognia plugin contract \
     --capability <id> \
     --contribution <field> \
     --plugin-type <type> \
     --point <id> \
     --point-kind <kind> \
     --permission <permission> \
     --json
   ```

   Point kinds are `ui-slot`, `hook`, `activation`, and `runtime`. Run the unfiltered command only when inventory discovery is necessary. Read `support`, `pythonExecution`, `execution`, point `status`/`stability`, `formFactor`, required permissions, replacements, entry paths, path-field rules, minimum host versions, and runtime-entry rules. Inspect public author types from `@cognia/plugin-sdk`, `@cognia/plugin-ui`, the Python `cognia` package, or the packaged WIT; never use host internals.

## Plan before mutation

Present a decision-complete plan containing:

- new or existing target and selected runtime;
- requested behavior and canonical UI, hook, activation, or runtime points;
- capabilities, contributions, permissions, and minimum host version;
- runtime entries, manifest path fields, exports, cleanup, and wiring;
- exact files to create or edit, including co-located tests;
- runtime-specific verification commands.

Wait for confirmation unless the user already supplied an equivalent approved specification. Clarify missing business behavior instead of substituting placeholders.

Before any write:

- Block a contribution that is incompatible with the selected runtime and offer only runtime choices supported by the queried contract.
- Require explicit confirmation for every selected record with `support=experimental`, `stability=experimental`, or an experimental `pythonExecution` seam. Retain the warning in the final report.
- For new work, reject every deprecated point and use its `replacementId`. When extending a plugin that already declares one, preserve behavior only long enough to migrate it in the same change.
- Reject path traversal, invalid entry paths, unsupported runtime combinations, and permissions that are absent from the canonical contract.

## Implement the approved plan

1. For a new plugin, inspect `cognia plugin new --help`, map the selected contract runtime to its scaffold kind (`frontend` uses `ts`), then run `cognia plugin new <name> --kind <kind> --dir <path> --json`. For an existing plugin, edit surgically and preserve unrelated behavior.
2. Run `cognia plugin sync-types --path <path>` before implementation.
3. Implement the complete requested behavior through the selected public runtime surface:
   - `frontend`: public `@cognia/plugin-sdk` and `@cognia/plugin-ui` exports;
   - `python`: the scaffolded public `cognia` module and a queried supported `pythonExecution` seam;
   - `hybrid`: explicit JS/Python backend ownership and both required entries;
   - `wasm`: the scaffolded WIT imports/exports and `wasmMain`, never a JS or React contribution;
   - `vscode-extension`: only the declared VS Code entry/assets accepted by its `requiredAnyOf` contract.
4. For a UI point, implement for its queried `formFactor`; render with `@cognia/plugin-ui`, rely on the host's shared React instead of bundling another copy, and supply plugin-owned i18n plus localized accessible names, placeholders, empty/error text, and dialog close labels. Do not import host components or use `react-dom` portals.
5. Update `plugin.json` with only the required capabilities and permissions. Respect the queried minimum host version, runtime compatibility, i18n, and path-field contract.
6. Wire every declared contribution to a real runtime export. Wire activation, disposal/cleanup, and all required entries. Every new contribution must be reachable from the host activation path.
7. Add co-located tests for behavior, activation, cleanup, exports, manifest wiring, UI form factor/i18n when applicable, and relevant failure/permission boundaries.
8. Reject undeclared permissions and any implementation whose imports, runtime, contribution execution kind, points, or paths contradict the queried contract. Do not add stubs, TODO behavior, host-only imports, or dormant contributions.

## Verify and report

Run all applicable gates from the plugin directory and fix failures:

```bash
cognia plugin doctor # read-only; do not add --fix unless explicitly requested
cognia plugin lint --json
# Run the runtime's tests and typecheck/build command.
cognia plugin build --json
cognia plugin info <built-bundle> --json
```

Report the runtime, behavior, capabilities, contributions, permissions, minimum host version, files, wiring, tests, bundle path, and verification evidence. Include any experimental warning.

Stop at a build-ready artifact by default. Generate keys, sign, verify signatures, install, reload, export, or publish only when the user explicitly requests that operation.
