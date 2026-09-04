# Cognia frontend TS plugin template

Minimal scaffold for a `type: "frontend"` cognia plugin written in TypeScript. Stamped by `cognia plugin new <name> --kind ts`.

## What you get

```
<your-plugin>/
├── package.json        — public SDK + esbuild + jest
├── tsconfig.json
├── jest.config.cjs
├── plugin.json         — type: "frontend", every capability below with its contribution block
├── src/
│   ├── index.ts        — PluginDefinition wiring one of each host surface
│   ├── index.test.ts   — jsdom tests over every registration and both hooks
│   ├── panel.tsx       — the UI slot contribution
│   ├── panel.test.tsx  — render test for it
│   └── panel.css       — manifest `styles`, scoped to your subtree by the host
├── types/              — vendored `@cognia/*` declarations (refresh: `cognia plugin sync-types`)
├── .gitignore
└── README.md
```

The sample activation wires one of each surface an author reaches for first:

| Surface          | Where it is declared                 | Where it is implemented                   |
| ---------------- | ------------------------------------ | ----------------------------------------- |
| Agent tool       | `plugin.json` `tools[]`              | `ctx.agent.registerTool`                  |
| Slash command    | `plugin.json` `commands[]`           | `hooks.onCommand`                         |
| Quick action     | `plugin.json` `quickActions[]`       | nothing, it dispatches the command above  |
| UI slot          | `permissions: ["extension:ui"]`      | `ctx.extensions.registerExtension`        |
| Settings         | `plugin.json` `configSchema`         | `ctx.settings` and `hooks.onConfigChange` |
| Durable state    | nothing                              | `ctx.storage`                             |
| Workflow node    | `plugin.json` `workflows.nodes[]`    | `ctx.workflow.registerNode`               |
| Workflow trigger | `plugin.json` `workflows.triggers[]` | `ctx.workflow.registerTrigger`            |
| Teardown         | nothing                              | `ctx.lifecycle.onDispose`                 |

A capability tag whose contribution field is empty is what `cognia plugin lint`
reports as dormant, so delete the tag and the block together when you strip a
sample you do not need.

## Quick-start

```bash
pnpm install          # or: npm install / yarn install
pnpm test             # jest, should all pass on a fresh scaffold
cognia plugin lint    # validate plugin.json against the host's manifest schema
cognia plugin build   # esbuild → dist/index.js → zip
# Optional: while a cognia desktop instance is running:
cognia plugin install target/cognia/<id>-<version>.zip
```

The build step bundles `src/index.ts` (and anything it imports) into a **single CommonJS file at `dist/index.js`**. That bundled file is what cognia loads at runtime — `plugin.json`'s `main` field must point at it. Do not rename or move it without also updating the manifest.

## Editing the manifest

The fields you typically change first:

| Field                | What                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `id`                 | Globally unique plugin id (lowercase, hyphens / underscores / dots, alphanumeric start).              |
| `name`               | Human-readable display name.                                                                          |
| `description`        | One-sentence elevator pitch.                                                                          |
| `permissions`        | Capabilities you need (e.g. `clipboard:read`, `network:fetch`). Run `cognia plugin lint` to validate. |
| `capabilities`       | Every tag needs its contribution field populated. Drop the tag and the block together.                |
| `tools` / `commands` | Adjust or delete the sample entries — and update `src/index.ts` to match.                             |
| `configSchema`       | Your plugin's own settings. `ctx.settings.get` answers from here.                                     |

After each manifest edit, re-run `cognia plugin lint` before rebuilding.

## Adding capabilities

Each capability ships through a different host bridge. Refer to:

- [Plugin API overview](https://docs.cognia.dev/plugin-dev/api-overview)
- [Manifest reference](https://docs.cognia.dev/plugin-dev/manifest)
- [Permissions catalog](https://docs.cognia.dev/plugin-dev/permissions)

## Testing

Tests use **jest + jsdom** and import types only from `@cognia/plugin-sdk`. Mirror the mock-`PluginContext` pattern shown in `src/index.test.ts` when you add your own tests. Do not import `@/lib`, `@/types`, or `@cognia/plugin-sdk/host`; those are host internals and are unavailable to distributed plugins.

## Packaging

`cognia plugin build` produces `target/cognia/<id>-<version>.zip` containing `plugin.json` + `dist/index.js`. To distribute via the marketplace, sign the bundle:

```bash
cognia plugin keygen
# embed printed public key in plugin.json author.publicKey
cognia plugin sign target/cognia/<id>-<version>.zip --key .cognia/plugin.private.b64
cognia plugin verify target/cognia/<id>-<version>.zip
```

See `packaging.mdx` in the cognia docs for the full publish flow.
