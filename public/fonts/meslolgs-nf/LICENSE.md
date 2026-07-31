# MesloLGS NF — bundled terminal font

`MesloLGS-NF-Regular.woff2` and `MesloLGS-NF-Bold.woff2` are the
Powerlevel10k-recommended **MesloLGS NF** font (Meslo LG S, Nerd-Font-patched),
bundled so the integrated terminal renders Powerline / Nerd-Font prompt glyphs
without the user having to install a font. The `@font-face` rules in
`app/globals.css` prefer a locally-installed copy via `local("MesloLGS NF")`;
these files are only fetched on machines that don't already have it.

## Provenance & license

- **Meslo LG** — customized Menlo derivative by André Berg.
  Licensed under the **Apache License 2.0**.
  Source: https://github.com/andreberg/Meslo-Font
- **Nerd Fonts patch** — glyph patching by Ryan L McIntyre / the Nerd Fonts
  project. Nerd Fonts tooling is **MIT**; patched fonts retain their upstream
  license (Apache 2.0 here).
  Source: https://github.com/ryanoasis/nerd-fonts (`Meslo` patched set)

The `.woff2` files here were produced by compressing the upstream
`MesloLGS NF Regular.ttf` / `MesloLGS NF Bold.ttf` with `fonttools` (no glyph
subsetting; the full Nerd-Font icon set is preserved).

A copy of the Apache License 2.0 governing Meslo LG is available at
https://www.apache.org/licenses/LICENSE-2.0
