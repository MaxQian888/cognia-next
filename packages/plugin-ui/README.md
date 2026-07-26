# @cognia/plugin-ui

The component surface third-party Cognia plugins render with.

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

## Why this is a fork, not a re-export

The host has ~59 shadcn/ui primitives in `components/ui/`. This package carries
its own copies of ten of them instead of re-exporting, for two reasons:

1. **It must resolve standalone.** A plugin author outside this repo installs
   the package and typechecks against it; a `@/components/ui/...` import would
   not resolve. `pnpm build:packages` enforces that no `@/` path leaks in here.
2. **A public surface should not track internal refactors.** `components/ui/`
   is free to change with `shadcn add` and with app needs. This package changes
   only when we decide to change the plugin contract. Divergence is the point.

When you _do_ want to pull an upstream change across, copy the file and swap
`@/lib/utils` → `./cn`. Nothing else in these files references the app.

## What is not here

`react-dom` is deliberately absent from the host's shared-module whitelist, so
there is no `createPortal`. A plugin renders inside the slot or panel it was
mounted into and cannot escape it. Components in this package that need layering
(`Select`, `Tooltip`) use Radix's own portal, which the host mounts and controls.
