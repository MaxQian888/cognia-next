# Cognia design evidence map

Read the smallest relevant set, but always include the first four entries.

| Concern | Canonical evidence |
| --- | --- |
| Default light/dark palette, radius, surface translucency, motion, workflow and chart signals | `app/globals.css` |
| Font loading and root theme cascade | `app/layout.tsx` |
| Default shell hierarchy and desktop layout | `components/desktop/desktop-app-shell.tsx` |
| Shared component geometry and states | `components/ui/button.tsx`, `input.tsx`, `card.tsx`, `tabs.tsx`, `sidebar.tsx` |
| Runtime theme precedence | `lib/appearance/custom-theme-applier.tsx`, `plugin-theme-applier.tsx`, `resolve-app-palette.ts` |
| Built-in optional palettes | `lib/themes/index.ts`, `preset-meta.ts`, `built-in-themes.ts` |
| Typography, density, radius, motion, and accessibility defaults | `types/appearance/index.ts`, `lib/appearance/*-applier.tsx` |
| Component surface overrides | `lib/appearance/component-style-applier.tsx` |
| Mobile shell, safe areas, and navigation | `components/app-shell-mobile.tsx`, `components/mobile/shell/` |
| Product identity and supported surfaces | `README.md`, `docs/content/docs/en/index.mdx` |
| Theme/background rationale | `docs/content/docs/en/adr/0007-theme-and-background-fix.md` |

## Known interpretation traps

- The no-customization DOM baseline comes from `app/globals.css`. The
  conservative hex palette in `lib/themes/index.ts` serves theme resolution and
  plugin APIs; it does not replace the CSS baseline when the default preset
  short-circuits in `CustomThemeApplier`.
- Cognia is user-customizable. Document the stable semantic contract and
  default values, then describe customization layers rather than enumerating
  every optional preset as brand truth.
- Some appearance variables are scaffolding. Confirm that a component or CSS
  rule consumes each variable before claiming the corresponding setting
  changes the rendered UI.
- `components/ui/` and `components/ai-elements/` are vendored implementation
  primitives, but their current classes are still valid evidence for geometry
  and states.
- Wallpaper translucency is conditional on `body[data-bg-enabled="true"]`.
  Solid surfaces remain the baseline when wallpaper is disabled.
- The terminal intentionally keeps a dark-console identity in both theme
  modes.
