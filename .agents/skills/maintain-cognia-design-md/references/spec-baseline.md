# DESIGN.md specification baseline

Last verified: 2026-07-25  
Official package release: `@google/design.md` 0.3.0  
Format version: `alpha`

Use this file only when the official repository and package registry cannot be
reached. Refresh from the primary sources before trusting it on a connected
run.

## File model

A DESIGN.md file combines:

1. optional YAML frontmatter containing normative machine-readable tokens; and
2. Markdown prose containing rationale and application guidance.

The frontmatter begins and ends with a line containing exactly `---`.

Supported top-level token groups at this baseline:

```yaml
version: alpha
name: Product name
description: Optional description
colors:
  primary: "#000000"
typography:
  body:
    fontFamily: Example Sans
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0em
rounded:
  md: 8px
spacing:
  md: 12px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#ffffff"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: 12px
    height: 36px
```

Typography properties are `fontFamily`, `fontSize`, `fontWeight`,
`lineHeight`, `letterSpacing`, `fontFeature`, and `fontVariation`. Dimensions
use `px`, `em`, or `rem`. Component properties at this baseline are
`backgroundColor`, `textColor`, `typography`, `rounded`, `padding`, `size`,
`height`, and `width`. `padding` is one Dimension, not a multi-value CSS
shorthand.

Token references use `{path.to.token}`. A component may reference a composite
typography token.

## Canonical section order

1. `## Overview` (alias: Brand & Style)
2. `## Colors`
3. `## Typography`
4. `## Layout` (alias: Layout & Spacing)
5. `## Elevation & Depth` (alias: Elevation)
6. `## Shapes`
7. `## Components`
8. `## Do's and Don'ts`

Unknown headings are preserved. Duplicate section headings are rejected.

## Validation baseline

Use:

```bash
rtk npx -p @google/design.md@latest designmd lint DESIGN.md
```

The 0.3.0 linter checks broken references, the presence of `primary`,
component contrast, orphaned colors, token summaries, optional sections,
typography presence, canonical section order, and likely misspelled top-level
keys. The format remains alpha; CLI output overrides this snapshot.

## Primary sources

- https://github.com/google-labs-code/design.md
- https://github.com/google-labs-code/design.md/blob/main/docs/spec.md
- https://www.npmjs.com/package/@google/design.md
