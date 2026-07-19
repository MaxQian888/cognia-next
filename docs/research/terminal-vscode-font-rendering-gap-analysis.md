# Integrated terminal font and rendering gap analysis

**Date:** 2026-07-18  
**Scope:** Cognia integrated terminal versus current Visual Studio Code terminal appearance behavior, constrained to APIs available in Cognia's installed `@xterm/xterm` 5.5.0 stack.

## Sources and method

This comparison uses primary sources only:

- [VS Code terminal appearance documentation](https://code.visualstudio.com/docs/terminal/appearance)
- [VS Code terminal basics documentation](https://code.visualstudio.com/docs/terminal/basics)
- [VS Code terminal configuration schema](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/common/terminalConfiguration.ts)
- [VS Code xterm integration](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/browser/xterm/xtermTerminal.ts)
- [xterm.js `ITerminalOptions` API](https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/)
- The installed 5.5.0 declarations under `node_modules/@xterm/xterm/typings/xterm.d.ts` and compatible renderer addon declarations.

The local audit covered `components/terminal/terminal-instance.tsx`, `components/settings/terminal/terminal-card.tsx`, the `AppSettings.terminal` contract, their co-located tests, and ADR-0031/ADR-0033. No new renderer abstraction is needed: the existing settings store and xterm live-options effect are the correct extension points.

## Existing parity

Cognia already implements the main VS Code text-style controls: CSS font-family stacks, font size, normal/bold weight, line height, letter spacing, ligatures, cursor style/blink, ANSI color schemes, minimum contrast, scroll sensitivity, and renderer selection. It also goes beyond the basic VS Code settings surface by bundling MesloLGS NF, waiting for the CSS Font Loading API, clearing the accelerated glyph atlas after font changes, and falling back WebGL → Canvas → DOM.

## Gap matrix

| Capability                     | VS Code / xterm behavior                                                                                                                                                              | Cognia before this pass                                                                                                                                      | Decision                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Custom glyph rendering         | Enabled by default. GPU renderers draw box, block, braille, Powerline, progress, git-branch, and legacy-computing ranges for continuous, cell-filling output.                         | xterm default applied implicitly, with no persisted control or discoverability.                                                                              | Add `customGlyphs`, default `true`, live-applied.                                               |
| Overlapping glyph rescale      | VS Code defaults to `true`; xterm 5.5 rescales ambiguous-width single-cell glyphs to avoid overlap and improve GB18030 behavior. Emoji, Powerline, and Nerd Font glyphs are excluded. | xterm 5.5 defaulted to `false`, so Cognia differed from current VS Code and could show overlapping Roman numeral/CJK fallback glyphs.                        | Add `rescaleOverlappingGlyphs`, default `true`, live-applied.                                   |
| Bold ANSI color mapping        | VS Code and xterm default to using bright ANSI variants for bold text.                                                                                                                | Implicit xterm default only.                                                                                                                                 | Add `drawBoldTextInBrightColors`, default `true`, live-applied.                                 |
| Smooth scrolling               | VS Code exposes a boolean, default `false`, and maps enabled physical-wheel scrolling to xterm's 125 ms animation.                                                                    | No setting; xterm duration stayed `0`.                                                                                                                       | Add `smoothScrolling`, default `false`, mapped to `125`/`0` ms and live-applied.                |
| Runtime WebGL context loss     | VS Code subscribes to the WebGL addon's context-loss event and disposes the failed renderer so the terminal remains usable.                                                           | Startup failures fell back WebGL → Canvas → DOM, but a context lost after startup had no recovery handler.                                                   | Dispose failed WebGL and load Canvas; DOM remains the fallback if Canvas fails.                 |
| Cursor width                   | VS Code exposes pixel width when the active cursor style is `line`; xterm calls the corresponding style `bar`.                                                                        | Bar cursor always used xterm's default width.                                                                                                                | Add `cursorWidth`, default `1`, range 1–10 px, live-applied.                                    |
| Inactive cursor style          | VS Code exposes outline/block/line/underline/none for an unfocused terminal.                                                                                                          | xterm's implicit `outline` default only.                                                                                                                     | Add `cursorInactiveStyle`, default `outline`, live-applied.                                     |
| Fine-grained ligature features | Current VS Code can specify font-feature settings and fallback ligature sequences.                                                                                                    | Cognia exposes only an enable switch. Installed xterm 5.5's ligature addon supports fallback sequences but not VS Code's full current feature-settings path. | Defer until the xterm 6 upgrade; avoid a partial UI that promises unsupported shaping controls. |
| Image protocols                | Current VS Code supports Sixel/iTerm/Kitty through a separate image addon and transparency path.                                                                                      | Addon not installed; reload restoration has protocol-specific constraints.                                                                                   | Treat as a separate terminal-media feature, not a font/rendering toggle.                        |

## Implementation contract

The selected settings are persisted under `AppSettings.terminal`, edited through the existing terminal settings card, passed into the xterm constructor, and mutated through `term.options` when they change. None require a terminal or PTY remount. Renderer-specific options remain visible when DOM is selected but explain that their effect requires Canvas/WebGL; preserving them allows a user to switch renderers without losing preferences.

The test seams are:

1. The settings card persists each user-visible choice through `save({ terminal: ... })`.
2. `TerminalInstance` maps persisted values to the public xterm constructor/options contract and applies changes live without a refit when cell metrics are unchanged.

## Follow-up opportunities

- Upgrade the xterm family as one coordinated dependency change, then evaluate detailed ligature feature settings, the newer scrollbar API, grapheme clusters, synchronized output, and image protocols.
- Add a renderer diagnostics surface if real-device telemetry shows recurring WebGL context loss; the terminal now recovers automatically, while diagnostics would make the downgrade visible.
- Consider terminal screen-reader mode and an accessible buffer as a dedicated accessibility project, since that requires interaction design beyond a render option.
