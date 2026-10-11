# Cognia glance module plugin template

Scaffold for a `type: "frontend"` cognia plugin that contributes a **glance module**: a small block in the desktop tray panel and the phone's Glance drawer. Stamped by `cognia plugin new <name> --kind glance`.

A glance module is data, never React. The plugin declares the module and publishes what it shows; the host draws it with the same components as its own modules, on desktop and on mobile.

## What you get

```
<your-plugin>/
├── package.json        — public SDK types + esbuild + jest
├── tsconfig.json
├── jest.config.cjs
├── plugin.json         — type: "frontend", the module in glanceModules, two commands
├── src/
│   ├── index.ts        — publishes the module's data, answers its buttons
│   └── index.test.ts   — node tests over visibility, the commands and the data
├── types/              — vendored `@cognia/*` declarations (refresh: `cognia plugin sync-types`)
├── .gitignore
└── README.md
```

| Piece            | Where it is declared            | Where it is implemented         |
| ---------------- | ------------------------------- | ------------------------------- |
| The module       | `plugin.json` `glanceModules[]` | `ctx.glance.update`             |
| On screen or not | nothing                         | `ctx.glance.onVisibilityChange` |
| Its buttons      | `plugin.json` `commands[]`      | `hooks.onCommand`               |
| Labels           | `plugin.json` `i18n.locales`    | `ctx.i18n.t` when publishing    |
| Durable state    | nothing                         | `ctx.storage`                   |
| Teardown         | nothing                         | `ctx.lifecycle.onDispose`       |

## Quick-start

```bash
pnpm install          # or: npm install / yarn install
pnpm test             # jest, should all pass on a fresh scaffold
cognia plugin lint    # validate plugin.json against the host's manifest schema
cognia plugin build   # esbuild → dist/index.js → zip
# Optional: while a cognia desktop instance is running:
cognia plugin install target/cognia/<id>-<version>.zip
```

Once installed and enabled, open the tray panel, choose **Edit**, and add the module from the list: declaring a module never puts it on screen by itself.

## Rules the host enforces

- At most 8 modules per plugin; per module at most 4 stats, 8 rows and 3 actions.
- Labels and titles up to 48 characters, values 24, hints and the summary 80, the empty text 120. Longer strings are cut with an ellipsis.
- An action's `command` is one of **this plugin's** command ids without the plugin prefix; the host runs `<pluginId>.<command>`.
- On a phone paired to the desktop, the module shows the desktop's data read-only, its buttons disabled.
- Publish only what is cheap while the module is hidden; start polling or sockets when `onVisibilityChange` says `true`, stop on `false`.

The full guide is the Glance modules page of the plugin documentation.
