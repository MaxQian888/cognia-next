---
title: "0148 — Style packs and layer-semantic surfaces"
description: "Appearance had every shape knob and no way to bundle them, and wallpaper translucency reached only 28 registered data-slots — so a hard-edged look was unreachable and the app's own panels stayed opaque. Adds a pack layer for shape, a Surface primitive for tiers, and a gate so neither regrows."
---

# ADR 0148 — Style packs and layer-semantic surfaces

**Status:** Accepted
**Date:** 2026-08-25
**Related:** [ADR-0007](./0007-theme-and-background-fix), [ADR-0114](./0114-chat-message-presentation), [ADR-0127](./0127-chat-render-transport-efficiency), [ADR-0092](./0092-official-website-workspace)

## Context

Three complaints arrived together: the app should offer a hard-edged look with
no rounded corners, image backgrounds are poorly supported, and different
components feel disjointed. Investigation showed the first was blocked by a
token gap, and the second and third are one defect seen from two angles.

**The knobs already existed; nothing bundled them.** `lib/appearance/` ships 77
files — a radius slider, density, motion, typography, per-component tonality and
elevation, five wallpaper scopes with blur, opacity, focal point and a
readability scrim, nine hand-authored themes, VSCode `.json`/`.vsix` import,
OKLCH variant derivation and WCAG guards. But the eight presets in
`lib/themes/preset-meta.ts` carry *accent colours only*. Nothing tied shape
together, so "make it hard-edged" meant hand-tuning a dozen scattered controls.

**And it would still have failed.** Setting `--radius: 0` squares the ~1,777
sites using `rounded-sm/md/lg/xl`, because `@theme inline` derives those from
the base. It does not touch 491 `rounded-full` declarations, 24 `rounded-2xl` /
`rounded-3xl`, or 252 `shadow-*` utilities — none of which any setting can
reach. Worse, shadcn derives the steps as fixed pixel offsets
(`--radius-xl = base + 4px`), so even a zero base left the largest step at 4px.
A truly square UI was not expressible.

**Wallpaper translucency reached 28 components.** `component-style-registry.ts`
lists 28 `data-slot` values, each choosing its own tonality independently, and
`globals.css` spends ~830 unlayered lines painting them. Every bespoke surface —
page shells, rails, sidebars, feature cards — was invisible to that system and
stayed fully opaque. So an enabled wallpaper showed only in the gaps, and
neighbouring panels sat at visibly different opacities. Seven routes
(`/logs`, `/devices`, `/agent-runs`, `/templates`, `/goals`, `/integrations`,
`/servers`) carried no `data-bg-target` at all and rendered no wallpaper
whatsoever — the same shape as ADR-0007's E1 defect, where the scope selector
existed in CSS but no component applied the attribute it keyed off.

**The design language already existed.** `web/app/globals.css` pins
`--radius-control: 8px`, `--radius-panel: 12px`, `--radius-stage: 14px` with the
comment "No oversized pills", plus hairline rules and `--action: #35cedd`, which
the product already copies verbatim. The website was the disciplined version of
the product's own look.

## Decisions

### 1. A style pack layer, orthogonal to colour

`types/appearance/style-pack.ts` adds three packs — **Soft** (today's default),
**Studio** (the website's language) and **Sharp** (square everything that is not
a circle) — each setting radius base, pill radius, elevation ceiling, border
tone, density, micro-label treatment and composer skin.

Packs never carry a colour token, so Sharp × Catppuccin and Sharp × an imported
VSCode theme are both valid. A test asserts no pack value can contain a colour.

The shape is `{ packId, overrides }`, deliberately mirroring the existing
`MessageDisplayPreferences` so the settings UI, changed-settings review and
per-section reset behave the way users already expect.

### 2. Soft is inert by construction, not by promise

`resolveStylePackDom` returns all-nulls for Soft and the applier writes nothing.
The default look cannot regress because there is no code path that changes it —
the same guarantee `RadiusApplier`'s default branch and the `classic` composer
skin already give, and it is pinned by a test rather than left to review.

### 3. Radius and density stay owned by their existing appliers

`StylePackApplier` writes the shape attributes and two custom properties. It
does **not** write `--radius` or `data-density`; `RadiusApplier` and
`DensityApplier` read the pack as their base value instead. Two appliers writing
one inline property would race, and the loser would erase the winner on every
settings change.

Precedence is explicit in both: the pack supplies the base, and the user's own
control overrides it *only once moved off its default*. Leaving a slider
untouched therefore means "let the pack decide", which is what makes picking
Sharp actually square the UI. The Style panel states which of the two is in
charge rather than letting the number silently disagree.

### 4. The named scale aliases the existing chain, and scales proportionally

`--radius-control` / `-panel` / `-stage` are added as multipliers on the same
base (`0.8` / `1.2` / `1.4`), landing on exactly 8 / 12 / 14px at the default
0.625rem — the website's scale — so the ~1,777 sites already using
`rounded-sm/md/lg/xl` follow a pack with zero migration.

The existing four steps become multipliers too (`0.6` / `0.8` / `1.0` / `1.4`).
They hit the same 6 / 8 / 10 / 14px at the default base, and unlike the shipped
±px offsets they collapse to zero with it. This was found by rendering the packs
side by side, not by reading the code.

### 5. Pills are a separate axis

`--radius-pill` is its own token, so squaring the UI never squares a status dot,
spinner, radio button or avatar. The split is semantic: a padded capsule is
chrome and follows the pack; a circle is a circle. 89 padded capsules across 74
files and 11 declarations in the shadcn primitives were converted; avatars stay
round by explicit product decision. `rounded-2xl` / `rounded-3xl` have no link
to `--radius` at all, so a pack rebases them in CSS rather than by editing 24
call sites — which also keeps the default look untouched, since the rule cannot
match when no pack is active.

### 6. Surfaces declare a tier, not a value

`components/surface/surface.tsx` replaces "configure a tonality per component"
with "declare which tier you are": `base` (page ground), `raised` (cards,
panels), `overlay` (popovers, dialogs). Three rules decide what a tier looks
like, so two panels on the same tier cannot drift apart.

The mechanism matters as much as the model. `Surface` reads `--surface-bg`
instead of painting `bg-card`, and the tier rules only ever *set* custom
properties. A custom property never competes with a Tailwind utility for
specificity, so unlike the existing wallpaper layer none of this needs unlayered
overrides: 15 selectors replace what ~830 lines say per slot, and they cover any
surface the moment it adopts `Surface`. The old rules stay as a compatibility
shim for everything not yet migrated.

`Card` and `Alert` are re-based with their look unchanged. `Card` alone carries
~559 call sites and `SettingsCard` builds on it, so that whole population
participates without touching a caller.

Two deliberate limits: `Surface` owns the background only (owning the foreground
would put `text-[var(--surface-fg)]` against an explicit `text-destructive`, and
Tailwind sorts arbitrary values after named ones), and `backdrop-filter` is
applied by `globals.css` only while a wallpaper is on, never as a class —
it promotes a compositing layer even at `blur(0px)`, and these containers render
inside the virtualized chat list.

### 7. The shells own the wallpaper scope marker

`FeaturePageShell` and `SubPageShell` apply `data-bg-target` themselves,
covering 14 feature routes and 51 mobile sub-pages, so a new route cannot
forget. The nine page wrappers that carried it give it up — a nested target
paints a second `::before` layer and doubles the wallpaper's effective opacity.

### 8. A ratcheted gate, because this is cheap to create and expensive to find

`pnpm audit:surfaces` refuses new bare panel containers (a `div` carrying
radius + border + background) and new radius/shadow values no setting can reach.
The existing occurrences go into a baseline that may shrink and
never grow, with per-file counts so paying debt down in one place cannot fund a
new panel elsewhere.

A companion test walks every `app/*/page.tsx` and fails on any route that cannot
reach a `data-bg-target`, following barrel re-exports so a route importing
through `@/components/plugins` is not mistaken for unmarked. Both sweeps assert
they scanned a non-trivial number of files, because a sweep that silently
matches nothing passes just as green as one that finds nothing.

## Consequences

- Picking Sharp squares the app, removes shadows, tightens density and sets
  micro-labels in monospace caps. Verified in-browser across all three packs.
- The corner-radius slider becomes an override on the pack and moves to the new
  Style panel, so one value has one control.
- `stylePack` is a `shared` sync key: it must travel with `density` and
  `radius`, or a phone receives the desktop's resolved radius without the pack
  that produced it.
- The mobile minimum-radius floor is removed. Touch *size* stays enforced at
  44px; radius is aesthetics, and the floor made the phone composer the only
  rounded object on a squared screen.

## Out of scope

- Unifying the four independent editor/chart theme channels (Monaco,
  CodeMirror, chart.js, Mermaid). Four separate migrations, and code-server is a
  native child window CSS cannot reach at all.
- Migrating the baselined occurrences. The gate holds the line, and the debt is
  paid down opportunistically.
- Renaming the background scope vocabulary (`chat` is used as a generic content
  scope). The functional gap it caused is fixed by decision 7; the rename is
  ergonomics and touches ~35 files plus 103 CSS selectors.

## Known gaps

- `settings-sync:gen` still cannot run end to end: `docs/api/mobile-companion-api.openapi.yaml`
  is now written by the companion-api generator, which rewrote the file without
  the `# BEGIN/END GENERATED settings-sync` markers this generator edits between,
  so it throws before writing anything. The **Rust** mirror is no longer stale —
  the wallpaper fix below regenerated it through the generator's own
  `renderRust()`, which also carried `stylePack` and `costBudget` across — but the
  published OpenAPI enum still omits `cursor`, `componentStyles`, `monacoLink`,
  `usageDisplayMode` and `stylePack` until the markers are restored.
- ~~`wallpapers` is in `MOBILE_WRITABLE_SETTING_KEYS`~~ — **fixed.** It is
  `device-local` now. Two of the five `WallpaperSource` shapes are references
  into one machine's storage (`disk` = a path under that Tauri host's appData,
  `indexeddb` = a key in that browser's blob store), and `saveImage()` picks
  between them by `isTauri()` — so a desktop only ever wrote `disk` and a phone
  only ever wrote `indexeddb`, and mirroring the array handed each side exactly
  the kind it could not resolve. Because the projection
  (`lib/sync/desktop-sync-source.ts`) and the up-mirror
  (`lib/settings/mirror-to-host.ts`) both derive from the one classification
  table, the single reclassification closes both directions. Rows mirrored before
  the fix are left in place rather than swept: the gallery now names the device
  that holds the image, refuses to activate the tile (activating one is what made
  `BackgroundApplier` switch the whole background off) and keeps delete
  available.
