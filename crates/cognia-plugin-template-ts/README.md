# Cognia frontend TS plugin template

Minimal scaffold for a `type: "frontend"` cognia plugin written in TypeScript. Stamped by `cognia plugin new <name> --kind ts`.

## What you get

```
<your-plugin>/
├── package.json        — public SDK + esbuild + jest
├── tsconfig.json
├── jest.config.cjs
├── plugin.json         — type: "frontend", capabilities: ["tools","commands"]
├── src/
│   ├── index.ts        — PluginDefinition with one sample tool + one slash command
│   └── index.test.ts   — jsdom tests covering activate / deactivate / tool / slash command
├── .gitignore
└── README.md
```

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
| `tools` / `commands` | Adjust or delete the sample entries — and update `src/index.ts` to match.                             |

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
