---
version: alpha
name: Cognia
description: A calm, adaptive AI workbench for desktop, web, and mobile — dense where the content is, restrained where the chrome is.
colors:
  primary: "oklch(0.205 0 0)"
  primary-foreground: "oklch(0.985 0 0)"
  background: "oklch(1 0 0)"
  foreground: "oklch(0.145 0 0)"
  card: "oklch(1 0 0)"
  card-foreground: "oklch(0.145 0 0)"
  popover: "oklch(1 0 0)"
  popover-foreground: "oklch(0.145 0 0)"
  secondary: "oklch(0.97 0 0)"
  secondary-foreground: "oklch(0.205 0 0)"
  muted: "oklch(0.97 0 0)"
  muted-foreground: "oklch(0.556 0 0)"
  accent: "oklch(0.97 0 0)"
  accent-foreground: "oklch(0.205 0 0)"
  destructive: "oklch(0.577 0.245 27.325)"
  dark-primary: "oklch(0.922 0 0)"
  dark-primary-foreground: "oklch(0.205 0 0)"
  dark-background: "oklch(0.145 0 0)"
  dark-foreground: "oklch(0.985 0 0)"
  dark-card: "oklch(0.205 0 0)"
  dark-card-foreground: "oklch(0.985 0 0)"
  dark-popover: "oklch(0.205 0 0)"
  dark-popover-foreground: "oklch(0.985 0 0)"
  dark-secondary: "oklch(0.269 0 0)"
  dark-secondary-foreground: "oklch(0.985 0 0)"
  dark-muted: "oklch(0.269 0 0)"
  dark-muted-foreground: "oklch(0.708 0 0)"
  dark-accent: "oklch(0.269 0 0)"
  dark-accent-foreground: "oklch(0.985 0 0)"
  dark-destructive: "oklch(0.704 0.191 22.216)"
  terminal-surface: "oklch(0.18 0.01 260)"
  terminal-foreground: "oklch(0.96 0 0)"
typography:
  display:
    fontFamily: Geist Sans
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.11
    letterSpacing: -0.02em
  heading-lg:
    fontFamily: Geist Sans
    fontSize: 30px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: -0.02em
  heading-md:
    fontFamily: Geist Sans
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.33
  heading-sm:
    fontFamily: Geist Sans
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: Geist Sans
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: Geist Sans
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.43
  caption:
    fontFamily: Geist Sans
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.33
  micro:
    fontFamily: Geist Sans
    fontSize: 10px
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: 0.02em
  code:
    fontFamily: Geist Mono
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: 6px
  md: 8px
  lg: 10px
  xl: 14px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: 36px
  button-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.secondary-foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: 36px
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: 36px
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.card-foreground}"
    rounded: "{rounded.xl}"
    padding: 24px
  popover:
    backgroundColor: "{colors.popover}"
    textColor: "{colors.popover-foreground}"
    rounded: "{rounded.md}"
    padding: 16px
  muted-surface:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: 12px
  muted-label:
    backgroundColor: "{colors.background}"
    textColor: "{colors.muted-foreground}"
    typography: "{typography.caption}"
    rounded: "{rounded.sm}"
  accent-control:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
  status-error:
    backgroundColor: "{colors.background}"
    textColor: "{colors.destructive}"
    typography: "{typography.caption}"
    rounded: "{rounded.full}"
  dark-button-primary:
    backgroundColor: "{colors.dark-primary}"
    textColor: "{colors.dark-primary-foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: 36px
  dark-app-shell:
    backgroundColor: "{colors.dark-background}"
    textColor: "{colors.dark-foreground}"
  dark-card:
    backgroundColor: "{colors.dark-card}"
    textColor: "{colors.dark-card-foreground}"
    rounded: "{rounded.xl}"
    padding: 24px
  dark-popover:
    backgroundColor: "{colors.dark-popover}"
    textColor: "{colors.dark-popover-foreground}"
    rounded: "{rounded.md}"
    padding: 16px
  dark-button-secondary:
    backgroundColor: "{colors.dark-secondary}"
    textColor: "{colors.dark-secondary-foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: 36px
  dark-muted-surface:
    backgroundColor: "{colors.dark-muted}"
    textColor: "{colors.dark-muted-foreground}"
    rounded: "{rounded.md}"
    padding: 12px
  dark-accent-control:
    backgroundColor: "{colors.dark-accent}"
    textColor: "{colors.dark-accent-foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
  dark-status-error:
    backgroundColor: "{colors.dark-background}"
    textColor: "{colors.dark-destructive}"
    typography: "{typography.caption}"
    rounded: "{rounded.full}"
  terminal:
    backgroundColor: "{colors.terminal-surface}"
    textColor: "{colors.terminal-foreground}"
    typography: "{typography.code}"
    rounded: "{rounded.lg}"
---

# Cognia Design System

## Overview

Cognia is a desktop-first AI workbench shared across browser, Tauri desktop,
and Capacitor mobile. Its visual language is quiet and technical: neutral
surfaces keep chat, tools, workflows, editors, logs, and settings legible while
semantic color communicates state.

**Density is for content, not for chrome.** A log, a diff, a table, or a
terminal should pack in as much as it can carry — that is the workbench doing
its job. The frame around them is held to the opposite standard: a control
earns a permanent slot only if the user touches it in the course of ordinary
work. Everything else is one click away in a menu.

The interface should feel like a capable native productivity tool, not a
marketing site. It favors a calm default, progressive disclosure, resizable
workspaces, and clear status feedback. The default palette is intentionally
monochrome; user-selected themes and accent colors may retint the same semantic
contract at runtime.

### The chrome budget

The frame used to mount 65 controls before the user typed a character. It now
mounts 32, with per-band ceilings enforced from each band's own test file
against `lib/ui/chrome-budget.ts`. Three rules produced that, and they are the
ones to apply when adding anything to a permanent surface:

1. **One entry point per action.** The sidebar toggle once had four, the account
   button two. Duplicates are the cheapest thing to cut and cost nothing.
2. **Frequency earns permanence.** Touched every turn → it may stay inline.
   Configured once per session → it belongs in that session's settings. Set once
   and forgotten → it belongs in Views or Settings.
3. **Contextual over permanent.** A control whose subject may not exist should
   render nothing until it does — the attention panel with no pending items, the
   tab strip with one tab, the shortcut hints after the first reply.

Going over a band's ceiling is a decision for review, not a number to edit
quietly. Raise it with the reasoning for why that band earned another control.

The implemented sources of truth are `app/globals.css`, the appearance
appliers under `lib/appearance/`, and shared primitives under
`components/ui/`. This file documents their default contract for agents; it
does not replace them.

## Colors

Use semantic roles instead of literal colors in components:
`bg-background`, `bg-card`, `bg-popover`, `bg-primary`, `text-foreground`,
`text-muted-foreground`, `border-border`, and `ring-ring`.

The alpha component schema does not model border, input-outline, or focus-ring
colors. Their implemented light values are `oklch(0.922 0 0)`,
`oklch(0.922 0 0)`, and `oklch(0.708 0 0)`; dark values are
`oklch(1 0 0 / 10%)`, `oklch(1 0 0 / 15%)`, and `oklch(0.556 0 0)`.
Continue to consume them through `--border`, `--input`, and `--ring`.

The unprefixed tokens above are the default light baseline. The `dark-*`
tokens are the matching values applied by `.dark`; switch the complete set
rather than mixing light and dark surfaces. Cards and popovers are only
slightly separated from the page, so borders and restrained shadow carry
most of the hierarchy.

Reserve signal colors for meaning:

- `--success` indicates completion or healthy state:
  `oklch(0.62 0.17 145)` light, `oklch(0.72 0.18 150)` dark.
- `--warning` indicates attention, waiting, or an active in-progress state:
  `oklch(0.75 0.17 80)` light, `oklch(0.82 0.18 85)` dark.
- `--info` indicates neutral agent or system information:
  `oklch(0.6 0.13 220)` light, `oklch(0.7 0.15 220)` dark.
- `destructive` indicates failure, irreversible action, or invalid input.

Success, warning, and info hues are signal accents, not body-text colors.
Use them for icons, indicators, borders, and tinted treatments with a
separate readable foreground.

Workflow categories and charts have additional implemented tokens in
`app/globals.css`; reuse `--wf-*` and `--chart-*` rather than inventing hues.
Do not rely on hue alone: pair state color with an icon, label, pattern, or
position.

The terminal remains a dark console in both modes through
`--terminal-surface` and `--terminal-foreground`. Runtime theme presets,
custom/plugin themes, high-contrast modes, and colorblind transforms may
replace palette values while preserving these semantic roles.

## Typography

Use Geist Sans for application UI and Geist Mono for code, paths, commands,
logs, token counts, and terminal-like data. The compact end of the scale is
deliberate: `12px`, `11px`, and `10px` labels are common in dense tool
surfaces, but they should be reserved for secondary metadata and paired with
adequate contrast.

Use medium or semibold weight for labels and hierarchy. Avoid heavy display
type in normal workbench views. Long-form content and chat remain at `16px`
when space allows; control chrome generally uses the `14px` label level.
Runtime appearance settings can substitute registered font families. The
current applier also writes guarded `--line-height-scale` and
`--letter-spacing-em` variables, but shared CSS and components do not yet
consume them; do not claim that those two controls change the rendered UI
until consumers are wired.

## Layout

Build desktop views as bounded workspaces rather than scrolling documents.
The desktop shell owns the viewport and stacks a title bar, a central flex
region, optional terminal dock, and status bar. A guild rail anchors global
navigation; feature areas may add collapsible or resizable sidebars. The
shared sidebar baseline is `16rem` expanded and `3rem` icon-only.

Separate adjacent regions with a tone difference **or** a border, never both.
Shell chrome (guild rail, title bar, status bar) carries a `bg-muted/40` tone
and no border; hairline borders belong inside the content column, between the
chat header, the message list, and the composer.

Panel visibility lives in exactly one in-window place — the title bar's Views
menu — mirrored by the native View menu (`src-tauri/src/menu.rs`) and the ⌘
shortcuts. Do not add a panel toggle anywhere else; macOS suppresses the
in-window menubar, so a panel whose only entry point is a title-bar button is
one the native menu must also carry.

Use a 4px base rhythm with 8px and 12px as the dominant control gaps, 16px
for section breathing room, and 24px for card interiors or major groups.
The rendered baseline uses `36px` shared inputs and buttons. Cognia defines
comfortable density variables for a `36px` input height, `8px` row padding,
and `12px` gaps, plus compact and spacious variants, but the shared controls
still use fixed Tailwind geometry. Treat density as partially wired
scaffolding and verify actual consumers before relying on it.

On mobile, replace multi-pane layouts with bottom navigation, sheets, stacked
content, and full-width controls. Honor safe-area utilities, dynamic viewport
units, and the on-screen keyboard. Preserve task hierarchy across platforms
even when navigation chrome changes.

## Elevation & Depth

Keep elevation functional and restrained:

- Level 0: no shadow for embedded or flush regions.
- Level 1: `0 1px 2px oklch(0 0 0 / 0.08)` for cards and selected controls.
- Level 2: `0 4px 12px -2px oklch(0 0 0 / 0.12)` plus a small contact shadow
  for popovers and floating toolbars.
- Level 3: `0 12px 32px -4px oklch(0 0 0 / 0.18)` plus a contact shadow for
  dialogs and high-priority overlays.

Use `data-elevation="0"..."3"` when a surface exposes semantic elevation.
Dialogs, sheets, menus, and popovers combine border, shadow, and short
fade/zoom or slide transitions. Avoid stacking multiple strong shadows.

Wallpaper-aware surfaces may become translucent only while
`body[data-bg-enabled="true"]` is active. The implemented tonality levels are
translucent, glass, and frosted with `6px`, `10px`, and `14px` blur. Respect
`prefers-reduced-transparency`; glass is an optional context treatment, not
the default identity.

## Shapes

The base radius is `10px`, projected to `6px` small, `8px` medium, `10px`
large, and `14px` extra-large. Medium radii dominate controls and dense
containers; cards use extra-large radii; pills, avatars, status dots, and
floating action buttons use full rounding.

Use square or minimally rounded geometry for code editors, tab seams,
split-pane edges, and regions that must visually connect. Keep radius
consistent within a component family. Runtime appearance settings may scale
the base radius, so prefer shared `rounded-*` utilities and component
primitives over literal values.

## Components

Start with the shared shadcn primitives in `components/ui/` and the vendored
AI surfaces in `components/ai-elements/`. Extend variants before creating a
parallel button, input, card, dialog, tab, tooltip, or sidebar language.

- Buttons are `36px` high by default, `14px` medium, with `8px 16px` default
  padding and a visible 3px focus ring. Primary actions use the primary pair;
  secondary and ghost actions remain quiet. Destructive styling is reserved
  for destructive behavior.
- Inputs share the `36px` control height, medium radius, `4px 12px` padding,
  semantic border, and a 3px focus ring. Placeholder text uses muted
  foreground.
- Cards use a border, extra-large radius, 24px standard interior padding,
  and low elevation. Dense feature cards may reduce padding deliberately.
- Tabs use either a muted contained track or a line variant. Active state
  must remain distinguishable without color alone.
- Tool calls, agent reasoning, logs, workflow nodes, editors, and terminal
  output prioritize scanability: align status, icon, title, metadata, and
  actions consistently, then reveal detail on demand.

Honor disabled opacity, invalid-state rings, keyboard focus, touch targets,
and reduced-motion behavior supplied by the primitives.

## Do's and Don'ts

### Do

- Reuse semantic CSS variables and shared components.
- Preserve compact information hierarchy and progressive disclosure.
- Provide visible hover, active, focus, disabled, loading, success, and error
  states.
- Verify both default light and dark modes, plus narrow/mobile layouts.
- Respect the user-selected theme, font family, radius, motion, contrast,
  colorblind, wallpaper, and component-surface settings. Treat density,
  line-height, and letter-spacing controls as partial until consumers exist.
- Use short, purposeful motion and collapse it under reduced-motion settings.
- Keep desktop workspaces bounded and let the intended pane own scrolling.

### Don't

- Do not treat an optional blue, ocean, forest, or imported theme as Cognia's
  default brand palette.
- Do not hard-code arbitrary Tailwind hues when a semantic or `--wf-*` token
  exists.
- Do not turn routine workbench screens into oversized hero layouts.
- Do not apply glass, gradients, glow, or deep shadow to every surface.
- Do not encode status with color alone or remove keyboard focus indicators.
- Do not shrink primary readable content to metadata sizes.
- Do not copy desktop multi-pane chrome directly onto mobile.
