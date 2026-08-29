---
title: ADR-0039 — Integrated terminal Phase 4 — Copilot-style AI autocomplete, script-type runner, plugin completion providers
description: "Phase 4 turns the integrated terminal (ADR-0031/0033) into an assisted dev terminal. (1) A GitHub-Copilot-style inline autocomplete: as you type at a shell prompt, a debounced suggestion is shown as dim ghost text after the cursor; Tab/→ accepts (writing the suffix into the PTY — never auto-running), Esc dismisses. The engine is renderer-pure (line-buffer model, provider registry, ranking, prompt builder) with a built-in offline history provider and a built-in LLM provider gated by an opt-in setting + a PII redaction gate. (2) A script-type runner maps a file's extension/shebang to the right interpreter (.sh→bash, .ps1→pwsh -File, .py→python3, …). (3) All of it is exposed to plugins: ctx.terminal gains registerCompletionProvider / runScript / detectScriptType, a new terminal:completion permission, and a manifest terminalCompletionProviders lazy bridge wired into the module-bridge dispatch."
---

# ADR-0039 — Integrated terminal Phase 4

**Status**: Accepted (2026-06-01)
**Authors**: Max Qian + Claude Opus 4.8
**Supersedes**: extends ADR-0031 + ADR-0033 (does not replace them); realises ADR-0033 follow-up #4 ("AI command assistance — designed, not built")
**Affects**: `lib/terminal/completion/`, `lib/terminal/script-runner.ts`, `lib/terminal/shell-detect.ts`, `hooks/terminal/`, `components/terminal/terminal-instance.tsx`, `components/terminal/terminal-ghost-text.tsx`, `components/settings/terminal/terminal-card.tsx`, `lib/plugin/api/terminal-api.ts`, `lib/plugin/bridge/terminal-completion-bridge.ts`, `lib/plugin/contracts/module-bridge-map.ts`, `lib/plugin/core/validation.ts`, `lib/plugin/security/permission-guard.ts`, `types/plugin/plugin.ts`, `types/plugin/plugin-terminal-completion.ts`, `lib/claude/types.ts`, `crates/cognia-cli/src/cmd_lint.rs`, `i18n/messages/{en,zh-CN}.json`

## Current state amendment (2026-08-13)

Inline explain/fix is shipped. Mobile autocomplete remains dependent on the canonical OSC 633 cwd/command event stream from ADR-0031; it will reuse the current completion engine rather than create a mobile-only engine.

## Context

ADR-0031/0033 shipped a complete integrated terminal (xterm.js dock, `portable-pty` backend, OSC 633 markers, mobile WS transport, split panes, command navigation, reload-restore, link-to-editor) plus a committed wave of shell-feature polish (shell picker, launch profiles, color schemes, render options, UTF-8 codepage fix). Two gaps remained:

1. **No command assistance.** ADR-0033 follow-up #4 explicitly deferred "AI command assistance in the dock (explain error / suggest fix)".
2. **No script-type awareness.** Running a script file meant the user had to spell out the interpreter; the terminal only knew shell *binaries*, not *script types*.

And the cross-cutting project rule is that terminal capabilities must be exposed to plugins (`ctx.terminal` already had `spawn/write/kill/onData/readRecent/list`).

This phase delivers a GitHub-Copilot-style inline autocomplete, a script-type runner, and the plugin surface for both — with privacy and permission rigor.

## Decisions

### D1 — Renderer-pure completion engine (`lib/terminal/completion/`)

Every piece of the suggestion pipeline that can be is kept free of React + xterm, so the fiddly parts are unit-tested in isolation:

- **`line-buffer.ts`** — a best-effort model of the *current input line* built purely from the keystroke stream xterm's `onData` emits. The real line editing happens in the shell (readline/PSReadLine) and is echoed back as *output* we can't reliably read, so we track a parallel model: printable runs insert at the cursor; backspace / Ctrl-U/K/W edit; arrows move; Enter/Ctrl-C reset. Crucially, any input we *can't* model — history recall (↑/↓), shell tab-completion, reverse-search, bracketed paste — flips the line to `tracked: false`, and suggestions are suppressed until the next prompt boundary. This is the safety valve that keeps a stale ghost from ever overwriting the wrong thing.
- **`prompt.ts`** — pure prompt builder (shell, platform, cwd, recent commands, partial input) + `sanitizeCompletion` that strips fences/backticks/prompt-echo, takes the first line, and guarantees the result extends the input. `ghostSuffix` computes the dim text shown after the cursor.
- **`registry.ts`** — a module-level provider registry (mirrors `extension-api`). `getCompletions` fans the context out to all providers concurrently behind a per-provider timeout + error isolation, then merges, dedupes by text, and ranks `plugin > ai > history`, then by score.
- **`history-provider.ts`** — built-in, offline, always-available: prefix-matches the session's recent command history. This is the graceful-degradation path when no model is configured.
- **`ai-provider.ts`** — built-in LLM provider (the Copilot brain). Builds the prompt, **PII-gates** the assembled context with `hasNoLeakingPii` before any model call, memoises by `(shell, cwd, input)` with a short TTL (incl. negative caching), and discards the result if the caller's signal aborted.
- **`controller.ts`** — the React-free orchestration brain: consumes keystrokes, debounces the query, keeps a still-valid suggestion across typing (no re-query while the suffix still matches), guards against stale async results, and exposes `accept()` (returns the suffix to write — it never auto-submits) / `dismiss()` / `reset()` / `getView()`.
- **`builtins.ts`** — registers the two host providers once (idempotent), each gated by the `source` setting read lazily so changes apply live, plus `buildAutocompleteContext` (store row + input → context).

### D2 — React glue is intentionally thin

`hooks/terminal/use-terminal-autocomplete.ts` wires the controller to the settings + terminal stores and the LLM utility client (`buildUtilityLlmClient`), and registers the built-ins. `components/terminal/terminal-ghost-text.tsx` is a purely presentational overlay (`pointer-events: none`, inherits the terminal font) positioned at the xterm cursor. `terminal-instance.tsx` feeds `onData` chunks into the hook, renders the overlay, intercepts **Tab / → to accept** and **Esc to dismiss** in `attachCustomKeyEventHandler` (falling through when there's no suggestion, so Tab still reaches the shell and → still moves the cursor), and resets the line model on OSC 633 `prompt_start` / `command_start`.

Accepting writes the suffix straight through `session.write` — *not* through `onData` — so there's no double-feed, and it never presses Enter for the user.

### D3 — Privacy + permission rigor

- The AI source is **opt-in** (`terminal.autocomplete.enabled` defaults off) with a `source` of `history | ai | both` (default `both`). History-only is fully offline.
- Before any model call the assembled context (partial command + cwd + recent history) runs through the shared `hasNoLeakingPii` gate; a detected API key / token / credential / email / card silently skips the request — terminal context never leaks to the model.
- When no model is configured `buildUtilityLlmClient` returns null and the AI provider degrades to nothing (history still works).
- Acceptance only fills the line; the user still presses Enter. No auto-execution.

### D4 — Script-type runner (`lib/terminal/script-runner.ts`)

`detectScriptType(path, { shebang, platform })` maps a file to `{ kind, interpreter, interpreterArgs }`: a `#!` shebang (parsed, incl. `/usr/bin/env prog`) wins, else the extension (`.sh`→bash, `.ps1`→`pwsh -NoLogo -File`, `.py`→`python3`/`python`, `.js`→node, `.ts`→tsx, `.rb`/`.pl`/`.php`/`.lua`/`.nu`/`.R`, `.bat`/`.cmd`→`cmd /c`). `buildScriptSpawnRequest` turns that into a `SpawnRequest` the dock can spawn. A new renderer-side `ShellKind` + `detectShellKind` mirror the Rust `ShellKind::from_shell_path` so shell-aware features agree on both sides.

### D5 — Full plugin exposure

- **`ctx.terminal`** (`lib/plugin/api/terminal-api.ts`) gains `registerCompletionProvider` (gated `terminal:completion`), `runScript` + `detectScriptType` (gated `terminal:spawn`), reusing the same ownership-checked dock primitives.
- **New permission `terminal:completion`** — non-dangerous (it contributes suggestions and reads the in-progress input line; sensitive but not destructive, like `git:read`). Added to the union, `PERMISSION_GROUPS`, `PERMISSION_DESCRIPTIONS`, `validation.ts`'s `VALID_PERMISSIONS`, and the Rust `cognia plugin lint` whitelist.
- **Manifest `terminalCompletionProviders`** — lazy `{ id, label, entry, export, priority }` factories, resolved by `lib/plugin/bridge/terminal-completion-bridge.ts` (modeled on `ai-providers-bridge`) and wired into the `MODULE_BRIDGE_CAPABILITIES` dispatch so it actually fires on enable/disable. The bridge's adapter + `registerPluginCompletionProvider` back both the declarative and the imperative (`ctx.terminal.registerCompletionProvider`) paths, so plugin providers are cleaned up together on teardown.

### D6 — Settings + i18n

`AppSettings.terminal.autocomplete` (`{ enabled, source, debounceMs }`) drives an "AI command autocomplete" group in the terminal settings card (toggle + source select + debounce + a privacy note explaining exactly what is sent to the model). New i18n keys land in both `en.json` and `zh-CN.json` (`terminal.ghost.acceptHint`, `settings.terminal.autocomplete.*`); `pnpm lint:i18n` confirms parity.

## Test coverage

Per-file co-located tests (CLAUDE.md rule #3, ≥90% on new code):

- Engine: `line-buffer` (29), `prompt` (18), `registry` (12), `history-provider` (6), `ai-provider` (8), `controller` (10), `builtins` (4).
- Script: `script-runner` (24) + `shell-detect` (`detectShellKind`).
- Plugin: `terminal-api` (extended — runScript/detectScriptType/registerCompletionProvider), `terminal-completion-bridge` (12), `module-bridge-map` (count lock 11→12), `permission-guard` / `validation` (terminal:completion).
- React: `terminal-ghost-text` (4), `use-terminal-autocomplete` (4), `terminal-instance` (extended — 7 autocomplete-integration tests), `terminal-card` (extended — 3 autocomplete tests).

All green; `pnpm lint:i18n` green. The only `tsc` errors in the tree are pre-existing, in unrelated concurrent work (`perf-api`/`connectors-api`).

## File summary

**Net-new**: `lib/terminal/completion/{types,line-buffer,prompt,registry,history-provider,ai-provider,controller,builtins}.ts` (+tests), `lib/terminal/script-runner.ts` (+test), `hooks/terminal/use-terminal-autocomplete.ts` (+test), `components/terminal/terminal-ghost-text.tsx` (+test), `lib/plugin/bridge/terminal-completion-bridge.ts` (+test), `types/plugin/plugin-terminal-completion.ts`, this ADR (en + zh).

**Extended**: `lib/terminal/shell-detect.ts` (+`ShellKind`/`detectShellKind`), `components/terminal/terminal-instance.tsx`, `components/settings/terminal/terminal-card.tsx`, `lib/plugin/api/terminal-api.ts`, `lib/plugin/contracts/module-bridge-map.ts`, `lib/plugin/core/validation.ts`, `lib/plugin/security/permission-guard.ts`, `types/plugin/plugin.ts`, `lib/claude/types.ts`, `crates/cognia-cli/src/cmd_lint.rs`, both i18n message files.

## Amendment (2026-08-28) — the composer's `!` line

`!` mode in the chat composer (`components/chat/composer.tsx`) is a shell
prompt that had none of the above. It had a `textarea`, an echo of the line
you typed, and `shell_exec`. This amendment gives it completion, validation,
and an honest answer about whether the line can run at all — reusing the
Phase-4 engine's DATA and replacing only the parts that assumed a PTY.

### D7 — One intelligence layer, in `lib/shell-intelligence/`

The composer is not a terminal: it has no PTY, no OSC 633 stream, no line
buffer, and its "line" is a slice of a `textarea` that also holds `/commands`
and `@mentions`. So the Phase-4 `controller` / `line-buffer` do not apply. What
does apply is everything underneath them — `shell-builtins`, the `spec/` CLI
set, `terminal_complete_paths`, `terminal_list_path_executables` — and those are
reused verbatim.

What is new is the part Phase 4 never needed: **position**. The ghost-text
providers all assume the head word is token 0, which is true at a prompt and
false the moment a line has a pipe in it. `lex.ts` + `segments.ts` add an
operator-aware lexer (`|`, `&&`, `||`, `;`, `&`, redirects with fd prefixes,
`$(…)`, backticks, subshells, env assignments) and a segmenter that answers one
question: *what is the token under the cursor, and what role does it play in its
own command?* `cat foo | gre` completes `grep`, not a file for `cat`.

Deliberately not a shell grammar: no parse tree, no expansion, no evaluation.
Anything it cannot classify degrades to a plain word, which costs a suggestion,
never a wrong execution.

### D8 — The Host is the capability boundary, and it is stated, not hidden

Three states, because collapsing them is what makes a feature look broken:

| State | Completion | Execution |
| --- | --- | --- |
| `full` — a Host is reachable | builtins, CLI specs, `$PATH`, filesystem | yes |
| `static-only` — no Host | builtins, CLI specs | no, and the panel says why |
| `shell-unavailable` — Host present, shell absent | everything except execution | no |

A standalone browser keeps `git`/`kubectl`/flag completion, because those are
static data, and is told to connect a Host rather than being shown an empty
panel. `terminal_list_path_executables` is promoted from a client-local Tauri
command to a companion RPC (`READ_ONLY` + control-gated, exactly like
`terminal_complete_paths` — it reports the host's installed executables, and
only a client that can already RUN them has any use for it).

### D9 — The shell is the user's, and its argv lives in one place

Precedence: `terminal.defaultShell` → the Host's reported default → the platform
guess. A configured shell the Host does not have surfaces as `shell-unavailable`
with execution disabled, rather than silently running under a different shell.

`shell-argv.ts` is the single place that knows how to hand a line to a shell —
`-lc` for sh/bash/zsh, `-l -c` for fish (which rejects the bundled form),
`--login -c` for nu, `-NoLogo -Command` for both PowerShells, `/D /S /C` for
cmd — and an unknown family is reported `unsupported`, never guessed at.

This is why execution moves off `shell_exec` (desktop-only, hard-coded
`sh -c` / `cmd /C`) and onto the transport-routed `terminal_exec`: it is the
only way `terminal.defaultShell` can mean anything, and it is what lets a
paired browser or phone run a `!` line at all. `shell_exec`'s 64 KB output cap
and 30 s default timeout are re-applied in `execute.ts`, because `terminal_exec`
has neither.

### D10 — Diagnostics are advisory, and timing is the hard part

`command-not-found`, `incomplete-syntax` and `shell-unavailable` underline; none
of them blocks Enter. The user's shell is the authority, and an underline that
blocked execution would make the one command the checker is wrong about
unrunnable.

Detection is easy; TIMING is the design. `k` on the way to `kubectl` is not an
error. A command is judged only once it is COMMITTED — by whitespace, an
operator, or Enter — or, failing that, once the input has been idle for 200 ms
AND is at least two characters long. A name whose host lookup has not returned
is `pending`, which is not `unknown`: an unanswered probe must not underline
every command for as long as it takes.

### D11 — No live PTY state, deliberately

V1 shares the selected Host, the effective cwd, the configured shell and the
Host's `$PATH`. It does NOT inspect aliases, functions, exports, or `cd`s inside
an already-running PTY — there is no PTY here to inspect. A command that only
exists as a shell alias therefore reads as unknown; that is the honest cost of
the boundary, and it is why the diagnostic is advisory rather than a gate.

Also out of scope for V1, and unchanged from the Phase-4 non-goals: CodeMirror,
tree-sitter, dynamic zsh/fish completion sidecars, downloaded third-party
completion specs, and AI completion on this surface.

### Composer surface notes

The `textarea` stays the only input state. Up/Down move the highlight, Tab
accepts, Escape closes, Enter still runs the line — and none of those fire
during an IME composition. Candidates ride the existing `ComposerPopover` item
model (a new `shell` kind), so keyboard navigation, scroll-into-view and the
pick path are the ones every other picker already uses. Diagnostics are painted
by a third overlay layer sharing the `TEXTAREA_TYPOGRAPHY` + `padEndClass` +
scroll-mirror contract with the chip and ghost layers, with a polite
`role="status"` region carrying the same messages for assistive tech.

`terminal.autocomplete.enabled` is the master switch for both surfaces: with it
off, `!` mode behaves exactly as it did before this amendment.

**Affects (amendment)**: `lib/shell-intelligence/*`, `hooks/chat/use-shell-intelligence.ts`,
`components/chat/composer/{shell-completion-row,shell-diagnostic-overlay,composer-box}.tsx`,
`components/chat/{composer,composer-popover}.tsx`, `lib/terminal/remote-api.ts`,
`lib/terminal/completion/path-provider.ts`, `src-tauri/src/companion_api/rpc{,/terminal}.rs`,
`protocol/companion-{commands,request-schemas,response-schemas}.json`,
`protocol/headless-command-dispositions.json`, `i18n/messages/{en,zh-CN}/chat.json`.

## Follow-ups explicitly scoped out

1. **Ghost-text pixel alignment** — `cursorPixelPosition` reads xterm's (internal) render-service cell dimensions; in the DOM renderer or before first paint it returns null and the overlay is simply not shown. A public-API measurement path would harden this.
2. **Inline error-explain / fix** — the other half of ADR-0033 #4 (explain a failed command, suggest a fix) is a natural next provider but not built here.
3. **Mobile autocomplete** — the WS transport doesn't deliver OSC 633 today (ADR-0031 #2), and on-screen keyboards make ghost text less useful; deferred.
4. **More script types / shells** — elvish, tcsh, xonsh, etc. are one mapping entry (and, for OSC 633, one Rust shell-integration script) each.
