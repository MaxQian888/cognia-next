# TUI Parity & Industry Gaps — Plan (2026-07-16)

**Status:** none of this is implemented.

**Scope:** the `cognia-agent` interactive TUI (`cli/src/tui/`, 280 non-test source files,
43,493 LOC). This plan covers **parity** — TUI↔desktop-GUI, and TUI↔the 2026 industry
capability surface — plus **two defects** that the 2026-07-15 audit could not have found.

**Origin:** a four-track read-only sweep (TUI surface inventory · dormancy audit · GUI feature
inventory · industry benchmark of 12 competing agent CLIs). Every claim below was
re-verified by the plan author before being written down; see §0.2.

---

## 0. Relationship to `2026-07-15-tui-audit-remediation.md` — READ THIS FIRST

**Do not treat this plan as a replacement. It is the complement, at a different altitude.**

|          | 07-15 plan                                   | this plan                                                                 |
| -------- | -------------------------------------------- | ------------------------------------------------------------------------- |
| Altitude | tactical: what is broken _inside_ `cli/`     | strategic: what `cli/` is _missing_ relative to the GUI and the industry  |
| Method   | five-dimension audit of the CLI in isolation | four-track sweep that **compares** the CLI against two external baselines |
| Items    | T1–T6, W1–W9, P1–P5, R1–R5, C1–C5            | N1–N8                                                                     |

### 0.1 Three corrections to the 07-15 plan — apply these before using it

1. **Its opening "none of this is implemented" is stale.** `662fbe924` (2026-07-15,
   _"fix(cli): stop a truncated db.json from silently wiping the database"_) is W2, landed the
   same day the plan was written. **Re-check each W item's status before starting it.** W5/W6
   are confirmed still open (`runtime/memory-controller.ts:36` still reads
   `"Semantic recall is desktop-only; showing stored memories."`).

2. **Its §7 "Feature parity with Claude Code: ZERO gaps" is correct but narrowly scoped, and
   must not be read as closing this plan.** That claim covers **11 named UI affordances**
   (transcript search, message edit + fork, rewind/checkpoints, copy code block, file
   refs/attachments, queued input while streaming, todo display, multi-line paste, output
   truncation + expand, `/help <cmd>`, external editor). All 11 are genuinely present — I
   re-checked the rewind chain myself (§N5). **It is not a claim about the industry capability
   surface.** N3/N6/N7 below are in territory those 11 items never touched. Both statements are
   true at once.

3. **Its "surfaces swept and clean" list includes `cli/src/hooks/` — and that sweep missed a
   dead subsystem (N2).** This is not sloppiness; it is a **methodological limit worth
   internalizing**. The hooks defect is not _in_ `cli/src/hooks/`. That module is fine in
   isolation. The defect lives in the **contract between** `cli/src/hooks/load-hooks.ts` and
   `cli/src/config/schema.ts` — two modules that are each individually correct and mutually
   incompatible. **A per-directory sweep is structurally blind to cross-module contract
   conflicts.** Any future audit should add a pass that asks, for each config key a module
   reads: _does the schema that owns that file admit this key?_

### 0.2 Confidence labels — inherited from the 07-15 plan, same rules

| Label           | Meaning                                                                                                                                  | What you must do                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **[CONFIRMED]** | Re-verified by the plan author by executing a command or reading the file end-to-end. The command and its output are quoted in the item. | Trust it. Line numbers may drift — re-locate by symbol. |
| **[AGENT]**     | Reported by a subagent with evidence; **not** independently re-verified.                                                                 | **Re-verify before acting.**                            |
| **[OPEN]**      | Needs a human decision.                                                                                                                  | **Do not decide silently.** See §7.                     |

### 0.3 Evidence standard — inherit §0.2 of the 07-15 plan, plus two additions

The 07-15 plan's rules (ripgrep not bash `grep -r`; `head_limit: 0`; every absence claim needs
a positive control; truncated results are void) all still apply. Two more, both earned the hard
way during this sweep:

- **`rtk` masks jest exit codes.** The dormancy subagent reported `pnpm cli:test` "succeeded"
  while the real exit was 1. Run **`npx jest <paths>`** directly and read the `Test Suites:`
  line yourself. This is how N1 stayed invisible.
- **A subagent's narration about its own process is not evidence.** One track in this sweep
  reported that it had twice declared healthy sub-agents dead, and separately received an
  unprompted "self-retraction" claiming fabricated work. **Of the 9 findings that track
  reported, 6 did not survive re-verification** (see §6). Treat every `[AGENT]` claim as a
  hypothesis with a file:line attached, never as a result.

### 0.4 Repo gates that apply to every item

From `CLAUDE.md`, unchanged: co-located tests for any new/changed file under `cli/src/**`;
no simplifications; never `--no-verify`; `pnpm changeset` (package `cognia-next`) for anything
user-facing, marked per item. **N4 is the exception that proves the i18n rule — read it before
assuming the rule applies to the TUI.**

---

## 1. Phase 0 — the test gate is red (DO THIS FIRST)

The 07-15 plan's Phase 0 (T1–T6) restored the gate. **It has since gone red again**, from a
different cause that post-dates that plan.

### N1 — `github` MCP preset treats its mandatory credential as optional [CONFIRMED]

**Problem.** `/mcp add --preset github` silently creates a server with **no auth header at
all**, and `/mcp presets` prints a copy-pasteable command that builds it.

**Evidence.**

```
$ npx jest cli/src/mcp/preset-catalog.test.ts
● required / missing fields › treats every non-header field as required
    Expected value: "GITHUB_PERSONAL_ACCESS_TOKEN"
    Received array: []
Tests: 1 failed, 8 passed, 9 total
```

The mechanism, and note the comment is the bug:

```ts
// cli/src/mcp/preset-catalog.ts:71
/** Field keys the user must supply — every field except optional headers. */
export function requiredFieldKeys(preset: McpPreset): string[] {
  return preset.fields.filter((f) => f.placement !== "header").map((f) => f.key)
}
// :79 missingPresetFields — same `placement !== "header"` filter
```

The assumption _"headers are optional extras"_ held until `4afa2d8c7` (HEAD) migrated the
`github` preset from stdio+env to GitHub's remote HTTP server, moving its credential into a
header (`lib/claude/mcp-presets.ts:79,86`). `github` is now the **only header-only preset**, so
the carve-out swallows its sole mandatory field. The same filter is duplicated at
`cli/src/tui/runtime/mcp-controller.ts:797-798`.

Three user-visible consequences:

1. `missingPresetFields(github, {})` → `[]`, so the guard at `mcp-controller.ts:836` never
   fires. `applyPresetFields` drops the empty header (`lib/claude/mcp-presets.ts:388,395`),
   yielding `{url: "…"}` with no auth. User sees `Added MCP server "github" (http).` then a 401
   with no hint a token was ever needed.
2. With `required = []`, `/mcp presets` emits `Add: /mcp add --preset github --name <name>` — a
   **command that builds a broken server**. This is exactly the ADR-0050 defect class
   (`/permissions remove`): output text advertising a command that doesn't do what it says.
3. The red test above.

**The desktop does not have this bug** — `components/settings/mcp/mcp-preset-grid.tsx:160`
renders every field including headers, so the desktop form does prompt for the token. This is a
CLI-only divergence.

**Fix.** The filter's intent was _"don't force the user to fill optional headers"_, not _"never
require a header"_. Replace the placement test with an explicit optionality flag on the field
(`required?: boolean` / `optional?: boolean` on `McpPresetField`), defaulting to required, and
mark the genuinely-optional headers in the catalog. Fix both call sites
(`preset-catalog.ts:71,79` and the duplicate at `mcp-controller.ts:797`). **De-duplicate while
you are there** — two copies of the same predicate is what let this drift.

**Verification.** `npx jest cli/src/mcp/ cli/src/tui/runtime/mcp-controller.test.ts` green.
Add a regression test asserting `/mcp presets` never emits an `Add:` line for a preset with
unsatisfied required fields. Manually: `/mcp presets` must show `Required: --Authorization …`.

**Changeset:** yes (patch — user-facing fix).

---

## 2. Phase 1 — cross-module contract defects

### N2 — hooks: the schema forbids the key the loader reads, and the onboarding text tells you to write it [CONFIRMED]

**Problem.** The hooks subsystem has **no working configuration path**. Following the TUI's own
`/hooks` instructions makes the CLI fail to start.

**Evidence.** Three modules, each internally correct, mutually contradictory:

1. **The loader supports it.** `cli/src/hooks/load-hooks.ts:81` reads the `hooks` block out of
   `~/.cognia/config.json` via a raw `JSON.parse`, bypassing zod entirely. Its header comment
   (`:3-4`) states the design intent: _"an existing `~/.claude/settings.json` `hooks` block is
   honored **alongside** Cognia's own `~/.cognia/config.json` `hooks` block."_

2. **The schema forbids it.** `cliConfigFileSchema` is `.strict()` and has no `hooks` key
   (`grep -n "hooks:" cli/src/config/schema.ts` → no matches; the only hooks-adjacent key is
   `builtinHookOverrides`, which only toggles product-bundled built-ins). Probed directly:

   ```
   $ npx tsx probe.mts   # cliConfigFileSchema.safeParse({hooks: {PreToolUse: [...]}})
   SUCCESS: false
   ISSUES: [{"code":"unrecognized_keys","keys":["hooks"],"message":"Unrecognized key: \"hooks\""}]
   ```

3. **The failure is fatal, not a warning.** `load.ts:106` uses `.parse()` (not `safeParse`);
   `parseJsonFile` catches and **re-throws** with a `config.json:` prefix (`:105-108`);
   `resolveConfig:301` calls it with **no try/catch**. Config resolution runs at bootstrap, so
   the user never reaches the loader in (1).

**Why this is worse than a missing feature.** The contradiction surfaces in
`runtime/hooks-controller.ts:51-66` — the `active.length === 0` branch, i.e. **the only screen a
user who has never configured hooks will ever see** — which hands them:

```
"Add a `hooks` block to `~/.cognia/config.json` (or reuse your"
"`~/.claude/settings.json` hooks). Only `command` handlers run in the CLI;"
...
'{ "hooks": { "PreToolUse": [{ "matcher": "Edit|Write",'
'  "hooks": [{ "type": "command", "command": "./guard.sh" }] }] } }'
```

A copy-pasteable snippet that bricks their config. The onboarding text is the highest-leverage
place in the product to be wrong.

**Fix.** [OPEN — see D1] Two coherent options; **do not split the difference**:

- **(a) Make the schema admit it.** Add a `hooks` key to `cliConfigFileSchema` typed against
  `HooksConfig` (`cli/src/hooks/types.ts`). Honours the loader's stated design and the
  onboarding text; `~/.cognia/config.json` becomes the documented Cognia-native hooks home.
  Preferred — it is what all three other modules already assume.
- **(b) Make the docs honest.** Drop the `~/.cognia/config.json` half from both the loader and
  the onboarding text; `~/.claude/settings.json` becomes the only hooks source. Smaller diff,
  but abandons a stated design goal and leaves Cognia with no native hooks config.

**Verification.** A test that round-trips the **exact JSON snippet from
`hooks-controller.ts:61-64`** through `resolveConfig` and asserts it loads and produces a live
hook. Pin the onboarding text to the schema so they cannot drift again — this is the whole
lesson of the item.

**Also verify while you are here [AGENT, unverified]:** the same track reported that (i) the
bundled built-in hooks **fail closed outside the dev repo**, and (ii) both default-on built-ins
are no-ops. Neither was re-verified. If true they compound N2; if false, drop them. **Do not
write them into a commit message without checking.**

**Changeset:** yes (patch).

---

## 3. Phase 2 — TUI ↔ GUI parity (it runs in **both** directions)

**The framing that matters, and the reason this phase exists.** The file that carries `/rewind`
is named **`parity-commands.ts`** — and its parity target is **Claude Code, not this project's
own GUI**. That is a real and defensible strategy, but nobody is tracking its consequence: the
TUI and the GUI have been drifting apart in **both** directions, and neither side owns the
diff. N3/N4 are GUI→TUI gaps; N5 is a TUI→GUI gap. Decide each on purpose.

For scale: GUI = 90 routes, 56 navigable settings sections, 1770 non-test `.tsx`, 31 built-in
slash commands. TUI = 280 files, 68 top-level commands / 105 subcommands `[AGENT]`, 27
controllers, 17 rebindable chords.

**Most GUI-only subsystems are not gaps.** Twin, the 11 IM connectors, OCR, Computer Use, Pet,
Canvas/A2UI, the visual workflow editor, Observability, Eval — these are inherently graphical
and their absence from a terminal UI is correct. Do not "achieve parity" on them. The list
below is deliberately short because it is the part that actually matters.

### N3 — the CLI has no sandbox, and it is the shell most likely to need one [CONFIRMED]

**Problem.** `grep -rli "sandbox\|seatbelt\|bubblewrap" cli/src/` → **zero non-test matches.**
The TUI executes `!` shell-outs and model-driven `bash` with no OS-level confinement.

Meanwhile the GUI ships a whole sandbox subsystem: a `sandbox` settings section (enable, tier,
policy, workspace confinement, automation policy, canvas code sandbox — `settings-nav-config.ts:268`,
desktop-only) backed by ADR-0028.

**Why this ranks above everything else in the plan.** It is three problems wearing one coat:

1. **A GUI→TUI parity gap** — the desktop confines tool execution; the CLI does not.
2. **An industry table-stakes gap** — Claude Code (Seatbelt / bubblewrap+seccomp), Codex CLI
   (Seatbelt / bubblewrap / Windows), and Gemini CLI (Seatbelt 6-profile matrix + Docker +
   Podman + gVisor + LXC + Windows) all ship OS-level bash sandboxing. Note for whoever picks
   this up: **bubblewrap has displaced Landlock as the Linux default** in both CC and Codex —
   do not start from Landlock.
3. **A safety gap pointed at the wrong shell.** The CLI is the shell most likely to run
   headless in CI or on a server — that is the entire premise of ADR-0059's cloud deployment —
   and it is the one with no confinement.

**Fix.** [OPEN — see D2] Scope is a real decision, not a detail. Minimum viable is macOS
Seatbelt + Linux bubblewrap for the `bash` tool and `!` shell-outs, reusing the ADR-0028 policy
vocabulary so the two shells share one mental model rather than growing two. Whether the CLI
can reuse the Rust sandbox implementation or needs a Node-side one is the first question to
answer — **answer it before designing anything.**

**Verification.** An integration test per platform asserting a sandboxed command cannot read
outside the workspace root. `/doctor` should report sandbox status.

**Changeset:** yes (minor).

### N4 — the TUI has no i18n at all [CONFIRMED]

**Problem.** `CLAUDE.md` Working Rule 4 mandates every user-facing string be `next-intl`-wired
with keys in both `en.json` and `zh-CN.json`. The TUI has **zero** i18n: `find cli/src -iname
"*locale*" -o -iname "*i18n*" -o -iname "*translat*"` → nothing. All ~43k LOC of user-facing
output is hard-coded English.

**This is not simply "not done yet."** Three facts make it a decision that was made and never
recorded:

1. `cli/src/tui/format/limits.ts:10` — _"the i18n keys on each meter are for the desktop
   renderer"_. The shared lib **already hands the TUI i18n keys** and the TUI deliberately
   discards them.
2. `cli/src/serve/serve-command.ts:25` imports `loadMessageResolver` from
   `@/lib/headless/i18n`. **The headless serve path in the same package is i18n-wired.** The
   infrastructure exists and runs in Node today.
3. `docs/content/docs/zh/subsystems/cognia-agent-tui.mdx` exists — **the docs are bilingual
   while the product they document is not.**

**Fix.** [OPEN — see D3] This is a scope question the plan author should not answer alone. The
options are genuinely far apart (localize nothing and say so at the type + in `CLAUDE.md`;
localize only the operator-facing surface — errors, `/doctor`, onboarding; or localize
everything through `lib/headless/i18n`). Note that Working Rule 4 says `.tsx`, and the TUI's
`.tsx` is Ink, not React-DOM — so the rule's _letter_ is arguably already satisfied while its
_intent_ plainly is not. **That ambiguity is exactly why this needs a human.**

**Verification.** Whatever is decided, it must be pinned per Working Rule 7 (documented at the
type AND labeled AND tested). Today it is 0/3.

**Changeset:** depends on outcome.

### N5 — reverse gap: the GUI has no `/rewind`, and that is probably wrong [CONFIRMED]

**Problem.** The TUI has a full checkpoint/rewind system the desktop lacks entirely.

**Evidence.** TUI: `runtime/checkpoint-store.ts` (`Checkpoint`, `CheckpointMeta`,
`RestoreScope`, `ShadowRef` — shadow git refs), `runtime/checkpoint-capture.ts`, wired at
`commands/parity-commands.ts:99` — _"restore files and/or conversation to an earlier
checkpoint"_, with independent file and conversation scopes.
GUI: `grep -rln "rewind\|checkpoint" components/chat/ lib/claude/` → **zero matches**. The only
`checkpoint` in the desktop tree is the agent-team progress ledger, unrelated. The GUI's
history-navigation story is **branching** (`branch-dialog.tsx`, `branch-navigator.tsx`) instead.

**Why raise it here.** Checkpoints are table stakes in 2026 (Claude Code `/rewind` + Esc-Esc;
Gemini CLI ships **two** independent undo systems). The desktop is the flagship shell and it is
the one without the affordance. Industry note worth stealing: Claude Code's rewind offers
**"Summarize from here / up to here"** — targeted partial compaction, not just restore — and
Zed surfaces checkpoints **at interrupt time**, i.e. placing the affordance exactly at the
moment of regret.

**Fix.** [OPEN — see D4] Not "port it." Decide whether branch and rewind are redundant or
complementary. `RestoreScope` already separates files from conversation, and _files_ is the
half branching cannot express at all — that asymmetry is the strongest argument that they are
complementary and the GUI is genuinely missing something.

**Changeset:** if implemented, minor.

---

## 4. Phase 3 — industry gaps

Sourced from a benchmark of Claude Code 2.1.211, Codex CLI 0.144.5, Gemini CLI 0.50.0, aider
0.86.2, opencode 1.18.2, Crush 0.85.0, Cursor CLI, Amp, Continue CLI 1.5.47, Devin CLI
3000.1.27, Warp, Zed 1.11.3 (all versions verified against npm/PyPI/GitHub APIs on 2026-07-16).

**Standing:** against the 18 capabilities that are table stakes in 2026, the TUI has **14**.
This is a strong position — better than most of the field. It already has several things the
benchmark found in only one or two competitors: live elapsed-time on running tools, inline
images on kitty/iTerm2/WezTerm, OSC-8 hyperlinks, per-tool MCP disable that really writes
`disallowedTools`, name-only skill loading, and CJK width handling that nobody else does at
all. **`/init` already reads `AGENTS.md`, `AGENT.md`, and `CLAUDE.md`**
(`runtime/init-controller.ts:35`) — i.e. it already reads competitors' instruction files, which
the benchmark scored as a differentiator.

The missing four: **sandbox** (N3, above — the only one that is also a GUI gap and a safety
issue, which is why it outranks these), **ACP** (N6), **git worktree isolation**, and **cloud
handoff** (N7).

### N6 — no ACP support; this is the one strategic gap [CONFIRMED absent]

**Problem.** `grep -rli "agent-client-protocol\|\bacp\b" cli/src/` → **zero matches.**

**Why it matters.** The **Agent Client Protocol** (schema v1.19.0, 2026-07-06; wire version
`1`) is doing for coding agents what LSP did for language servers, and it is winning. Clients
today: Zed, **all JetBrains IDEs**, Qt Creator, 4 Neovim plugins, Emacs, Obsidian, VS Code.
~40–50 agents. Gemini CLI speaks it natively; **Claude Code and Codex do not** — they are
reachable only through Zed's adapter. The ACP Registry (Zed + JetBrains, 2026-01-28) solved
distribution: one `agent.json` PR → live in every ACP client.

**This is a two-sided opportunity, and the cheap side is very cheap:**

- **Free design work even if you never speak the wire.** ACP's ontology is a solved version of
  problems this TUI already has: 9 standardized tool-call kinds (`read`/`edit`/`delete`/`move`/
  `search`/`execute`/`think`/`fetch`/`other`) with `pending→in_progress→completed/failed`;
  `locations` for editor follow-along; first-class `diff` and `terminal` content types;
  **replace-whole-plan semantics** (_"the Client MUST replace the current plan completely"_ —
  which designs out a whole class of incremental-patch bug); `usage_update` making context+cost
  a protocol concern; and the **terminal inversion** where the client owns the PTY and the
  agent requests non-blocking, byte-capped terminals.
- **Speaking it would make `cognia-agent` hostable inside Zed and all JetBrains IDEs** for near
  zero marginal distribution cost.

**Fix.** [OPEN — see D5] Do not start by implementing. Start with a spike that maps ACP's
`ToolCallKind` / status / `locations` onto the existing `state/` cell model and reports how
much of the reducer would have to change. The answer to _"is our tool-call model already
ACP-shaped?"_ decides whether this is a week or a quarter.

**Changeset:** N/A for the spike.

### N7 — worktree isolation and cloud handoff [CONFIRMED absent]

`grep -rli "worktree" cli/src/` → one incidental hit in `hooks/types.ts`; no implementation.
The **GUI has worktrees** (`components/agent/workspace/worktrees-panel.tsx`, agent-team
settings), so this is also a GUI→TUI gap. Claude Code auto-isolates background sessions under
`.claude/worktrees/`; Zed, Cursor, and opencode all ship worktree isolation.

Cloud handoff: every second-tier competitor now has one (Cursor `&` local→cloud; Devin
`/cloud-attach` cloud→local **with full local TUI**; Codex `/app` + `cloud exec` + `apply`;
Claude Code `--teleport`). It crossed from novelty to expected inside a year. ADR-0059 already
built the headless brain this would ride on — **the substrate exists; the affordance does
not.**

**Priority:** below N3/N6. Listed so the next audit does not rediscover them as news.

---

## 5. Phase 4 — documentation truth

### N8 — the subsystem doc is stale on every headline number [CONFIRMED]

`docs/content/docs/en/subsystems/cognia-agent-tui.mdx` (and its `zh` twin):

| Metric              | Doc claims                 | Actual                             |
| ------------------- | -------------------------- | ---------------------------------- |
| TUI source files    | ~175                       | **280**                            |
| Runtime controllers | 19 (StatGrid) / 20 (prose) | **27**                             |
| Overlays            | 14                         | **19** files                       |
| Rebindable chords   | 13                         | **17** (`input/keybindings.ts:16`) |
| Top-level commands  | "45+"                      | **68** `[AGENT]`                   |

Cause: `707ea06b5` (vim mode, leader chords, `/bashes`, `/resume <id>`) and later work landed
after the doc was written. ADR-0050 also says "→ 13" for `KEYBINDABLE_ACTIONS` in three places.

Two claims are wrong in kind, not just in number:

- _"Every pure module under `commands/` … has a co-located `*.test.ts`"_ is **false**:
  `commands/{runtime-handler,pr-command,commit-command,skill-commands,mcp-commands,view-commands}.ts`
  and `components/overlays/FormOverlay.tsx` have none. (The four `types.ts` files are type-only
  and exempt in spirit.) `[AGENT]` — re-verify the exact list.
- `/team run` is listed as a desktop-only gap, but `team-controller.ts` now dispatches to a
  running desktop app. **The code is more capable than the doc.**

**Fix.** Correct the numbers in both locales; delete the two false claims; either write the six
missing tests or drop the blanket claim. **Add the counts to a test** so the StatGrid cannot
drift silently again — the numbers are cheap to assert and this is the third time they have
rotted.

**Changeset:** no (docs).

---

## 6. Do NOT do these

- **Do not re-audit the 11 Claude Code affordances in §7 of the 07-15 plan.** Verified present
  twice now, including by me.
- **Do not act on these six `[AGENT]` claims — they did not survive re-verification:**
  - _"`/layout` and `/mouse` never persist"_ — **false.** `commands/layout-command.ts:8`:
    _"Pure handler: it returns a `layout` effect the App persists (to config.json)."_
    Persistence is in the App layer; the agent grepped for `saveConfig` in the command file
    only.
  - _"`/tasks run` refuses silently"_ — **false.** `runtime/tasks-controller.ts:5-6` documents
    it: _"Triggering a run is desktop-only (the executors need the Tauri runtime), so it is
    intentionally not exposed here."_ Intentional and documented at the type.
  - _"sidecar 0.835 pre-empts CLI 0.85"_ — **constants confirmed, interaction not.**
    `cli/src/agent/auto-compact.ts:15` = `0.85`; `sidecar/dispatch/compaction.mjs:18` = `0.835`.
    Whether both fire on the same path for the same session was **not** established. If you
    want this, prove the path first. **[OPEN-ish — worth 30 minutes, not a plan item yet.]**
  - _"`/rewind files` silently misses Bash mutations"_, _"checkpoints are never pruned"_,
    _"background subagents are uncancellable"_, _"`~/.cognia/.cognia/` double-nesting orphans
    hand-authored agents/modes"_ — **not verified either way.** Each has a plausible shape and a
    named file. Treat as hypotheses; verify before writing any of them into a commit.
- **Do not "achieve parity" on the inherently-graphical GUI subsystems** (Twin, connectors,
  OCR, Computer Use, Pet, Canvas/A2UI, workflow editor, Observability, Eval). Their absence
  from a terminal UI is correct.
- **Do not start N6 by implementing ACP.** Spike first (§4).

---

## 7. Open decisions — DO NOT decide these silently

- **D1 — N2 hooks: schema-admits-key (a) or docs-drop-the-claim (b)?** (a) is preferred and
  matches what three modules already assume, but it makes `~/.cognia/config.json` the native
  hooks home — a product decision about where hooks live.
- **D2 — N3 sandbox scope.** Which platforms, which tools, and **can the CLI reuse the Rust
  ADR-0028 implementation or does it need a Node-side one?** Answer the reuse question first;
  it determines everything else.
- **D3 — N4 i18n: is the TUI in or out of Working Rule 4?** The rule says `.tsx`; the TUI's
  `.tsx` is Ink. Letter arguably satisfied, intent plainly not. Whatever is chosen must be
  recorded — today the dormancy is undocumented on all three axes.
- **D4 — N5: are branch and rewind redundant or complementary?** `RestoreScope`'s file/
  conversation split suggests complementary — branching cannot express file restore at all.
- **D5 — N6: is ACP a strategic bet?** Cheap half (borrow the ontology) is nearly free.
  Expensive half (speak the wire) buys Zed + JetBrains distribution. These can be decided
  separately and the cheap half does not commit you to the expensive one.

---

## 8. Suggested order

1. **N1** — red gate, small diff, high certainty. Nothing else should land on a red gate.
2. **N2** — dead subsystem on the new-user path; needs D1 first.
3. **N8** — hours, and every later audit reads these numbers. Cheap truth.
4. **N3** — the highest-value item in the plan (safety + GUI parity + table stakes in one);
   needs D2.
5. **N6 spike** — cheap, and its answer shapes the roadmap.
6. **N4 / N5 / N7** — after their decisions land.

**One-commit-per-item**, as the 07-15 plan requires. N1 and N2 are independent of everything
else and of each other.

---

## 9. Provenance

Four parallel read-only tracks on 2026-07-16: TUI surface inventory · TUI dormancy audit · GUI
feature inventory · industry benchmark (12 products, versions verified against npm/PyPI/GitHub
APIs; the benchmark's own UNVERIFIED flags were respected and are not reproduced here as fact).

Everything labeled [CONFIRMED] was re-verified by the plan author — by running the test (N1),
probing the schema with `tsx` (N2), or reading the file (N3–N8). **6 of the 9 findings from one
track were discarded on re-verification** (§6); that ratio is the most important number in this
document. Nothing was written to the repo besides this file.
