# TUI ↔ GUI Linkage (联动) — Remediation Plan (2026-07-16)

**Status:** none of this is implemented. Design + phased build plan.

**Scope.** The **interworking** between the `cognia-agent` interactive TS TUI (`cli/src/`) and
the desktop Tauri+Next.js GUI — i.e. the `cli-bridge` subsystem (`lib/cli-bridge/`,
`src-tauri/src/cli_bridge/`, `cli/src/handoff/`) plus the session-handoff, fleet, and
integrated-terminal seams that connect the two shells. This plan is about the **wires between
the shells**, not feature-parity inside either one.

> Two same-name CLIs exist and consume **different** bridge routes — keep them apart throughout:
> **`cognia-agent`** = the TS chat TUI (`cli/src/`, npm bin `cognia-agent`); **`cognia`** = the
> Rust plugin-author CLI (`crates/cognia-cli/`). Conflating them is the single biggest source of
> error in this area.

**Origin.** A four-track read-only linkage sweep on 2026-07-16 (code-reuse seam · live
coordination bridges · shared data/config/session · external-agent hosting state), then an
**adversarial re-verification pass** that tried to _refute_ every proposed optimization. **Three
of the eight candidate gaps did not survive** (§3) — that ratio is the most important number in
this document. Nothing was written to the repo besides this file.

---

## 0. Relationship to the two existing TUI plans — READ FIRST

This is the **third** TUI plan of 2026-07-16 and it is a complement, not a replacement:

| Plan                                         | Altitude                                         | Owns            |
| -------------------------------------------- | ------------------------------------------------ | --------------- |
| `2026-07-15-tui-audit-remediation.md`        | tactical: what is broken _inside_ `cli/`         | T/W/P/R/C items |
| `2026-07-16-tui-parity-and-industry-gaps.md` | strategic: what `cli/` _lacks_ vs GUI + industry | N1–N8           |
| `2026-07-16-tui-external-agent-hosting.md`   | one capability: TUI hosts Codex/Claude Code      | Phase 0–5       |
| **this plan**                                | the **wires between** TUI and GUI                | **L1–L7**       |

**Do not re-derive their items here.** In particular:

- **L1 (external-agent hosting) is owned by the external-hosting plan.** This plan only records
  its _current wiring status_ (built-but-dormant) and its rank (P0 prerequisite), then defers to
  that plan's Phases 1–5. Do not re-plan it.
- **N3 sandbox / N4 i18n / N5 (GUI lacks rewind) / N6 ACP** stay in the parity plan. This plan
  references them where a linkage item inherits a decision; it does not restate them.

### 0.1 Confidence labels

| Label           | Meaning                                                                      | What to do                                    |
| --------------- | ---------------------------------------------------------------------------- | --------------------------------------------- |
| **[VERIFIED]**  | Confirmed by an author read **and** survived an adversarial refutation pass. | Trust it; re-locate by symbol if lines drift. |
| **[CONFIRMED]** | Author read the file/ran the grep; not adversarially re-checked.             | Trust, re-verify on touch.                    |
| **[OPEN]**      | Needs a human decision.                                                      | See §4. Do not decide silently.               |

### 0.2 Evidence rules (inherited, unchanged)

ripgrep not bash `grep -r`; every absence claim needs a positive control; `rtk` masks jest/cargo
exit codes — run `npx jest <paths>` / `cargo test` directly and read the summary line yourself;
a subagent's narration is a hypothesis with a file:line attached, never a result.

### 0.3 Repo gates on every item

From `CLAUDE.md`, unchanged: co-located `*.test.ts(x)` / `#[cfg(test)]` for any new/changed file
under `cli/src/**`, `lib/**`, `components/**`, `src-tauri/src/**`; coverage ≥90%; no
simplifications; never `--no-verify`; `pnpm changeset` (package `cognia-next`) per the marked
item. Baseline gate state (2026-07-16): typecheck + lint GREEN; i18n-sort / rust-toolchain /
coverage:changed have **pre-existing** red — gate on YOUR files, not the baseline count. TUI i18n
inherits parity-plan **N4** (`.tsx` is Ink, not React-DOM — do not unilaterally wire `next-intl`).

---

## 1. The linkage inventory — what already exists (shared context)

The interworking is a real, wired, mostly-symmetric bridge. Naming it precisely is prerequisite
to seeing the gaps. **The `cli-bridge` subsystem is not in `CLAUDE.md`'s Subsystem Map and has no
dedicated ADR** (closest: 0050 cli-tui, 0059 headless-brain, 0061 cross-device, 0064
external-cli-dispatch) — that omission is itself L7.

**Transport substrate [CONFIRMED].** Desktop writes `<config_dir>/cognia/cli-endpoint.json`
(`{baseUrl, devToken}`, 0600) at launch (`src-tauri/src/cli_bridge/mod.rs:144,174`); the CLI reads
it (`cli/src/handoff/endpoint.ts:21`). Loopback axum `127.0.0.1:0` + `X-Cognia-Dev-Token`
(constant-time compare) + loopback-only middleware (`server.rs:107-140`). Started unconditionally
in release; never spawned on mobile. **12 routes** under `/api/v1/dev/*`: `health`,
`plugins/{installed,install,install-directory,uninstall,reload}`, `acp/token`, `sessions/handoff`,
`twin/context`, `teams/{list,run,run-status}` (`server.rs:63-101`).

**Who consumes what [CONFIRMED].** `cognia-agent` uses `health`, `sessions/handoff`,
`teams/{list,run,run-status}` (`cli/src/team/desktop-client.ts`), `twin/context`
(`cli/src/twin/context-client.ts`). `plugins/*` + `acp/token` belong to the plugin-author `cognia`
(`crates/cognia-cli/`). `teams/*` and `twin/context` are **renderer round-trips** — the Rust
handler blocks on the WebView via `cli-bridge://renderer-request` (`renderer_bridge.rs`,
dispatched by `lib/cli-bridge/renderer-request-source.ts`, mounted in `app/layout.tsx`) → LIVE
only while the desktop WebView runs.

**Desktop→CLI push [CONFIRMED].** `lib/cli-bridge/auto-push.ts` (gated by `settings.cliBridge.autoSync`)
writes config + credentials + history into `~/.cognia/*` on boot/toggle so the CLI runs with the
same auth, no second login. Control UI: `components/settings/cli-bridge/cli-sync-card.tsx`
("Sync now" + auto toggle). Reverse handoff: `lib/chat/export-handoff-to-cli.ts` drops
`~/.cognia/handoff/<id>.jsonl` → `cognia-agent resume <id>`. Desktop can even detect + download +
signature-verify the CLI (`lib/cli-bridge/{detect-cli,download-release,embedded-pubkey}.ts`).

**Stores forked, code shared [CONFIRMED].** CLI sessions = `~/.cognia/sessions/*.jsonl` +
`~/.cognia/db.json` (Dexie mirror via fake-indexeddb, same `@/lib/db/schema`); GUI = browser
IndexedDB + keyring. Same sidecar (`sidecar/claude-host.mjs`), same `resolveSendOptions` +
run-and-capture loop; the CLI swaps in a Node `StdioTransport` via `setTransport`
(`cli/src/runtime/{bootstrap,stdio-transport,protocol}.ts`, a port of `src-tauri/src/claude/*.rs`
minus hook interception). `cli/src` imports **124 distinct `@/lib/*` modules**.

---

## 2. Verified actionable items

### L1 — External-agent hosting: the carrier is built but **dormant** (P0 prerequisite) [VERIFIED]

**Status, not a re-plan.** `cli/src/runtime/external/{node-backend,sandbox-launcher,host-branch,native-shim}.*`
already implement a complete, unit-tested Node process backend that mirrors the GUI's
`lib/ai/agent/external/agent-transport.ts` seam (same `spawn/send/kill/check_command_exists`
commands, same frozen `external-agent://*` channels; binary/npx allowlist; cwd jail; env scrub;
a Rust sandbox launcher `crates/cognia-automation/src/bin/cognia-external-agent-launcher.rs`). **But
it is not wired** [VERIFIED]:

- the whole `cli/src/runtime/external/` dir is **untracked** (`git status` `??`); nothing outside
  it and its own `.test.ts` imports it (`rg` empty);
- the shared `agent-transport.ts:23` gates on `isTauri() || isHeadlessHost()` — **no CLI branch** —
  so in the interactive TUI `supportsExternalAgents()` returns **false**;
- `scripts/build/build-cli.mjs` does **not** alias the seam to `host-branch`/`native-shim` (its
  alias list is still only `next/*`/`server-only`/`client-only`/asset loaders);
- the `cli:external-host:build` script that `sandbox-launcher.ts:79` references **does not exist**
  in `package.json`.

**So the GUI can host Codex/Claude Code and the TUI still cannot** — it does read-only _definition_
reuse only (`cli/src/agent/discover-agents.ts:170`).

**Action.** Execute **Phases 1–5 of `2026-07-16-tui-external-agent-hosting.md`** (the node-backend
et al. are that plan's Phase-1 deliverables landed early as a spike). The remaining wiring is
exactly: build/dev alias (§3.3 there) + a CLI host branch + the event mapper + the session factory

- chat selector. **Do not duplicate that plan here.** This item exists only to rank it: it is the
  **highest-value linkage gap** and a prerequisite mindset for the rest — a dormant, tested carrier
  is one alias away from shipping.

**Changeset:** owned by the external-hosting plan (minor).

---

### L2 — Richer desktop→CLI handoff transcript fidelity [VERIFIED]

**Problem.** The desktop→CLI session handoff flattens to plain text and silently **drops
tool-calls, tool-results, reasoning, and file attachments**. Image parts become the literal string
`"[image]"` with no data.

**Evidence [VERIFIED].** `lib/chat/export-handoff-to-cli.ts:51-56` builds each JSONL line via
`extractPlainText(message.parts)`; `lib/inbox/extract-plain-text.ts:58-82` handles only
`text|markdown|code|image|a2ui` and **skips every other part type**. `resume` then injects the
transcript as a **text preamble** (`cli/src/cli/handoff-cmd.ts:187-189`), so the loss is pure
signal loss with no downstream schema constraint.

**Why this is the right half to fix.** The desktop's `parts[]` genuinely contain the rich data;
the CLI transcript is line-oriented and injects as text. So a fix here is **additive and
zero-wire-change**: emit text markers instead of dropping. The _reverse_ direction (CLI→GUI rich
fidelity) is **not** worth it — the CLI transcript never records structured parts to begin with
(`cli/src/agent/session-runner.ts:521-584` appends only `{role,content}`), so there is nothing
rich to carry, and widening it would touch the stable Rust+TS `HandoffMessage` wire. **Live
teleport is out of scope entirely** (§3, refuted).

**Fix.** Extend `toLine` / a handoff-specific serializer (not `extractPlainText`, which is shared —
add a `handoff` variant or a `partToHandoffMarker` helper) to render, as text: `[tool: <name>]
<one-line arg/result summary>`, `[attachment: <filename>]`, and keep code fences. Preserve ordering.
Keep it a **text preamble** — no wire or transcript-schema change. Cap marker length to avoid
blowing the preamble budget.

**Verification.** Unit test: a session with a tool-call part + a file attachment + an image
round-trips through the serializer and the markers appear in the JSONL; assert no part type is
silently dropped without at least a marker. Manually: hand off a desktop session that used tools,
`cognia-agent resume <id>`, confirm the tool context is present in the preamble.

**Changeset:** yes (patch — user-facing handoff quality).

---

### L3 — Suppress the fleet "phantom claude-code" ghost [VERIFIED]; promote to a fleet agent is [OPEN]

**Problem (bug half).** When the user has the desktop fleet monitor's Claude hooks installed
(`~/.claude/settings.json`) **and** the monitor running, starting a `cognia-agent` session makes a
**phantom idle "claude-code" row** appear in the fleet island — mislabeled, showing no
activity/prompt/cwd, cleaned up on session end.

**Evidence [VERIFIED].** The CLI merges + executes `~/.claude/settings.json` `command` hooks
(`cli/src/hooks/load-hooks.ts:82`, `run-hooks.ts:107`); the fleet install script hardcodes
`"agent":"claude-code"` (`src-tauri/src/fleet/install.rs:157`) and its token passes regardless of
caller. The masquerade **self-limits**: the fleet registry drops any event without
`payload.session_id` (`registry.rs:292-294`), and the CLI only attaches `session_id` on
`SessionStart`/`SessionEnd` (`cli/src/tui/hooks/hook-runner.ts:130,133`) — so only a create/idle/
cleanup ghost appears, no activity. Severity: **low / cosmetic**; loopback + 0600 token, same user,
no exfil.

**Fix (bug half — ship this).** Filter fleet-managed hook groups out of the CLI's _executed_ hooks.
The marker already exists: `isFleetHookHandler` keys on the `agent-monitor/claude-hook.sh` path
(`lib/claude/hooks/fleet-hooks.ts:103-110`). Add a ~1-predicate filter in `cli/src/hooks/load-hooks.ts`
that skips any hook group whose `command` contains that path. Surgical, testable, cannot lock the
user out.

**Verification.** Unit test: a `~/.claude/settings.json` with a fleet claude-hook group + a
user's own hook loads only the user's hook; the fleet group is excluded. Assert the fleet path
predicate matches `install.rs`'s written path.

**[OPEN — D1] Feature half:** make `cognia-agent` a _first-class_ fleet citizen (a `CogniaAgent`
`FleetAgent` variant + a CLI fleet emitter POSTing `agent:"cognia-agent"` with `session_id`+`cwd`
on every event). ~6–7 touch points (`registry.rs:32,39`, `lib/fleet/types.ts:7`, `routes.rs:157`
permission arm, a new CLI emitter module, optional terminal-identity env). Desirable but a bounded
feature that competes with the cheap suppression. **Recommendation: ship suppression now; scope the
feature separately.** Do not do both blindly — decide D1 first.

**Changeset:** yes (patch — suppression is a user-visible fix).

---

### L4 — "Open in terminal" should actually launch `cognia-agent` [VERIFIED] + [OPEN] binary discovery

**Problem.** The desktop session-row's **"Open in terminal"** action writes the handoff drop-file
and then only **toasts the resume command** — it does not open a terminal. The user must
copy/paste `cognia-agent resume <id>` by hand, which is exactly the friction the action name
promises to remove.

**Evidence [VERIFIED].** `components/desktop/session-row.tsx:234-244` — `handleOpenInTerminal`
calls `exportHandoffToCli(...)` then `toast.success(t("openedInTerminal", { command }))`; the
header comment (`:231`) says it "surface[s] the resume command." No launch.

**Why it's cheap.** Both hard primitives already ship: (1) path-confined drop-file writer +
`resume` command (`lib/chat/export-handoff-to-cli.ts`, `cli/src/cli/handoff-cmd.ts:34`); (2)
launching a CLI in a fresh dock terminal tab with injectable env
(`lib/terminal/run-cognia.ts:49-85` `launchCognia`; `SpawnRequest.env` at
`crates/cognia-terminal/src/session.rs:69`). The work is **compose them and point at
`cognia-agent`**: after writing the drop-file, spawn a dock tab writing `cognia-agent resume <id>\r`.

**[OPEN — D2] The real scoping question: `cognia-agent` binary discovery.** Unlike the plugin-author
`cognia` (which the terminal PATH-weaves, `session.rs:286`), `cognia-agent` is an npm bin
(`cli/package.json:7`) with **no bundled binary and no PATH weave** — so an auto-launched
`cognia-agent resume <id>` fails with "command not found" unless the user globally installed it.
Decide one: (i) gate the action on a presence probe (mirror `useCogniaCliStatus`) and disable it
otherwise; (ii) fall back to `npx cognia-agent …`; (iii) extend `build_cli_path_injection` /
bundling to cover `cognia-agent`. Recommendation: **(i) presence-gate for v1** — lowest risk, no
new distribution surface.

**Fix.** Add a `launchCogniaAgent` sibling to `run-cognia.ts` (or parameterize it), gate the
`session-row.tsx` action on a `cognia-agent` presence probe, and on click write the drop-file +
spawn the tab + write the resume command. ~2–4 files + tests.

**Verification.** Component test: with the binary present, "Open in terminal" spawns a dock tab and
writes the resume command; with it absent, the action is disabled (or shows the copy-command
fallback). Manually drive the dock terminal once.

**Changeset:** yes (minor — new user-visible capability).

---

### L5 — Push the Codex **api_key-mode** vault credential to the CLI [VERIFIED] — [OPEN] scope

**Problem.** `lib/cli-bridge/push-credentials.ts` projects `providerSettings[*].apiKey` + the
Anthropic subscription bearer, but **never** the Codex subscription/vault credential
(`resolveCodexVaultCredential`). A Codex user whose key lives only in the vault gets zero Codex
credential on the CLI and must log in again.

**Evidence [VERIFIED].** `push-credentials.ts:63-94` — two sources only; `rg resolveCodexVaultCredential
lib/cli-bridge/` empty. The "don't leak keyring subscription secrets to a flat file" rationale is
**refuted**: the push already writes the Anthropic bearer into the same 0600 `credentials.json`
(`push-credentials.ts:73`), so the asymmetry is not a deliberate security boundary.

**But the scope is narrower than the raw gap [VERIFIED].** `resolveCodexVaultCredential`
(`lib/subscription/codex/chat-bridge.ts:87-104`) returns two shapes:

- **api_key mode** → `{apiKey, baseURL}`. Pushing `apiKey` under `providers.codex` is **safe and
  works** — the CLI backfills the catalog baseURL. This is the effective, low-risk slice.
- **chatgpt mode** → a **short-lived bearer refreshed every turn**, plus `baseURL` +
  `ChatGPT-Account-Id`/`OpenAI-Beta`/`originator` headers. The CLI `credentials.json` shape is only
  `{apiKey?, authToken?}` (`cli/src/config/schema.ts:836-856`) — it **cannot carry headers/baseURL/
  refresh-token**, and the CLI has no Codex OAuth-refresh. A pushed bearer would 401 within ~an hour
  with no recovery. **Out of scope** — that is a CLI-schema + OAuth-refresh feature, not a coverage
  patch.

**Fix.** In `gatherCredentials`, when a Codex vault credential resolves in **api_key mode**, project
its `apiKey` under `providers.codex` (respecting an existing `providerSettings.codex.apiKey`). **Do
not** push chatgpt-mode; instead surface a one-line note in the sync card that ChatGPT-login Codex
needs a separate CLI login (or an API key). **[OPEN — D3]** whether the full chatgpt-mode path is
worth a follow-up (CLI Codex-OAuth) — likely defer.

**Verification.** Unit test: an api_key-mode vault resolves → `credentials.json` gains
`providers.codex.apiKey`; a chatgpt-mode vault → **not** pushed, and the note is shown. Never
serialize a refresh token or headers into `credentials.json`.

**Changeset:** yes (patch).

---

### L6 — [OPEN, optional want] Surface CLI-authored sessions read-only in the GUI picker

**Problem.** A session created in the CLI only reaches the GUI via an explicit
`cognia-agent handoff` while the desktop is running; there is no passive "CLI sessions show up in
the desktop sidebar." This is the **only** survivor of the (otherwise refuted, §3) "one-way"
framing.

**Evidence [VERIFIED].** The plumbing already exists: the CLI persists real `ChatSession` rows into
its Dexie mirror (`cli/src/tui/.../cli-session-store.ts`, same `@/lib/db/schema`), serialized to
`~/.cognia/db.json`. A **read-only** loopback route (`GET /api/v1/dev/sessions/list`) reading that
mirror is the minimal, safe scope — it never writes desktop state, so it does not touch the
intentional one-way invariant (§3, G1).

**Why gated behind a decision.** This is a _want_, not a defect, and it adds a bridge route + a GUI
list surface. **[OPEN — D4]** decide whether it's worth it before building; if yes, it is
read-only-only (importing a listed CLI session reuses the existing handoff-import path, producing a
copy — never a live shared session).

**Changeset:** if implemented, minor.

---

### L7 — Documentation truth: `cli-bridge` is off the map [CONFIRMED]

**Problem.** The whole linkage subsystem (§1) is undocumented as a subsystem: it is **not in
`CLAUDE.md`'s Subsystem Map** and has **no dedicated ADR**. Every audit that starts from the
Subsystem Map is structurally blind to it (this plan's own research had to discover it from
`git grep`).

**Fix.** (1) Add a `CLI ↔ App bridge` row to the Subsystem Map (`Lives in`: `lib/cli-bridge/`,
`src-tauri/src/cli_bridge/`, `cli/src/handoff/`, `components/settings/cli-bridge/`). (2) Write a new
ADR (next free number — **0077** at time of writing; re-check `ls docs/content/docs/en/adr` and
take max+1) recording the two-server split (cli_bridge loopback/dev-token vs companion_api
mobile/device-JWT), the desktop→CLI push, the bidirectional transcript handoff, and the forked-store
/ shared-code invariant. (3) A bilingual subsystem page under `docs/content/docs/{en,zh}/` via the
`subsystem-docs` skill.

**Verification.** `pnpm docs:build` green. Add the route list + the "12 dev routes" count to a test
so the doc cannot silently rot (parity-plan N8 lesson).

**Changeset:** no (docs).

---

## 3. Refuted / dropped — do NOT put these in the plan (the adversarial pass killed them)

Each was a candidate optimization that **did not survive** re-verification. Recorded so the next
audit does not rediscover them as news.

- **G1 "interop is one-way GUI→CLI, a defect" → REFUTED (intentional-correct).** The
  desktop-independence is documented **at the type**: `cli/README.md:8-9` and `cli/src/config/schema.ts:1-9`
  ("The CLI is desktop-independent: it never reads the desktop's IndexedDB or OS keyring"). A reverse
  config/credential sync would be a source-of-truth + security **downgrade** (last-writer-wins over
  Settings; CLI plaintext creds into the OS keyring). Only the narrow read-only session-listing want
  survives → **L6**.
- **G2 "live-session teleport" → REFUTED (won't-fix).** Forked stores + each shell spawns its **own
  sidecar**; `sdkSessionId` lives in the minting sidecar and is deliberately stripped from the
  handoff (`handoff-cmd.ts:184-189`, `import-handoff-session.ts:11-13`). Continuing an in-flight
  streaming turn across two OS processes is architecturally precluded. The _feasible_ half is L2.
- **G5 "wire the CLI to the ~250-method companion RPC surface" → REFUTED (non-gap).** Documented
  threat-model separation (`src-tauri/src/cli_bridge/mod.rs:5-13`): companion_api is the **mobile,
  device-JWT, LAN** surface; cli_bridge is the **local, loopback, dev-token** surface. Pointing the
  CLI at the device-JWT surface would be actively wrong. (The "~250" is an overcount; ~120–150 arms.)
  The correct extension is a **new loopback route** (as `twin/context`/`teams/*` already are); the
  `/acp/token` endpoint is the deliberate single-purpose broker when device-scope is genuinely needed.
- **G6 "/team run should live-stream" → REFUTED (intentional + already a written non-goal).** Poll
  already delta-streams events since `sinceTs` at 1.5s (`team-controller.ts:196-228`); runnable teams
  live in the renderer store, unreachable from the CLI process (`agent-team.ts:4-8`); streaming would
  need a **brand-new SSE/WS channel** the loopback server does not have. The external-hosting plan §6
  explicitly says "team execution stays renderer-only; do not conflate with the hosting path."
- **G8b "themes forked" → REFUTED (non-gap).** GUI = 143 oklch web tokens; CLI = 7 terminal-neutral
  Ink roles. Apples-to-oranges; the CLI already reuses sibling **terminal** agents (claude-code/codex)
  by design, not the web GUI (`cli/src/tui/theme/resolve.ts:116-134`). An accent/light-dark bridge is
  a marginal optional footnote, not a gap.
- **G8c "MCP excluded from auto-sync" → REFUTED (non-gap; premise inaccurate).** Documented
  per-server leak control (`auto-push.ts:5-8`), and the "chips-only" premise is **wrong**: the manual
  "Sync now" already bulk-pushes MCP honoring per-server opt-in (`cli-sync-card.tsx:3-8` →
  `push-to-cli.ts:65-70`). Two affordances already exist.

---

## 4. Open decisions — DO NOT decide silently

- **D1 — L3 fleet: suppress the ghost, or promote `cognia-agent` to a first-class fleet agent?**
  Ship suppression now (cheap bug fix). Promotion is a bounded ~6–7-point feature; decide it as a
  separate scope, don't fold it into the suppression commit.
- **D2 — L4 `cognia-agent` binary discovery:** presence-gate (recommended) vs `npx` fallback vs
  PATH-weave/bundle the npm bin. Determines whether "Open in terminal" is always-available.
- **D3 — L5 chatgpt-mode Codex vault:** ship only the api_key slice (recommended), or invest in
  CLI-side Codex OAuth-refresh (schema + refresh loop) so ChatGPT-login users get single-login on
  the CLI too? Likely defer the OAuth half.
- **D4 — L6:** is passive CLI-session listing in the GUI worth a bridge route + list surface, or is
  explicit handoff sufficient? Read-only only if built.

---

## 5. Suggested order

1. **L1** — rank/status only; it unblocks the whole "TUI as capable as GUI" thesis and is one alias
   from shipping. Execute via the external-hosting plan.
2. **L3 (suppression)** — surgical, safe, removes a live cosmetic bug. Independent of everything.
3. **L2** — additive handoff fidelity, zero wire change. Independent.
4. **L5 (api_key slice)** — small, closes a real single-login gap for API-key Codex users.
5. **L4** — needs D2; modest UI + compose once decided.
6. **L7** — cheap doc truth; every later linkage audit reads it. Do early if touching the area.
7. **L6** — only if D4 says yes.

**One commit per item.** L2 / L3-suppression / L5 / L7 are independent of each other and of L1.

---

## 6. Provenance

Four parallel read-only tracks on 2026-07-16 (code-reuse seam · live coordination bridges · shared
data/config/session · external-agent hosting state), then a **three-track adversarial refutation
pass** that tried to break each candidate optimization. **3 of 8 candidates were refuted** (G1-blanket,
G5, G6, G8b, G8c fell; G1 and G2 each split into a surviving sliver + a refuted half) — see §3.
Evidence read end-to-end includes `lib/cli-bridge/*`, `src-tauri/src/cli_bridge/{mod,server,handlers,
renderer_bridge}.rs`, `src-tauri/src/{fleet,companion_api}/*`, `cli/src/{handoff,twin,team,hooks}/*`,
`cli/src/runtime/external/*`, `lib/chat/{export-handoff-to-cli,import-handoff-session}.ts`,
`lib/inbox/extract-plain-text.ts`, `lib/subscription/codex/chat-bridge.ts`,
`components/desktop/session-row.tsx`, `crates/cognia-terminal/src/*`, and the two prior TUI plans.
Builds on ADR-0050 (cli-tui), 0059 (headless brain + `agent-transport.ts` host seam), 0061
(cross-device), 0064 (external-CLI dispatch). Nothing was written to the repo besides this file.
