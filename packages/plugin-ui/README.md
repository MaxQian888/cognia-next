# @cognia/plugin-ui

The component surface third-party Cognia plugins render with.

Install the version that matches the host SDK contract:

```bash
pnpm add @cognia/plugin-ui@^0.2.0
```

```tsx
import { Button, Card, CardContent } from "@cognia/plugin-ui"

export function Panel() {
  return (
    <Card>
      <CardContent>
        <Button size="sm">Run</Button>
      </CardContent>
    </Card>
  )
}
```

## How it resolves

`cognia plugin build` marks this package (and `react`) **external**, so your
bundle contains neither. At load time the host resolves
`require("@cognia/plugin-ui")` from its own module graph
(`lib/plugin/core/loader.ts`). Consequences worth knowing:

- Every plugin shares **one** React and **one** copy of these components. This
  is what makes hooks work inside a plugin component — a bundled second React
  would have its own dispatcher and throw `Invalid hook call`.
- You get the host's theme for free. These components reference CSS custom
  properties (`--primary`, `--radius`, `--density-*`, …) rather than literal
  colors, so they track the user's theme, color preset, density preset and
  reduce-motion setting without the plugin reading anything.

## Reactive data

`useLiveQuery` re-renders a component when the plugin's own Dexie tables
change:

```tsx
import { useLiveQuery } from "@cognia/plugin-ui"

const runs = useLiveQuery(() => ctx.dexie.table("runs").reverse().toArray(), [], [])
```

Import it from here, not from `dexie-react-hooks`. Dexie tracks changes in a
module-level registry, so a copy bundled into your plugin never hears about
writes made through the host's Dexie instance (the one `ctx.dexie` hands out),
and the list quietly stops updating.

Translate strings in a component with `usePluginTranslations(pluginId)` from
`@cognia/plugin-sdk/api/i18n` — the same keys and fallback as `ctx.i18n.t`.
Do not import `next-intl` or `next/navigation`: the host does not share them
with plugins; use `ctx.ui.navigate("/settings?…")` to change route.

## Why this is a fork, not a re-export

The host has ~59 shadcn/ui primitives in `components/ui/`. This package carries
a curated set of 30 primitives instead of re-exporting every host component,
for two reasons:

1. **It must resolve standalone.** A plugin author outside this repo installs
   the package and typechecks against it; a `@/components/ui/...` import would
   not resolve. `pnpm build:packages` enforces that no `@/` path leaks in here.
2. **A public surface should not track internal refactors.** `components/ui/`
   is free to change with `shadcn add` and with app needs. This package changes
   only when we decide to change the plugin contract. Divergence is the point.

When you _do_ want to pull an upstream change across, copy the file and swap
`@/lib/utils/index` → `./cn`. Nothing else in these files references the app.

## What is not here

`react-dom` is deliberately absent from the host's shared-module whitelist, so
there is no `createPortal`. A plugin renders inside the slot or panel it was
mounted into and cannot escape it. Components in this package that need layering
(`Dialog`, `Select`, `Sheet`, `Tooltip`) use Radix's own portal, which the host
mounts and controls. Dialogs must include `DialogTitle`; pass localized
`closeLabel` text because this standalone package cannot read the host's
`next-intl` catalog.

Import author-facing components and motion helpers only from the package root.
Deep component imports are intentionally outside the runtime shared-module
contract.
