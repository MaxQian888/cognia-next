# @cognia/plugin-sdk

Standalone TypeScript SDK for authoring Cognia plugins. The published package contains author
contracts, callable context interfaces, pure `define*` helpers, contract metadata, and the WASM
WIT contract. Host registries, bridges, executors, database access, and authentication flows are
not public plugin APIs.

## Quick start

```ts
import { definePlugin, defineTool, type FullPluginContext } from "@cognia/plugin-sdk"

const echo = defineTool({
  name: "echo",
  description: "Return the supplied text.",
  parameters: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
})

export default definePlugin({
  manifest: {
    id: "example.echo",
    name: "Echo",
    description: "Example Cognia plugin.",
    version: "0.1.0",
    type: "frontend",
    capabilities: ["tools"],
    main: "dist/index.js",
  },
  async activate(ctx: FullPluginContext) {
    ctx.logger.info(`Loaded ${echo.name}`)
  },
})
```

## Public imports

- `@cognia/plugin-sdk`: all stable author types, contract metadata, and `define*` helpers.
- `@cognia/plugin-sdk/manifest`: manifest and contribution types plus `definePlugin`.
- `@cognia/plugin-sdk/context`: `PluginContext`, `FullPluginContext`, and callable API interfaces.
- `@cognia/plugin-sdk/contracts`: capability, permission, runtime, and path-field metadata.
- `@cognia/plugin-sdk/events`: stable event constants and event payload types.
- `@cognia/plugin-sdk/hooks`: lifecycle hook payloads and hook interfaces.
- `@cognia/plugin-sdk/permissions`: public permission values and permission types.
- `@cognia/plugin-sdk/extensions`: extension-point constants and contribution types.
- `@cognia/plugin-sdk/templates`: unified template definitions, node-group helpers, package
  helpers, and the runtime `PluginTemplatesAPI` contract.
- `@cognia/plugin-sdk/api/tool` and `/api/native-anthropic-tool`: explicit compatibility
  subpaths resolving to the safe author surface in the published package.

The npm tarball ships ESM, CJS, declarations, the language-neutral contract catalog, and
`wit/cognia-plugin.wit`. It has no dependency on Cognia monorepo aliases or private host packages.

## Primary manifest contribution types

| Manifest field    | Author type                |
| ----------------- | -------------------------- |
| `a2uiComponents`  | `A2UIPluginComponentDef`   |
| `a2uiTemplates`   | `A2UITemplateDef`          |
| `tools`           | `PluginToolDef`            |
| `cliTools`        | `PluginCliToolDef`         |
| `modes`           | `PluginModeDef`            |
| `commands`        | `PluginManifestCommandDef` |
| `quickActions`    | `PluginQuickActionDef`     |
| `scheduledTasks`  | `PluginScheduledTaskDef`   |
| `lspServers`      | `PluginLspServerDef`       |
| `ocrProviders`    | `PluginOcrProviderDef`     |
| `aiProviders`     | `PluginAiProviderDef`      |
| `petAchievements` | `PluginPetAchievementDef`  |
| `petItems`        | `PluginPetItemDef`         |

## Runtime and path rules

- `frontend` contributions execute JavaScript and require `main`.
- `python` plugins require `pythonMain`. Declaring a JavaScript lazy contribution also requires a
  JavaScript `main`, making the plugin hybrid in practice.
- `hybrid` plugins may use both entries; any JavaScript contribution requires `main`.
- `wasm` plugins require `wasmMain`; VS Code extensions use the VS Code runtime entry.
- Every plugin-controlled path is relative to the installed plugin root. Absolute, drive-relative,
  UNC, Windows device-namespace, encoded traversal, control-character, and `..` paths are rejected.
- Desktop JavaScript plugins run under Cognia's checksum-pinned bundled Node 26 runtime (minimum
  patched version 26.3.1); author manifests cannot select an arbitrary executable.

`FullPluginContext` reflects the full host surface. In particular, `memory`, `pet`, `webview`,
`auth`, and `uri` are required there; the intentionally partial base `PluginContext` retains
optional feature fields.

## Compatibility

`engines.cognia` in `plugin.json` is the host compatibility authority. The exported catalog has a
schema version and minimum host version so author tooling can reject unknown capabilities before
packaging. Additive SDK changes use pre-1.0 minor releases.

Host code inside the Cognia repository may temporarily use the unexported source-only
`@cognia/plugin-sdk/host` compatibility module. It is absent from `package.json#exports` and the
npm tarball and must never be imported by third-party plugins.
