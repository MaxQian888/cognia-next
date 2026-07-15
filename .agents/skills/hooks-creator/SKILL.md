---
name: hooks-creator
description: >-
  Author a new lifecycle Hook for cognia — either a product-bundled built-in
  command-hook script (System B, settings.json) or a plugin hook (System A,
  TS @hook / Python decorator). Make sure to use this skill whenever the user
  wants to add, scaffold, wire, or test a hook that fires on an agent lifecycle
  event (PreToolUse, PostToolUse, UserPromptSubmit, SessionStart/End, Stop,
  PreCompact, InstructionsLoaded, …), gate/deny a tool or prompt, inject context
  into a turn, or "make cognia do X automatically before/after the agent runs".
  Covers built-in hook scripts under hooks/builtin/, the lib/Codex/hooks/
  registry, the CLI + Rust runners, and the plugin hook SDK. Use it even when the
  user only says "add a hook", "block edits to X", "auto-load context", or
  "run a check before every tool call" without naming the hook system.
---

# Hooks Creator

cognia has **two** hook systems. Pick the right one first — they have different
contracts, runtimes, and audiences.

| | **System B — built-in / settings.json hooks** | **System A — plugin hooks** |
|---|---|---|
| What | External command/webhook scripts fired by the Rust + CLI runtime | In-process JS/Python callbacks dispatched to loaded plugins |
| Author as | A self-contained `*.mjs` script + a registry entry (or a user `settings.json` entry) | A `@hook("event")` handler in a plugin's TS/Python entry |
| Can block? | Yes — `PreToolUse` / `UserPromptSubmit` (non-zero exit / `permissionDecision: deny`) | Depends on the hook (pipeline hooks transform; observers don't) |
| Runs in | Desktop (Rust) + CLI (Node). Web/mobile: command hooks no-op | Anywhere the plugin is loaded |
| Best for | Repo/policy guards, context loaders, budget gates shipped with the product | Plugin-specific reactions to app events |

**Decision rule:** if the user wants behavior that ships *with cognia* and gates
or augments *any* agent turn (deny a tool, inject context, enforce a budget),
build a **System-B built-in hook** (most common — start here). If the behavior
belongs to a specific plugin reacting to an app event, build a **System-A
plugin hook**.

Read `references/hook-event-catalog.md` for the full event list, which events
actually fire where, and each event's payload shape — consult it before picking
an event so you don't wire a hook to a dormant one.

---

## Path A — a product-bundled built-in hook (System B)

This is the common case: a `*.mjs` command hook that ships with cognia and is
merged **under** the user's own settings (so users can override/disable it).

### 1. Write the script — `hooks/builtin/<domain>-<policy>.mjs`

Follow the house pattern (see the existing `hooks/builtin/*.mjs` and
`.Codex/hooks/protect-generated-files.mjs`). The script is self-contained Node
with no `lib/` imports, because it runs as a spawned subprocess in both the
desktop and CLI runtimes.

The contract, identical across the Rust and CLI runners:

- **Input:** one JSON object on **stdin**. Read it with
  `JSON.parse(readFileSync(0, "utf8"))`. Useful fields: `hook_event_name`,
  `cwd`, `session_id`, and for tool events `tool_name` + `tool_input`; the
  runtime also threads event-specific fields (e.g. `prompt`, `tokensUsed`).
- **To allow:** `process.exit(0)` (optionally with no output).
- **To block** (only meaningful on `PreToolUse` / `UserPromptSubmit`): write the
  human reason to **stderr** and `process.exit(2)`. Both runtimes treat exit 2
  as a block with the first stderr line as the reason. (Equivalently, on
  `PreToolUse` you may print
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}`
  to stdout and exit 0 — the Rust runner parses it. Prefer exit-2+stderr for
  cross-runtime parity.)
- **To inject context** (observational events like `SessionStart` /
  `UserPromptSubmit` / `InstructionsLoaded`): print
  `{"hookSpecificOutput":{"hookEventName":"<event>","additionalContext":"…"}}`
  to stdout and exit 0.

**Fail open.** A misconfigured or absent dependency must never lock the user out
of their own agent — soft-allow (exit 0) on any ambiguity. See
`cost-quota-guard.mjs`: an unparseable budget exits 0, not 2. Cap any injected
context so a runaway file can't blow the prompt budget.

### 2. Register it — `lib/Codex/hooks/builtin-hooks.ts`

Add a `BuiltinHookDef` to the `BUILTIN_HOOKS` array:

```ts
{
  id: "my-guard",            // stable id used by overrides + the settings UI
  event: "UserPromptSubmit", // must be an event that actually fires (catalog)
  matcher: "Edit|Write",     // optional, tool-scoped events only
  script: "my-guard.mjs",    // filename in hooks/builtin/
  description: "One-line: what it does.",
  defaultEnabled: false,     // guards default OFF; harmless context loaders ON
}
```

`defaultEnabled`: a hook that can **block** should default `false` (opt-in) so a
fresh install never unexpectedly denies a turn; a purely additive hook (only
adds context when a file exists) may default `true`. The registry resolves each
id through `builtinHookOverrides` (id → enabled), so users keep final control.

### 3. The wiring is already done — verify, don't rebuild

- **CLI:** `createHookRunner` (`cli/src/tui/runtime/hook-runner.ts`) already
  calls `buildBuiltinHookGroups` and merges it under user hooks via `loadHooks`.
  A new registry entry is picked up automatically.
- **Desktop:** the Rust settings loader merges the same registry under
  user/project/local settings (`src-tauri/src/hooks/`).
- **Override field:** `builtinHookOverrides` exists in the CLI config schema and
  the desktop settings; the Settings → Hooks "Built-in hooks" list toggles it.

### 4. Test it (required — coverage gate ≥90%)

- Add spawn-smoke cases to `lib/Codex/hooks/builtin-hooks.test.ts`: run the
  script with `execFileSync(process.execPath, [scriptPath], { input })` and
  assert exit code + stdout/stderr for the allow, block, and inject paths.
- If you added a registry entry, assert `buildBuiltinHookGroups` emits/omits it
  under the right `overrides`.
- Run `NODE_ENV=test npx jest lib/Codex/hooks` from the repo root.

---

## Path B — a plugin hook (System A)

When the hook belongs to a plugin reacting to an app/agent event.

- **TypeScript:** register handlers in the plugin's entry; the author-facing
  types live in `plugin-sdk/typescript/src/hooks/index.ts` (`PluginHooks`,
  `PreToolUseResult`, `PromptSubmitContext`, …). Dispatch happens in
  `lib/plugin/messaging/hooks-system.ts`.
- **Python:** decorate with `@hook("onMessageSend")` etc. from
  `plugin-sdk/python/src/cognia/decorators.py`; return the (possibly modified)
  payload for pipeline hooks, or nothing for observers.
- **Capability:** the plugin declares the `"hooks"` capability — see
  `lib/plugin/contracts/plugin-capabilities.ts`. Tests: extend
  `lib/plugin/messaging/hooks-system.test.ts`.

Pipeline hooks (`onMessageSend`, `onPreToolUse`) can transform/deny; observer
hooks (`onTeamStart`, `onAgentComplete`) are fire-and-forget. Keep handlers fast
and isolated — a throwing handler is recorded, not allowed to break the run.

---

## Bracketing a second-order LLM call

If you're adding lifecycle hooks around an autonomous LLM call that runs
*outside* the main agent stream (a judge, a planner, an eval), don't hand-roll
event firing — reuse the firer seam:
`lib/Codex/hooks/lifecycle-firer.ts` (`firePreCallHooks` / `firePostCallHooks`,
`defaultLifecycleFirer`). See how `lib/goal/judge.ts` and
`lib/ai/agent/agent-team-runtime-deps.ts` bracket their calls. The CLI backs the
same interface with `cli/src/tui/runtime/lifecycle-firer.ts`.

## Before you call it done

- The event you chose actually fires (catalog) — a hook on a dormant event is dead code.
- Co-located tests cover allow / block / inject; `pnpm test:coverage` stays ≥90%.
- Any new user-facing string (settings label, toast) has en + zh keys; `pnpm lint:i18n` passes.
- Run the `preflight` skill — the `wiring-auditor` confirms the hook is reachable, not built-but-dormant.
