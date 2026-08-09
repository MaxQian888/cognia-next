# CLI TUI and Ink gap analysis (2026-08-09)

## Question and scope

Audit the existing `cli/src/tui` implementation for layout correctness and
proper Ink usage, compare it with mature terminal applications, and close
correctness gaps without adding new user-facing commands or workflows.

## Sources consulted

- [Ink repository and API documentation](https://github.com/vadimdemedes/ink):
  the installed Ink 7 APIs include `useBoxMetrics`, `useWindowSize`, `useCursor`,
  `<Static>`, and `useInput({isActive})`.
- [Google Gemini CLI](https://github.com/google-gemini/gemini-cli): centralized
  keypress ownership with explicit priority/handled propagation and bounded
  terminal regions.
- [Shopify CLI](https://github.com/Shopify/cli): terminal resize is treated as
  application state and width is propagated into layout decisions.
- Local ADR-0050, ADR-0052, TUI subsystem documentation, source, unit tests, and
  the PTY fixture.

## Findings

The existing TUI already had the correct high-level model: capability-gated
fullscreen/scrollback modes, deliberate alternate-screen ownership, `<Static>`
only in native scrollback mode, transcript virtualization, mouse-mode cleanup,
and responsive density tiers. Replacing those mechanisms would have increased
risk without fixing a demonstrated defect.

Five correctness gaps were confirmed:

1. `overlayRows` mixed total viewport rows with list-item rows, and several
   panels independently read the full terminal height. Small terminals could
   therefore paint more rows than their allocated region.
2. `composerRows` and `pathColumns` were calculated but unused. Multiline input
   could grow without a bound, and the virtual transcript bypassed the root's
   reactive column value.
3. `InputBuffer` moved in UTF-16 code units, allowing deletion or cursor motion
   inside surrogate pairs, combining sequences, and ZWJ emoji. The inverse
   painted cursor also provided no hardware cursor anchor for IME.
4. Independent `useInput` hooks received the same key. Guards reduced conflicts
   but did not provide deterministic ownership or handled propagation.
5. Jest mapped Ink to DOM elements and returned a constant measurement; the PTY
   fixture manually emitted marker strings instead of mounting an Ink tree.

## Adopted closure

- Measure the allocated overlay region after Yoga layout and pass explicit
  `viewportRows`, `contentRows`, and root `columns` downward.
- Window overlay lists, form/A2UI rows, ask-user options, and the composer while
  retaining their complete state and existing navigation.
- Segment editing and terminal width by Unicode grapheme clusters; anchor IME
  with Ink's `useCursor`.
- Route input through one active provider with critical, modal, global, and
  composer priorities plus handled propagation.
- Keep DOM-based component tests, and add a mandatory child-process probe that
  imports real Ink/Yoga and the production `TuiViewportFrame`, plus a real PTY
  fixture that mounts the production `App` with a deterministic agent session.

## Explicit non-goals

No screen-reader mode, Kitty keyboard protocol, new commands, new shortcuts,
incremental renderer, or overlay navigation model was added. Manual
alternate-screen ownership remains necessary because `/layout` switches modes
without restarting the process.
