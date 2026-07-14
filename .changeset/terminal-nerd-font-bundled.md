---
"cognia-next": patch
---

Fix the integrated terminal rendering Powerline / Nerd-Font prompts (oh-my-posh, powerlevel10k) as tofu boxes with wrongly-spaced characters. The app now bundles the Powerlevel10k-recommended **MesloLGS NF** font (loaded via `local()` first, so machines that already have it installed never download the bundled copy) and defaults the terminal to it, so prompt glyphs render out of the box without the user installing anything. Separately, the terminal now rebuilds the WebGL/Canvas glyph atlas once the configured font finishes loading — on first open and whenever the font changes in settings — which fixes the "every character is spaced one cell too wide" artifact caused by measuring the cell size against a fallback font before the real one was ready.
