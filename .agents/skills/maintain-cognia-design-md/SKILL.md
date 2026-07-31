---
name: maintain-cognia-design-md
description: Create, audit, or refresh Cognia's root DESIGN.md using the current Google Labs DESIGN.md specification and the repository's implemented UI as evidence. Use when asked to write designmd/DESIGN.md, document Cognia's visual system for coding agents, reconcile design tokens with app/globals.css, or validate that design guidance still matches the current desktop, web, and mobile UI.
---

# Maintain Cognia DESIGN.md

Produce an agent-readable visual contract without turning `DESIGN.md` into a
second styling source of truth. Treat the implementation as canonical and the
document as a checked projection of it.

## 1. Establish scope and safety

1. Resolve the repository root and target `<repo>/DESIGN.md`.
2. Inspect `git status` before editing. Preserve unrelated user or agent work.
3. Read [references/cognia-source-map.md](references/cognia-source-map.md).
4. Create `DESIGN.md` only at the repository root. Update it in place when it
   already exists.

## 2. Refresh the upstream contract

DESIGN.md is alpha and changes frequently. Verify the current release and
specification on every connected run:

```bash
rtk npm view @google/design.md version
rtk npx -p @google/design.md@latest designmd spec --rules
```

Prefer these primary sources:

- `https://github.com/google-labs-code/design.md`
- `https://github.com/google-labs-code/design.md/blob/main/docs/spec.md`
- the installed `@google/design.md` CLI output

If the packaged `spec` command fails because its published bundle is missing
`dist/spec.md`, read the official `docs/spec.md` at the release tag or `main`
and continue. Treat that as an upstream packaging issue, not a repository
failure.

Use [references/spec-baseline.md](references/spec-baseline.md) only when
network/package access is unavailable. State that limitation in the handoff.
Do not rely on community templates when they conflict with the official spec.

## 3. Audit the implemented design

Read the files in the source map before writing. Search `lib/`, `components/`,
`hooks/`, `src-tauri/`, and relevant ADRs as required by repository policy.

Apply this evidence order:

1. Runtime CSS variables and appliers
2. Shared UI primitives and shell components
3. Appearance types, theme resolution, and accessibility transforms
4. Tests that assert values or behavior
5. ADR rationale and product prose

Record only values that exist in code. Distinguish:

- **Default baseline:** the light and dark values actually rendered with no
  user customization. These are the normative DESIGN.md tokens.
- **Runtime variants:** presets, imported/custom/plugin themes, accent
  overrides, density, typography, radius, wallpaper, and accessibility
  transforms. Describe their constraints in prose; do not promote one optional
  preset into the brand baseline.
- **Special surfaces:** terminal, workflow categories, charts, overlays, and
  mobile safe areas. Include them only when they materially guide UI work.

If sources disagree, trace the runtime cascade and document the winner. Never
silently choose the friendlier-looking value.

For every runtime knob described as functional, search for both its writer and
its consumer. A CSS variable that is only declared or written is scaffolding,
not implemented behavior. Describe partial wiring explicitly.

## 4. Author the file

Follow the current upstream schema. Unless the refreshed spec says otherwise:

- Put machine-readable tokens in YAML frontmatter.
- Use supported top-level groups only: `version`, `name`, `description`,
  `colors`, `typography`, `rounded`, `spacing`, and `components`.
- Keep exact CSS values. DESIGN.md supports `oklch()`; do not round or convert
  values merely for aesthetics.
- Use `{path.to.token}` references for component tokens.
- Restrict component properties to the current schema.
- Keep `padding` to one Dimension. Describe asymmetric CSS padding in prose;
  do not put a CSS shorthand into the alpha `padding` field.
- Write Markdown sections as `##` headings in canonical order:
  Overview, Colors, Typography, Layout, Elevation & Depth, Shapes, Components,
  Do's and Don'ts.
- Explain intent and exceptions in prose; do not duplicate every token as
  prose.

Keep the default light palette under unprefixed semantic names such as
`primary` and `background`. Store the implemented dark baseline under
`dark-*` names and explain that `.dark` switches the entire semantic set.
This preserves the required `primary` token while representing both real
variants in the alpha flat color map.

Make guidance operational. Name the classes, CSS variables, `data-*`
attributes, or shared primitives an agent should reuse. Avoid aspirational
brand claims that cannot be traced to the repository.

## 5. Validate and reconcile

Run:

```bash
rtk npx -p @google/design.md@latest designmd lint DESIGN.md
```

Require:

- zero parser or schema errors;
- zero broken token references;
- canonical section order;
- no fabricated values;
- a real implementation consumer for every documented runtime control;
- every component color pair to meet the current configured contrast rule.

Review warnings individually. Fix actionable warnings. An `orphaned-tokens`
warning may remain when a real semantic token has no honest component mapping;
do not invent a fake component solely to silence it. Report retained warnings
and their reason.

Then diff every documented token against its source files and run formatting
checks applicable to Markdown. Finish with `rtk git diff -- DESIGN.md
.agents/skills/maintain-cognia-design-md` and `rtk git status --short`.

## 6. Maintain without drift

When updating an existing file:

1. Re-audit sources before preserving old values.
2. Use the official CLI `diff` command when token changes are substantial.
3. Keep intentional rationale that remains true.
4. Remove guidance only when the implementing behavior is gone.
5. Cite source paths inside DESIGN.md where they help future agents verify the
   contract; avoid line numbers because they drift.
