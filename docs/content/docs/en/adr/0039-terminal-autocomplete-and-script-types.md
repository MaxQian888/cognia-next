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

## Follow-ups explicitly scoped out

1. **Ghost-text pixel alignment** — `cursorPixelPosition` reads xterm's (internal) render-service cell dimensions; in the DOM renderer or before first paint it returns null and the overlay is simply not shown. A public-API measurement path would harden this.
2. **Inline error-explain / fix** — the other half of ADR-0033 #4 (explain a failed command, suggest a fix) is a natural next provider but not built here.
3. **Mobile autocomplete** — the WS transport doesn't deliver OSC 633 today (ADR-0031 #2), and on-screen keyboards make ghost text less useful; deferred.
4. **More script types / shells** — elvish, tcsh, xonsh, etc. are one mapping entry (and, for OSC 633, one Rust shell-integration script) each.
