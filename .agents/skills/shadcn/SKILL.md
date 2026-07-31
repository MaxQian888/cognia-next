---
name: shadcn
description: >-
  Build, compose, debug, or update Cognia UI with the local shadcn components.
  Use for components/ui, components.json, Radix composition, Tailwind styling,
  forms, dialogs, menus, registries, presets, or shadcn CLI operations.
---

# shadcn/ui in Cognia

The repository vendors its shadcn sources under `components/ui/` and configures
them through `components.json` (`new-york`, RSC, Tailwind 4, Lucide, `@/`
aliases). The installed component list in `AGENTS.md` and the live directory are
the source of truth.

## Workflow

1. **Reuse an installed component.** Search `components/ui/` and existing
   feature compositions before writing custom markup. Do not run `shadcn add`
   for an installed component.
2. **Read the local API.** Vendored source may differ from upstream. Inspect the
   component exports and a sibling consumer, then load only the applicable rule
   reference below.
3. **Compose at the feature layer.** Keep reusable primitives in
   `components/ui/`; product state, data fetching, translations, and domain
   behavior live under `components/<feature>/`.
4. **Use project conventions.** Semantic color tokens, `cn()`, `gap-*`,
   accessible titles/names, Lucide icons, and the smallest `"use client"`
   boundary. Use `next-intl` for every user-facing string.
5. **Test ownership correctly.** Do not add tests inside `components/ui/`.
   New or edited first-party wrappers require co-located RTL tests.
6. **Verify.** Run the changed tests, `rtk pnpm typecheck`, `rtk pnpm lint`,
   and `rtk pnpm lint:i18n`.

## Missing or upstream components

Only use the CLI when the requested component is genuinely absent or the user
explicitly asks for an upstream update. Inspect current commands with
`rtk pnpm dlx shadcn@latest --help`; use `info`, `docs`, `view`, `--dry-run`, and
`--diff` before writing. Preserve local modifications and require explicit
approval before any overwrite or preset reinstall.

For third-party registries, confirm the registry with the user, inspect every
added file, rewrite imports to the aliases in `components.json`, and keep
product code outside `components/ui/` where practical.

## Reference routing

- forms and validation: `rules/forms.md`
- component composition/accessibility: `rules/composition.md`
- semantic styling and layout: `rules/styling.md`
- icon conventions: `rules/icons.md`
- Radix versus Base APIs: `rules/base-vs-radix.md`
- CLI flags and registry behavior: `cli.md`
- theme customization: `customization.md`

Load the narrowest reference needed. The local component source overrides a
generic example when they disagree.
