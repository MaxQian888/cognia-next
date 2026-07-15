# TUI Audit — Remediation Plan (2026-07-15)

**Status:** none of this is implemented. Every finding below is a verified defect or a
verified gap in `cli/` (the CLI/TUI, ~43k LOC under `cli/src/tui`), plus a repo-wide
documentation failure (W3).

**Origin:** a five-dimension read-only audit (dormant wiring / performance / test health /
resilience / feature parity). Feature parity came back **zero gaps** — do not spend effort
re-checking Claude Code affordances (see §7).

---

## 0. How to use this document

Each work item is a self-contained unit: problem → evidence → fix → verification. Items are
independent unless a **Depends on** line says otherwise. Take them one at a time, one commit
each.

### 0.1 Confidence labels — read this before you touch anything

Every claim carries a label. **They are not decoration.** The whole point of this audit was
that unverified claims had been circulating as fact for weeks.

| Label           | Meaning                                                                         | What you must do                                                                                              |
| --------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **[CONFIRMED]** | Read end-to-end by the audit lead against the actual files; file:line checked.  | Trust it, but the line numbers may drift — re-locate by symbol, not by line.                                  |
| **[AGENT]**     | Verified by a subagent with evidence, not independently re-checked by the lead. | **Re-verify the specific claim before you act on it.** Especially benchmark numbers and coverage percentages. |
| **[OPEN]**      | Genuinely unresolved. Needs a human/maintainer decision.                        | **Do not decide it silently.** See §6.                                                                        |

### 0.2 Evidence standard (non-negotiable)

This audit's most expensive lesson: **a search can return an empty result that looks exactly
like a genuine "zero matches" but is an artifact.** It happened in three distinct forms and
bit four different actors, including the audit lead:

1. **bash `grep -r` hits the 120s timeout** on this repo → returns empty. Nearly produced
   "desktop memory recall is dead too" (false — 13 files use it).
2. **`-i` case-insensitive matching** → `lsp` matched `credentia|lsP|ath`, burying real hits.
3. **Pagination cap reads as absence** → a `head_limit: 20` sweep reported "5 stale pointers";
   the uncapped answer was **~45**, and of a different character entirely.

**Rules:**

- Use the **Grep tool (ripgrep)**, never bash `grep -r`, for anything repo-wide.
- On sweeps, pass **`head_limit: 0`**.
- **Every claim that something does not exist must carry a positive control**: run the same
  pattern, same tool, somewhere you _know_ it hits. If the control returns nothing, your tool
  or pattern is broken and the empty result is meaningless.
- **Any absence claim derived from a truncated or timed-out result is void.** Re-run it.

### 0.3 Repo gates that apply to every item

From `CLAUDE.md` — these are hard rules, not suggestions:

- **Co-located tests.** Any new/changed file under `components/**`, `hooks/**`, `lib/**`,
  `cli/src/**`, `src-tauri/src/**` needs a co-located `*.test.ts(x)`. Coverage ≥90%.
- **No simplifications.** Do not stub or "TODO later" a production path. If an item can't be
  done as specified, stop and surface the blocker.
- **i18n.** No hard-coded user-facing strings in `.tsx`; keys go in **both** `en.json` and
  `zh-CN.json`. (Mostly N/A here — the TUI is not next-intl wired — but W3 touches docs.)
- **Changeset.** Every user-facing change: `pnpm changeset`, package `cognia-next`. Marked
  per item below. Internal-only (tests, docs, chore) skips it.
- **Never `--no-verify`.** Hook fails → fix the cause, re-stage, new commit.

### 0.4 Tooling traps specific to this work

- **`rtk` masks jest/vitest exit codes** — it returns 0 even when suites fail. For any test
  gate, run **`npx jest <paths>`** directly and read the `Test Suites:` line yourself.
- **Full-suite parallel runs produce false failures** that pass in isolation. Re-run any
  failing suite in isolation before believing it.
- **Windows CRLF:** the Edit tool inserting LF lines into a CRLF file makes
  `prettier --check` fail the whole file. Do not run `prettier --write` on files another
  session may be editing — only on files you exclusively own; `lint-staged` normalizes at
  commit time.
- **Concurrent sessions share this working tree.** Verify before trusting a "modified"
  snapshot; see the `concurrent-tree-safety` skill.

---

## 1. Phase 0 — Restore the test gate (DO THIS FIRST)

**Why first, and why it is not busywork.** Six suites have been permanently red. Five of them
are one-line stale assertions. That trained everyone — humans and agents — to read red as
noise. Two serious defects (W1, the `serve` boot crash, and W2, the database-wiping seam) sat
in plain sight the whole time. `serve-command` was **dismissed as "a test timeout" three
separate times**, including once during _this_ audit. Restoring a truthful gate is the
precondition for everything else; it is worth ~10 lines.

### T1 — `logto-session.test.ts`: hard-coded POSIX path [AGENT]

- **File:** `cli/src/config/logto-session.test.ts:51`
- **Problem:** test hard-codes `/home/u/.cognia/logto.json`. Production `logtoSessionPath`
  correctly uses `path.join`, so this is **test-only** — the product is right.
- **Fix:** build the expected value with `path.join` so it holds on both separators.
- **Note:** this is the _only_ real path-separator failure. The label "Windows path
  separator" was applied to ten unrelated failures and normalized them. Don't reuse it.
- **Changeset:** no.

### T2 — Context-window drift: 3 suites, 1 root cause [AGENT]

- **Files:** `cli/src/tui/format/model-meta.test.ts:12`,
  `cli/src/tui/format/status-bar.test.ts:98`,
  `cli/src/tui/runtime/status-controller.test.ts:70`
- **Problem:** `DEFAULT_CONTEXT_WINDOW` went 200k → 128k (`lib/claude/usage.ts:33`). **The
  128k is deliberate and documented** (`lib/claude/usage.ts:25-33`: a conservative floor so
  auto-compact fires early instead of overflowing a real 128k model). The tests are stale;
  the product is correct. 100k tokens = 50% of 200k but 78% of 128k — hence three failures.
- **Fix:** update the three assertions to the 128k basis. `status-controller.test.ts:69` also
  carries a stale comment (`→ 200k default → 50%`) — fix the comment too.
- **Do NOT** "fix" this by changing `usage.ts` back to 200k.
- **Changeset:** no.

### T3 — `mention/providers.test.ts`: built-in agent list grew [AGENT]

- **File:** `cli/src/tui/mention/providers.test.ts:249`
- **Problem:** stale — built-in agents now include `Explore` + `Plan`.
- **Fix:** update the expectation.
- **Changeset:** no.

### T4 — `limits-data.test.ts`: GLM — stale, **not** a regression [AGENT]

- **File:** `cli/src/tui/runtime/limits-data.test.ts:212-213` (assertion at `:220`)
- **Verdict: users did not lose GLM metering. They gained it.** This test is the last
  surviving artifact of a **fabricated** data shape.
- **Evidence:** `TOKENS_LIMIT: "five_hour" | "weekly"` was never a real Zhipu field. Commit
  `213e4a722` (2026-06-24) says so verbatim: the real `data.limits[]` tag is a numeric `unit`
  (3 = 5h, 6 = weekly), and with the fabricated discriminator "windows came up empty" — i.e.
  GLM metering was _already broken_. The CLI test was written 2026-06-21 (`9cdcc9165`) against
  the same fabrication, so it passed only because test and product were wrong together. The
  fix touched only `lib/subscription/**` and never updated this test. **It went red because
  the product got corrected.**
- **Fix (2 lines, test-only):** `{TOKENS_LIMIT:"five_hour"}` → `{unit:3}`,
  `{TOKENS_LIMIT:"weekly"}` → `{unit:6}`.
- **Do NOT** change `limits-data.ts`. The CLI wiring is sound:
  `limits-data.ts:31` `DEFAULT_BASE_URLS["glm"]="https://api.z.ai"` matches
  `catalog.ts:49 { providerKey:"glm", baseUrlIncludes:"api.z.ai" }`; `engine.ts:230` sets
  `provider: descriptor.id`, so the `mapCliProvider("glm")→"opencode"` red herring does not
  bite (same mechanism is why `stepfun` passes an identical check). `catalog.test.ts:62-91`
  already proves `{unit:3}/{unit:6}` → `["session","weekly"]` and is green.
- **Changeset:** no.

### T5 — Dexie cold-start timeouts (2 suites) [AGENT]

- **Files:** `cli/src/serve/durability.test.ts`, `cli/src/agent/subagent-background-tasks.test.ts`
  (also `plugin-runtime.integration`)
- **Problem:** 5s Jest timeout on cold `fake-indexeddb`/Dexie. Load-dependent: they pass in
  isolation. Environment, not product.
- **Fix:** raise the timeout for these suites.
- **Caution:** the two audit agents reported different totals (7 vs 11 failing suites)
  precisely because these are load-dependent. That's expected; don't chase it.
- **Changeset:** no.

### T6 — **`serve-command.test.ts` is NOT a timeout — it is W1** [CONFIRMED]

- Do not touch it here. It goes green when **W1** is fixed. See §2.

**Phase 0 exit criteria:** `npx jest cli/src` → 0 failing suites (with W1 done). Record the
`Test Suites:` line in the commit body.

---

## 2. Phase 1 — P0 defects

### W1 — `cognia-agent serve` crashes at boot [CONFIRMED]

**Severity: P0.** This is the ADR-0059 headless/cloud target. It does not start.

**Blast radius:** process abort at boot. Also compounds W2 — an abort can land mid-flush,
producing the truncated `db.json` that W2 then silently wipes.

**Mechanism (verified end-to-end):**

1. `lib/headless/node-indexeddb.ts:51` — `if (typeof g.window === "undefined") g.window = g`
   shims `window` to the bare global so Dexie works in Node.
   Its own docstring (`:43-46`) **explicitly acknowledges the hazard**: _"With `window`
   shimmed to the bare global, `typeof window` checks route lib modules onto their browser
   paths, where some reach for Web Storage — shim those too"_. The author patched
   `localStorage`/`sessionStorage`. **`addEventListener` was not patched.**
2. `lib/connectors/bootstrap/resume-reconnect.ts:77` —
   `windowTarget = typeof window !== "undefined" ? window : undefined` → resolves to
   `globalThis`.
3. `:91` — the `if (!windowTarget && !documentTarget)` bail-out does **not** fire, because
   `globalThis` is truthy.
4. `:133` — `windowTarget?.addEventListener("online", onOnline)`. **`?.` guards nullish, not
   "object exists but lacks the method."** Verified on Node v24.18.0:
   `typeof globalThis.addEventListener === "undefined"` → **TypeError**.
5. The call sits inside `void (async () => { … })()` (opens `install-connector-runtime.ts:323`,
   closes `:558`; the throwing line is `:528`) with **no `.catch`** → unhandled rejection.
6. `lib/headless/bootstrap.ts:37`'s try/catch only sees the synchronous return, so it cannot
   catch it. And `serve` never installs `installProcessCrashGuards` (only `mount.tsx:50`
   does) → Node's default `--unhandled-rejections=throw` aborts the process.

**The house pattern already exists** — `resume-reconnect.ts` is the outlier:

- `lib/browser/agent-activity.ts:24` —
  `if (typeof window === "undefined" || typeof window.addEventListener !== "function")`
- `lib/tauri/transport-companion.ts:952` — same shape.

**Fix (~4 lines):** adopt the `agent-activity.ts:24` guard in `resume-reconnect.ts`. Feature-
detect the _method_, not the object. Do not "fix" this by removing the `window` shim — Dexie
needs it.

**Also fix (do not skip):** add a `.catch` to the `void (async () => …)()` at
`install-connector-runtime.ts:323-558`. A floating async IIFE with no catch is how a
recoverable error became a process abort. **Consider** installing `installProcessCrashGuards`
on the serve path too — but see the caveat in W6 (a guard that only logs and shows nothing is
its own problem).

**Verify:**

1. `npx jest cli/src/serve/serve-command.test.ts` → green (it currently fails in ~11.3s with
   a deterministic `TypeError: windowTarget?.addEventListener is not a function`, **not** a
   timeout; it fails in isolation under `--runInBand --forceExit`).
2. Actually boot it: `cognia-agent serve` must reach ready without aborting. A green unit test
   is not sufficient evidence here — this bug's entire history is people trusting the wrong signal.

**Tests:** add a regression test that runs the resume-reconnect path with `window` shimmed to
a bare global (no `addEventListener`) and asserts it degrades instead of throwing.
`resume-reconnect.test.ts:128` already exercises `{windowTarget: undefined}` — the new case is
"present but method-less", which is the case that actually ships.

**Changeset:** yes — `patch`.

**Follow-up sweep [OPEN-ish]:** the shim's blast radius is real. There are 29 occurrences of
`typeof window !== "undefined"` across 26 `lib/` files. Only sites that then call a DOM method
break. **One break is confirmed (this one).** `lib/capacitor/network.ts:77-78` does an
unguarded `window.addEventListener("online"/"offline")` — same shape, but **headless
reachability was not verified**, so it is a candidate, not a finding. Sweeping those 26 files
is warranted as separate work.

---

### W2 — `db.json` is written non-atomically; a truncated read silently wipes the DB [CONFIRMED]

**Severity: P0 — silent, total, unrecoverable data loss.**

**Mechanism (every line read):**

1. `cli/src/db/bootstrap.ts:77-82` — the default writer is
   `fs.mkdirSync(...)` + **`fs.writeFileSync(p, data, { mode: 0o600 })`**. `writeFileSync`
   truncates in place. The flush is debounced at **400ms** (`:72`), so writes are frequent.
   Kill the process mid-write (kill -9, OOM, power loss, lid) → truncated JSON on disk.
2. `cli/src/db/snapshot.ts:53-57` — `JSON.parse` throws → `catch { return null }`.
3. `snapshot.ts:51` — `if (!text) return null`. **A corrupt file and a missing file return the
   identical value.** The caller cannot distinguish catastrophe from first-run.
4. `bootstrap.ts:93-94` — `const snapshot = parseSnapshot(read(file)); if (snapshot) await
restoreSnapshot(db, snapshot)`. `null` → restore silently skipped → DB stays empty/seeded.
5. Any later `flush()` (`bootstrap.ts:97-105`) serializes the now-empty DB and **overwrites
   the file** — destroying the corrupt-but-possibly-salvageable original.

**What is lost:** sessions, goals, teams, memory, checkpoints. **Mitigating:** chat transcripts
live separately at `~/.cognia/sessions/<id>.jsonl` and are append-based
(`cli/src/agent/transcript.ts:33`), so conversation text usually survives.

**The repo already knows the correct idiom** — it was simply never applied to the one file
that matters most: `cli/src/tui/crash-log.ts:75` and `cli/src/tui/runtime/mcp-log-file.ts:62`
both handle the Windows rename-over-existing trap correctly.

**Fix (S+M), three parts — all three are required:**

1. **Atomic write:** write to `<file>.tmp`, `fsync`, then `rename` over the target. Follow
   `crash-log.ts:75` for the Windows rename-over-existing behavior.
2. **Keep one `.bak` generation** on successful write.
3. **Refuse to overwrite after a failed parse.** `parseSnapshot` must distinguish _absent_
   from _corrupt_ (return a discriminated result, not `null` for both). On corrupt: rename the
   file aside (`db.json.corrupt-<n>`), surface an **error cell** to the user, and **do not
   flush over it**.

**Why part 3 is the important one:** parts 1–2 reduce the chance of corruption. Part 3 is what
stops corruption from becoming _silent deletion_. Do not ship 1–2 only.

**Tests (this is the gap that let it hide — see C1):**

- `bootstrap.test.ts` currently has exactly three restore cases: valid (`:78`), no-snapshot
  (`:86`), idempotent (`:70`). **There is no corrupt case.**
- Worse, `:86` ("leaves seeded rows in place when there is no snapshot file") asserts
  `goals.rows === [{id:"seed"}]` — **the exact same observable outcome a corrupt snapshot
  produces**. The catastrophic case is behaviorally indistinguishable from the benign one, and
  in the benign case overwriting is _correct_. That is why the design reads as safe.
- Add: `readSnapshot: () => '{"version":82,"tabl'` (truncated) → assert **flush does not
  clobber the file** and an error surfaces.
- `parseSnapshot` itself is correctly unit-tested (`snapshot.test.ts:74-78` asserts null on
  invalid JSON). **The unit is fine; the defect is at the composition seam.** This is why 97%
  line coverage missed it — every line is covered.

**Changeset:** yes — `patch`.

---

### W3 — The PII gate's entire documentation trail points at a deleted file [CONFIRMED]

**Severity: P0 (integrity of a security invariant), cost S.**

**Fact:** `lib/twin/ingest/redact.ts` **does not exist**. ADR-0068 (E1) extracted it to the
workspace package `@cognia/redact`. The gate now lives at:

- `packages/redact/src/index.ts:392` — `hasNoLeakingPii`
- `packages/redact/src/index.ts:235` — `redactText`
- `packages/redact/src/index.ts:431` — `hasNoLeakingPiiDeep`
- The test moved too: `packages/redact/src/index.test.ts`.

**Why this is P0 and not a doc nit:** `.claude/agents/pii-gate-auditor.md:9` instructs the
repo's designated PII auditor to grep for the old path. Per this repo's own
`docs/plans/2026-07-09-tutti-inspiration-verified-optimizations.md:91`: _"Enforcement today is
**only** the `pii-gate-auditor` LLM subagent (advisory, not in CI)."_ **The only enforcement
mechanism for the stated privacy red line now aims at a file that isn't there.** It does not
error — it just finds nothing and reports clean. A silently-passing security audit is worse
than no audit, because it emits a false green.

**Scope: ~45 stale pointers** (uncapped ripgrep; a capped sweep reported 5 — see §0.2).

**⚠️ Precision — do not blind-replace `twin/ingest`:** `lib/twin/ingest/redaction-key.ts`
**still exists** and its ~20 references are **valid**. Only the `redact.ts` half is stale. Each
hit must be classified individually.

**Sites to fix (grouped):**

- **Governance (highest priority):** `.claude/agents/pii-gate-auditor.md:9`,
  `.claude/agents/analyze-ai-infra.md:36`, `.claude/skills/doubt-driven/SKILL.md:26`,
  `CLAUDE.md:166` (first clause only — the `redaction-key.ts` clause stays), `WORKFLOW.md:98`
- **Production source comments documenting the invariant** (deepest infiltration — these are
  what a future reader/auditor greps): `lib/agent/plan/pii-gate.ts:8`,
  `lib/plugin/api/plugin-pii-gate.ts:5`, `lib/plugin/agent-sdk/pii-gate.ts:6` (_the three gate
  files' own docstrings_), `lib/skills/built-in/dispatcher.ts:10`,
  `lib/native/crash-context.ts:18`, `lib/logging/transports/agent-trace-transport.ts:18`,
  `lib/external-bridge/handlers/orchestration.ts:30`, `lib/goal/redact-objective.ts:3`,
  `lib/workflow/definition/templates/inbox-triage-twin.ts:10`,
  `packages/logging/src/types/bootstrap.ts:39`, `types/agent-trace/span.ts:113`,
  `types/twin/index.ts:104`, `hooks/builtin/pii-safety-guard.mjs:5`,
  `src-tauri/src/crash/context.rs:43`
- **Docs/ADRs:** ADR-0003 / 0019 / 0032 / 0059 (en + zh), `README.md:201`, `README_zh.md:196`,
  the `employee-twin` doc set (en + zh). Note `employee-twin.mdx:357` calls
  `lib/twin/ingest/redact.test.ts` _"the most safety-critical test in the whole repo"_ — that
  file isn't there either.
- **Ignore:** `.VSCodeCounter/**` (historical snapshots),
  `components/chat/message-parts/mcp-renderers/grep-card.stories.tsx:43` (fixture data).

**Fix:** update each pointer to `packages/redact/src/index.ts` (with the symbol). For
`pii-gate-auditor.md`, also make it grep for `@cognia/redact` imports rather than a file path,
so a future extraction can't silently decapitate it again.

**Strongly consider (separate item, needs a decision):** if the gate is a red line and its only
enforcement is an advisory subagent, that is a structural weakness independent of the stale
pointer. A CI grep asserting every LLM/embed call site routes through `@cognia/redact` would
make the invariant enforceable. **Do not build this without asking** — it's a scope call.

**Changeset:** no (docs/config only).

**Verified PII contract, for whoever touches this** — established during the audit, worth
recording so it isn't re-litigated:

- **Extraction gating is intrinsic, not caller-imposed.** `run-memory-extraction.ts:85` does
  `const redact = deps.redact ?? ((t) => redactText(t).redacted)` **inside the pure
  orchestrator** — a caller cannot skip it by omitting deps. Every input is redacted before
  `deps.extract` (`:87-92`), and `deps.isPiiSafe ?? hasNoLeakingPii` (`:97-98`) drops unsafe
  candidates before persistence. Two intrinsic gates. `provenance === "inbound"` is never
  auto-extracted (`:73`).
- **Recall applies no PII gating** — stored text goes verbatim into the system prompt
  (`apply-memory-context.ts:129`). The design leans entirely on write-time gating.
- **Manual capture bypasses the gate — identically on both shells.** CLI `/remember`
  (`memory-controller.ts:76`) and desktop console (`components/memory/memory-console.tsx:260`)
  both call `createMemory` directly. So wiring CLI recall (W5) **adds no PII surface the
  desktop doesn't already have.**
- `connectors/runtime.ts:601`'s `embedSafe` guards the **recall query** (stopping third-party
  inbound text reaching a cloud embedder). It is **not** the extraction gate.
- **[OPEN]** Whether ungated manual capture is deliberate. `store-memory.ts:13-21` says _"The
  PII gate is mandatory"_ under "Trust model (ADR-0069)", which reads universal but is
  contradicted by both manual-capture call sites. ADR-0069:66 scopes the block gate to
  _"external stores and text updates"_, which suggests deliberate — but no ADR sentence
  explicitly blesses it. Does not block W5 either way.

---

## 3. Phase 2 — Dormant wiring (built-but-dormant: this repo's signature defect)

### W4 — `autoRoute` never survives config resolution [CONFIRMED]

**Severity: P1. Cost: one line (+ a structural fix worth doing).**

**Problem:** `autoRoute` is the **only one of 50 top-level config-schema keys** that
`applyLayer` never copies. `resolveConfig()` therefore always returns it `undefined`.

**Evidence:**

- `cli/src/config/load.ts:145-147` — `applyLayer` builds a **fresh object literal** with **no
  `...acc` spread**. Any key it doesn't name is dropped outright.
- `autoRoute` has **zero hits in `load.ts`**. Positive control: `terminalTitle|vim:|webTools`
  in the same file → hits at `161, 192, 193`. The absence is real.
- Producers exist: `cli/src/tui/commands/route-command.ts:32`,
  `cli/src/tui/runtime/settings-sections.ts:509-515`, `cli/src/config/mutate.ts:318`
  (`BOOLEAN_FLAG_KEYS`).
- Consumers exist: `cli/src/config/to-build-context.ts:267` and `:313`.
- Declaration: `cli/src/config/schema.ts:653`; `ResolvedConfig` at `:885`.

**User impact:**

- **One-shot `cognia-agent run` — auto-routing has never worked, at all.** This is the
  feature's _documented primary use case_ (`schema.ts:650`: _"a one-shot/headless `run` scores
  the prompt's difficulty and routes it to the cheapest capable tier"_). Prompts silently keep
  hitting the expensive default model. Pure cost burn, zero signal.
- **TUI** — works until restart, then silently reverts: `SET_CONFIG_PATCH`
  (`cli/src/tui/state/reducer.ts:1152`) shallow-merges straight into `state.config`, bypassing
  `applyLayer`, so the live session honors it. Next launch drops it, and the settings panel
  reads back "off" while `config.json` says `true`.

**Fix (immediate, 1 line):**

```ts
autoRoute: layer.autoRoute ?? acc.autoRoute,
```

in `applyLayer`, plus a regression test in `load.test.ts`.

**Fix (structural — this is the item that actually matters):**

The root cause is not that someone forgot a key. **`ResolvedConfig.autoRoute` is optional
(`schema.ts:885`), so omitting it from `applyLayer`'s literal is legal TypeScript and compiles
clean.** `terminalTitle` (`schema.ts:947`) is optional too — that is exactly how the previous
instance of this bug survived. **It will keep recurring** until `applyLayer`'s return is
structurally forced exhaustive.

**This has in-repo precedent — the fix aligns the outlier with what five siblings already do:**

| Function                                                        | Shape                                             | Why it's safe                                                                                                               |
| --------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `resolveGitWorkflowConfig` (`schema.ts:456-469`)                | **Same enumerated-literal shape as `applyLayer`** | Target `ResolvedGitWorkflowConfig` (`:433-438`) declares all four fields **required** → omitting one is a **compile error** |
| `resolveCliLoggingConfig` (`schema.ts:225`)                     | spread merge                                      | + target all-required (`:208-212`)                                                                                          |
| `resolveRenderConfig` (`schema.ts:472-473`)                     | spread merge                                      | + `ResolvedRenderConfig = Required<RenderConfig>` (`:390`)                                                                  |
| `resolveNotices`                                                | spread merge                                      | + `ResolvedNotices = Required<NoticesConfig>` (`:290`)                                                                      |
| `mergeHookConfigs` (`cli/src/hooks/load-hooks.ts:26-35`)        | key-driven loop over `HOOK_EVENTS`                | new events flow through automatically                                                                                       |
| `buildChildConfig` (`cli/src/agent/subagent-runner.ts:131-137`) | `...config` spread                                | subagents inherit every optional field                                                                                      |

`applyLayer` + `ResolvedConfig` is **the only place in the CLI** combining an enumerated literal
with an optional-field target. Make the layerable keys required (`Required<Pick<…>>`) or convert
`applyLayer` to a key-driven merge. **This is not a new convention — it's making the one outlier
match the other five.** It should be an easy review.

**Why the tests missed it — fix this too:** `load.test.ts` contains **zero** occurrences of
`autoRoute`, while `to-build-context.test.ts:462-487` tests the consumer by constructing
`cfg({ autoRoute: true })` **directly**, bypassing the loader. **Both ends well-tested; the
broken link in the middle untested.** Add loader-level coverage that asserts a `config.json`
value survives `resolveConfig()`.

**Changeset:** yes — `patch`.

---

### W5 — CLI long-term memory is write-only: `/remember` is never recalled [CONFIRMED]

**Severity: P1. Cost: M.**

**Problem:** `lib/claude/build-options.ts:1439` gates memory injection on
`ctx.memoryDeps && ctx.memoryUserMessage && ctx.memoryUserMessage.trim()`. **`cli/` has zero
references to either** (positive control: the same pattern hits 6× in `build-options.ts` at
`:414, :420, :1439, :1446, :1456`, and 13 files repo-wide). **The gate is always false for
every CLI turn.**

Surfaces that do wire it: `hooks/chat/use-claude-chat.ts:1837-1838`,
`hooks/chat/use-team-chat.ts:952-953`, `lib/connectors/runtime.ts:600-601`,
`lib/connectors/scheduled-outbound.ts:264-265`, plus `hooks/pet/use-pet-speak.ts` and
`hooks/pet/use-pet-proactive.ts`. **CLI/TUI: nothing.**

**User impact:** memory ships **on by default** (`enabled: true`, `autoExtract: true` —
`types/memory/memory.ts:145-146`; `resolveMemoryConfig` spreads those defaults when
`settings.memory` is undefined). The TUI advertises `/remember`
(`cli/src/tui/commands/cognia-commands.ts:182-187`) and confirms `Remembered: …`
(`cli/src/tui/runtime/memory-controller.ts:84`). A user types
`/remember I deploy with pnpm, never npm`, sees success, and it **never affects anything —
not that session, not any future one.** An inbound Feishu message recalls your memories; your
own terminal session does not. This is a silently broken user-facing promise.

**The core API is ready — nothing needs building:**

- `tryBuildMemoryDeps(config)` — `lib/memory/runtime/build-deps.ts:62`. Base deps are **pure
  Dexie reads** (`listActiveForReader` / `listActiveProcedural` / `touchMemories`, wired at
  `:68-72`) — the same module `memory-controller.ts:7` already imports.
- **No embedder required.** `resolveMemoryBackend` failure → `catch {}` → BM25-only
  (`build-deps.ts:89-91`). The keyword leg is _"always available"_
  (`lib/memory/retrieve/retriever.ts:279-284`) and passes through un-fused when the vector leg
  is absent (`:322-325`).
- `applyMemoryContext` — `lib/memory/runtime/apply-memory-context.ts:85`.
- The CLI **already reuses the desktop assembly** (`cli/src/agent/run.ts:5`:
  _"config → toBuildContext → resolveSendOptions (REUSED desktop assembly)"_).
- The CLI **already has Dexie** — `ensureCliDb()` (`cli/src/db/bootstrap.ts`).

**Insertion seam:** `cli/src/agent/session-runner.ts` `send()` at `:439-466`, where the twin
block already does exactly this per-turn shape. Handshake to port
(`hooks/chat/use-claude-chat.ts:1785-1787`):

```ts
const memoryHandshake = userMessage?.trim()
  ? await tryBuildMemoryDeps(resolveMemoryConfig(appSettings?.memory), twinHandshake)
  : undefined
```

**Two real subtleties — this is why it's M, not S:**

1. **`ensureReady()` caches options once per session** (`session-runner.ts:296`, `if (!options)`).
   Recall is **query-dependent per turn**, so it must slot into the `send()` seam alongside
   `twinDynamic` — **not** inside `ensureReady`.
2. **`ensureCliDb()` is deliberately lazy.** Plain chat pays no DB cost today; it opens only
   when skills are enabled (`session-runner.ts:309-317`, with a graceful degrade). Memory-on-
   by-default makes every turn open the DB. **Follow the existing precedent:** try/catch →
   degrade to an ungrounded turn, never throw.

**PII:** no caller-side work needed. See the verified contract in W3.

**Changeset:** yes — `minor`.

**Depends on:** nothing. W6 and W7 get much cheaper once this lands (~80% shared wiring).

---

### W6 — `/memory search` is missing, and the stated reason is factually wrong [CONFIRMED]

**Severity: P1. Cost: S — the cheapest win in this section.**

**Problem:** `/memory` exposes only `list | add | show | delete`
(`cli/src/tui/commands/cognia-commands.ts:169-179`). `memoryList` calls `listMemories()`
unbounded (`memory-controller.ts:29`) — a flat, unranked dump against a
`maxActivePerScope: 500` store.

**The false premise (delete it):** `memory-controller.ts:1-6` justifies the omission —

> _"Semantic recall (RAG via `applyTwinContext`) needs an embedding provider + vector store the
> CLI can't reach, so v1 shows what's stored without similarity search."_

**Wrong on both clauses.** Search does not require embeddings — `retriever.ts:279` states the
keyword leg is _"always available"_, and `build-deps.ts:12-16` documents BM25-only degradation
as the **designed privacy default** (embeddings gated off unless local `transformersjs` or
explicit `allowCloudEmbedding`), so the desktop itself runs BM25-only for most users. And the
CLI _can_ reach the store — `memory-controller.ts:7` already imports `lib/db/memories`.

**The false premise leaks to users** as a misleading notice on every `/memory list`
(`memory-controller.ts:36-37`): _"Semantic recall is desktop-only; showing stored memories."_
Remove it.

**Core API is ready:** `searchMemoriesExternal` (`lib/memory/api/search-memory.ts:39`) is
**already the shared external surface** for plugin `ctx.memory.search`, MCP `memory_search`,
and companion RPC `memory_search`. Policy-aware (enforces `enabled`/`temporary`), returns typed
`{ok:false, reason}` for degraded cases, needs only `{query}`. A CLI caller is its fourth
consumer. Unaffected by W7's Zustand problem — it reads settings via `getSettings()` from
**Dexie** (`search-memory.ts:45-50`), which the CLI has.

**Fix:** one `rt("memory","search")` subcommand + a controller fn calling
`searchMemoriesExternal`, rendering hits into the existing select overlay. Delete the false
comment and the misleading notice.

**Why it matters beyond convenience:** this is the surface where a user **audits what the agent
has stored about them**. After a privacy scare ("what did it save?"), it's the first thing they
reach for. Today the only answer is scrolling a 500-row overlay.

**Changeset:** yes — `minor`.

---

### W7 — CLI never auto-extracts or maintains memory [CONFIRMED]

**Severity: P1. Cost: M** (revised up from S — see below).

**Problem:** `runTurnMemory` (per-turn extraction + episodic distill) is called only from
`use-claude-chat.ts:389` and `use-team-chat.ts:423`. It is the sole caller of
`scheduleMemoryMaintenance` (`lib/memory/run-turn-memory.ts:70-71`), which drives
decay/consolidation. Zero hits in `cli/`.

**Impact:** `autoExtract: true` is the default. On desktop, memory accrues automatically. In
the CLI the store only ever grows by explicit `/remember`, and **never decays or consolidates**
— so `decayHalfLifeDays: 30` and `maxActivePerScope: 500` are inert there.

**⚠️ The blocker is Zustand, not PII — and it fails silently:**

```ts
run-turn-memory.ts:40   const settings = useSettingsStore.getState().settings
run-turn-memory.ts:41   if (!settings) return
```

`useSettingsStore` has **zero hits in `cli/`** — the CLI has its own config system
(`cli/src/config/`). A naive `void runTurnMemory(...)` from the CLI **hits line 41 and returns
early, doing nothing.** It fails closed, so it is not dangerous — it is **inert**. Shipping it
that way would add a _second_ dormant feature while appearing to fix the first. That is exactly
the defect class this whole document is about. **Do not do it.**

**Fix:** thread `settings` through `runTurnMemory`'s input rather than reaching into Zustand.
The coupling is isolated to `runTurnMemory` itself — `buildAutoExtractionDeps` already takes
`appSettings` as a parameter (`run-memory-extraction.ts:127-129`), so this is the natural shape.
Alternative (CLI-side hydration of the store) is worse — it imports desktop state machinery into
the CLI for one field.

**PII:** extraction is intrinsically gated (see W3's verified contract). No caller-side work.

**Depends on:** W5 (shares ~80% of the wiring).

**Changeset:** yes — `minor`.

---

### W8 — Snapshot `version` is a dormant guard [CONFIRMED]

**Severity: P1. Cost: M.**

**Problem:** `cli/src/db/snapshot.ts:32` writes `version: db.verno` into every snapshot.
**Nothing ever compares it to anything.** `restoreSnapshot` (`:40-47`) overlays tables blindly.

**The subtle part:** `parseSnapshot:60` **does** check `typeof obj.version !== "number"` — but
that is a **shape check** (rejects a malformed file), **not a value comparison against the live
`db.verno`**. _That check is what makes the guard look present._

**Impact:** a snapshot taken at schema v10 restores into a v20 DB unchallenged. `fake-indexeddb`
starts empty → Dexie creates fresh at the latest `verno` → **no upgrade callback ever runs** →
old-shaped rows are injected raw into the new schema. The desktop's ~100 versioned
upgrade/backfill callbacks are all skipped for CLI data. Not a crash — quiet corruption.

**Evidence:** `verno` appears **only** at `snapshot.ts:17` (interface field), `:32` (the write),
and two test fixtures (`snapshot.test.ts:31-32`, `bootstrap.test.ts:32`). Never in a comparison.

**Fix:** compare `snapshot.version` to `db.verno`. If older, route through Dexie's upgrade path
or refuse + back up. **Do not silently bulkPut a version mismatch.** Coordinate with W2 — both
touch the same restore seam; consider doing them together.

**Changeset:** yes — `patch`.

---

### W9 — Dead `Overlay` union variants [CONFIRMED-ish, AGENT]

**Severity: LOW (dead code, no user symptom). Cost: S.**

- `cli/src/tui/state/types.ts:395` (`slash`) — zero producers, zero tests. **Unconditionally
  deletable.**
- `cli/src/tui/state/types.ts:396` (`files`) — no production producer; `reducer.test.ts:907`
  uses it purely as a vehicle to test generic `OVERLAY_MOVE` index navigation. Deleting the
  variant requires retargeting that one test line to another indexed overlay kind.
- Positive control: `kind: "inspect"` → `types.ts:451` + `reducer.test.ts:1471` + **two real
  producers** (`use-global-keys.ts:488`, `inspect-command.ts:16`) — proving the pattern finds
  producers when they exist.
- **Cost of leaving it:** misleads a reader into thinking composer completion popups route
  through the overlay system. They don't — `Input.tsx:330` declares its own independent
  `popupKind: "slash" | "mention" | "none"`.

**Changeset:** no.

---

## 4. Phase 3 — Performance

⚠️ **All numbers below are [AGENT] benchmarks** run against real Ink 7.1.0 in a scratchpad, not
a live TTY session. The _mechanisms_ were confirmed by the lead against the source; **the
timings should be re-measured before you use them to justify effort.** Benchmark scripts were
throwaway and are gone — expect to rebuild them.

### P1 — Large tool results are fully highlighted, then truncated to 20 lines [CONFIRMED mechanism]

**Best value/cost ratio in the entire document. Fix is moving one statement.**

**Mechanism** (`cli/src/tui/format/result-render.ts`, read directly):

```
:89   const rawLines = text.split("\n"); totalLines = rawLines.length
:98   const highlighted = highlightCode(text, lang, theme)   ← highlights the ENTIRE body
:103  const cap = maxLines && maxLines > 0 ? Math.min(maxLines, totalLines) : totalLines
:108  for (let i = 0; i < cap; i++) …                        ← only `cap` lines are ever used
```

Ten thousand lines are highlighted to display twenty. It also uses raw `highlightCode`, **not
`highlightCached`**, so it re-runs on every render.

**Measured [AGENT]** (faithful reproduction of `renderResultLines`, lang=typescript,
maxLines=20):

| lines  | current       | truncate-first | waste       |
| ------ | ------------- | -------------- | ----------- |
| 200    | 42.5 ms       | 3.08 ms        | 14×         |
| 1,000  | 317.1 ms      | 8.02 ms        | 40×         |
| 5,000  | 13,690 ms     | 3.22 ms        | 4,245×      |
| 10,000 | **22,828 ms** | **2.22 ms**    | **10,301×** |

**Trigger:** Ctrl+O detail mode (`use-global-keys.ts:477` → `TOGGLE_VERBOSE` → `applyVerbose`
at `Transcript.tsx:59-63`) expands **every** tool cell at once. Also expand-all
(`use-global-keys.ts:449`) or expanding one big cell. Tools are collapsed by default
(`reducer.ts:469`), which is why this stays hidden until someone presses Ctrl+O.

**The code already knows:** `CellView.tsx:291-292` computes `tooBig = totalLines > 200`, drops
`maxLines` to 20, and renders _"… N lines total — open full output: /expand"_. **The intent is
right; the order is backwards.**

**Fix (S):** move the `cap` slice **above** the highlight; highlight only the visible rows.
Route through `highlightCached` so repeats are O(1).
**Review caveat:** the comment at `:92` notes whole-body highlighting preserves multi-line
tokens. Since only `cap` lines are ever displayed, highlighting `cap + a small overlap` is
visually equivalent — but verify against a fixture with a multi-line template literal or block
comment straddling the cap boundary.

**Changeset:** yes — `patch`.

### P2 — Fullscreen transcript has no windowing [CONFIRMED mechanism]

**This is the default layout** — `DEFAULT_LAYOUT: LayoutMode = "fullscreen"`
(`cli/src/tui/layout-mode.ts:26`; `layout-mode.test.ts:8` pins it).

**The obvious diagnosis is wrong — this is why it survived prior rounds.** The React side is
already correct: `reducer.ts:345` (`INFLIGHT_TEXT`) returns `{...state, inflight}` preserving
`state.cells` identity, and `Transcript` is memoized (`Transcript.tsx:166`), so React _does_
skip reconciling on a delta. **Memoization cannot fix this — the cost is below React:**

- `ScrollView` clips via `overflow="hidden"` (`ScrollView.tsx:62`), but Ink's
  `renderNodeToOutput` **recurses into every child regardless of the clip**, calling
  `squashTextNodes` + `widestLine` per `ink-text` node. `output.clip()` only pushes a rect;
  off-screen writes are discarded in `Output.get()` — **after the work is done.**
- `renderer.js` builds a fresh `Output` every frame; no cross-frame memoization.
- `<Static>` is what makes scrollback O(1): it does `items.slice(index)`, dropping committed
  cells from the tree entirely, and `internal_static: true` makes `renderNodeToOutput` return
  immediately. Fullscreen has no `<Static>`, so it pays O(N) forever.

**Measured [AGENT]** (real Ink 7.1.0, stable cells identity so memo hits, root height-bounded
to 40 rows matching `App.tsx:1628`):

| cells | fullscreen (live) | scrollback (`<Static>`) | ratio  |
| ----- | ----------------- | ----------------------- | ------ |
| 100   | 10.66 ms          | 0.35 ms                 | 30×    |
| 250   | 19.91 ms          | 0.14 ms                 | 144×   |
| 500   | 96.61 ms          | 0.53 ms                 | 183×   |
| 1,000 | **370.93 ms**     | 0.27 ms                 | 1,384× |
| 2,000 | **554.67 ms**     | 0.11 ms                 | 5,138× |

Scrollback is flat regardless of N; fullscreen is superlinear. The paced reveal
(`use-paced-reveal.ts:38`, 24ms) targets ~42fps, so at 1,000 cells the loop is ~15× over
budget. Symptom: input lag + stuttering streaming scaling with transcript length. ~250 cells
perceptible, 500+ visibly laggy, 1,000+ ≈370ms per keystroke.

**Fix (M–L):** virtualize the live transcript. Cells are immutable, so height per
`(cell.id, width)` is stable and cacheable — the per-cell measurement machinery already exists
(`Transcript.tsx:21-39` `MeasuredCell`, `cursor.reportCellHeight`, currently gated to find).
Render only cells intersecting `[offset, offset+viewportHeight]`, padding with fixed-height
spacer Boxes so `useScroll`'s content-height math (`useScroll.ts:84-86`) is untouched.
**Cheaper stopgap (S):** cap the live column to the last ~300 cells.
`groupContextRuns` (`Transcript.tsx:132`) already folds tool bursts to reduce node count — a
partial mitigation, not a fix.

**Not attributed:** the per-frame cost was not split between Yoga layout and the
`renderNodeToOutput` walk (no TTY available). Windowing fixes it either way; if you want the
split before sizing, run `--cpu-prof` against a real session.

**Changeset:** yes — `patch`.

### P3 — CLI startup: ~1.7s of eager command imports [AGENT]

- **Hot spot:** `cli/index.ts:7-15` statically imports every subcommand. `handoff-cmd.ts:29`
  (`@/lib/chat/branch-session`) and `serve/serve-command.ts:24-28` (`@/lib/headless/bootstrap`,
  `@/lib/tauri`) transitively pull a 1.95MB chunk.
- **Measured:** `node dist/cognia-agent.mjs --version` = 1889 / 1987 / 2207 ms. Importing built
  chunks directly: `install-indexeddb` = 45ms, `main` (all commands) = **1720ms**. The boot
  chunk is fine (2.2KB); `entry.ts:18-28` already lazy-splits the sidecar role — the leak is one
  layer down.
- **Symptom:** ~2s before anything appears, on **every** invocation, including `--version` and
  `--help`.
- **Fix (S–M):** make the dispatch switch in `index.ts` `await import()` each handler,
  preserving the existing injection seam. **The codebase already uses exactly this pattern** at
  `chat.ts:119`: `deps.renderTui ?? (await import("../tui/mount")).renderTui`.
- **Caveat:** `cli/dist/` was last built 2026-07-02. Re-measure after a fresh build.
- **Unrelated but free:** that `dist/` has accumulated **838MB** of stale chunks. Worth deleting.
- **Changeset:** yes — `patch`.

### P4 — DiffView: uncapped, uncached, not gated on collapsed [AGENT]

- `cli/src/tui/components/CellView.tsx:224` —
  `{diff.length > 0 && <DiffView diff={diff} lang={diffLang} />}` has **no `collapsed` check and
  passes no `maxLines`** (only the permission prompt caps it). `DiffView.tsx:56` calls
  `highlightDiffText` **per line** → uncached `highlightLine` (`diff.ts:109`). `formatEditDiff`
  (`CellView.tsx:165`) also runs in the render body every render.
- **Measured:** 500 lines = 24ms, 1,000 = 45ms, 2,000 = 91ms **per render**. Capping to 40 lines
  = **1.6ms** (28–56×). Worth knowing: batching into one highlight call does **not** help
  (2,000 → 108ms, _worse_).
- **Fix (S):** pass `maxLines` from `ToolView` — DiffView already implements the cap +
  "… +N more" summary (`DiffView.tsx:28,60`) — and gate on `!cell.collapsed`. Memoize
  `formatEditDiff` on `cell.input`.
- **Changeset:** yes — `patch`.

### P5 — `CellView` is not memoized [AGENT]

- `cli/src/tui/components/CellView.tsx:517`. `Transcript.tsx:98-126` `renderCell` builds fresh
  elements for every cell. Appending cell N+1 (i.e. **every tool call**) re-runs every prior
  cell's render body — an amplifier for P1 and P4.
- `commitInflight` does `const next = [...cells]; next.push(...)` (`reducer.ts:206`) — existing
  cell objects **keep identity**, so a memo would bail out cleanly.
- **⚠️ Caveat that makes this non-trivial:** `applyVerbose` (`Transcript.tsx:59-63`) returns
  `{...cell, collapsed: false}`, **breaking identity every render in verbose mode** — so the
  memo would be dead in exactly the mode that needs it most (P1's trigger). Memoize that map or
  key the override off a stable flag. **A naive `memo()` here is worse than nothing** — it adds
  cost and buys nothing in the hot path.
- **Changeset:** yes — `patch`.

### Perf minor / suspected

- `use-paced-reveal.ts:56` — `shown` is in the deps, so every 24ms tick tears down and recreates
  the interval. Correct, just wasteful. (LOW, S)
- Ink's `wrapText` cache is unbounded (`node_modules/ink/build/wrap-text.js:3`) — SUSPECTED RSS
  growth over a long session. Not our code.
- `Markdown.tsx:186-190` — `stringWidth` per table cell, uncached. Bounded by table size.
- `ScrollView.tsx:57-59` measures every render — benign; reads already-computed Yoga values and
  `measure` no-ops on unchanged sizes (`useScroll.ts:56-60`).

---

## 5. Phase 4 — Resilience

### R1 — No signal handlers: SIGTERM/SIGHUP wrecks the terminal [AGENT]

- **Problem:** the TUI installs no SIGINT/SIGTERM/SIGHUP/`beforeExit` handler. A signal kills
  the process before any terminal restore or DB flush runs.
- **Repro:** `kill <pid>` from another shell, or `tmux kill-session`, while the TUI is fullscreen.
- **Blast radius:** `mount.tsx:102-119`'s `finally` never runs → terminal left in **alt screen,
  mouse tracking ON** (spewing raw escapes), bracketed paste on, custom title. Plus an unflushed
  DB and a possible mid-write truncation **feeding W2**.
- **Evidence:** ripgrep over `cli/src/tui` for
  `SIGINT|SIGTERM|SIGHUP|SIGBREAK|beforeExit|process\.on\(` → only 3 hits:
  `process-guards.ts:41` (uncaughtException), `:42` (unhandledRejection),
  `AppErrorBoundary.tsx:16` (a comment). **Zero signal handlers.** `cli/src/cli` → no matches
  (trustworthy: the identical pattern hit in `cli/src/tui` in the same batch).
- **The pattern exists in-repo:** `cli/src/serve/durability.ts:129-131` installs
  SIGINT/SIGTERM/beforeExit. The TUI never adopted it.
- **Fix (S/M):** install handlers that restore the terminal + flush + exit. Reuse
  `startDurability`'s shape.
- **Changeset:** yes — `patch`.

### R2 — `runTurn`'s catch can itself throw, wedging the session forever [AGENT]

- **Problem:** `turn-engine.ts` documents _"Never throws"_, but its catch does
  `(err as Error).message` (`:233`). A **non-object rejection** (`throw null`; some stream
  adapters) makes the **catch itself throw** a TypeError, escaping after `TURN_START` (`:196`)
  already set `turnStatus: "streaming"`.
- **Blast radius:** no terminal action dispatches → `busy` true forever (`App.tsx:383`) →
  composer permanently blocked. `useAgentSession.tsx:466` (`abortRef.current = null`) is skipped,
  so **Ctrl+C hits a dead controller and never dispatches `TURN_ABORTED`**. Only recovery is
  restart. (Transcript survives on disk.)
- **Fix (S):** `String((err as Error)?.message ?? err)`, plus `try/finally` in `send()`
  guaranteeing a terminal dispatch + `abortRef` reset.
- **Narrow trigger, unrecoverable when it fires.** Cheap to fix; do it.
- **Changeset:** yes — `patch`.

### R3 — Async faults surface nothing in the UI [AGENT]

- `process-guards.ts:39-42` logs to `~/.cognia/logs/crash.log` and, **by merely existing,
  overrides Node's default termination** — so the TUI survives but the user is told nothing.
- `void agent.send(...)` has no `.catch()` (`use-apply-effect.ts:181,345`), so a provider stream
  throwing mid-token goes straight to the guard. Result: **frozen spinner, no error cell, no
  hint.** The user must find `crash.log` unaided.
- **Fix (M):** give the guard a UI sink that dispatches an error cell alongside the log write.
- **Relevant to W1:** if you add crash guards to the `serve` path, remember a log-only guard
  converts a crash into a silent hang. Prefer surfacing.
- **Changeset:** yes — `patch`.

### R4 — Error boundary is app-wide [AGENT]

- A render throw in a **single cell or overlay** replaces the entire app with the fallback.
  A boundary exists (good — Ink ships none), but its granularity is the whole tree
  (`mount.tsx:82` wraps the entire `<App>`; `AppErrorBoundary.tsx:60-66`). Pressing `r` bumps
  `resetKey` → full remount → in-memory state discarded (the file comment at line 11 admits
  _"the transcript is lost"_).
- **Fix (M):** per-cell boundary in the transcript list + per-overlay boundary, so a bad cell
  renders inline and the rest survives.
- **Changeset:** yes — `patch`.

### R5 — Two `spawn` sites lack an `error` listener [AGENT]

- `spawn` reports ENOENT **asynchronously** via an `error` event — a surrounding try/catch cannot
  catch it, and an `error` event with no listener throws.
- `AppOverlays.tsx:889` — `/doctor` → "open crash dir" on Linux without xdg-utils → silently
  does nothing + a crash.log entry.
- `cli/src/agent/run-shell.ts:57-63` — **worse**: the catch on `:61` is effectively dead for
  ENOENT, and the early `return` on `:60` skips the `child.kill()` fallback on `:72`, so **the
  process tree survives as an orphan** — the exact zombie bug `killTree` exists to prevent.
  (Trigger requires `taskkill` missing from PATH; low probability.)
- **These are outliers, not the norm** — every other spawn site has a handler: `editor.ts:270`,
  `open-browser.ts:44`, `clipboard.ts:132`, `clipboard-image.ts:163`, `run-hooks.ts:108`.
- **Fix (S):** add `.on("error", …)` to both.
- **Changeset:** yes — `patch`.

---

## 6. Phase 5 — Coverage (this is what let everything above hide)

### C1 — `cli/**` has **no coverage threshold group at all** [AGENT]

- `scripts/test/coverage-thresholds.json` defines groups for `stores`, `lib`, every
  `packages/*`, `hooks`, `components/logging` — **nothing for `cli`**. ~44k lines fall into
  `global`: **25% lines / 30% functions**, versus CLAUDE.md's **≥90%**.
- Actual measured `.ts` coverage: **97.05% lines / 89.57% branches / 94.42% functions** →
  **~72 points of silent headroom.**
- **Fix (cheap, do it):** add `./cli/src/**` at current numbers to **lock in what already
  exists**. Don't aim at 90 and negotiate — the code is already at 97; the gate just isn't
  watching.
- **Changeset:** no.

### C2 — TUI `.tsx` is excluded from coverage entirely [AGENT]

- `jest.config.ts:319` collects `cli/src/**/*.ts` only. Measured separately, the `.tsx` are
  **92.35% lines but 73.46% functions** (227/309) — ~82 handler functions never invoked, wholly
  ungated.
- The config calls them _"thin ink renderers"_ — **false**: `App.tsx` is 1,696 LOC,
  `AppOverlays.tsx` 932, `Input.tsx` 781.
- **Good news:** `Input.tsx`, `CellView.tsx`, `Markdown.tsx`, `useAgentSession.tsx` are all
  **100% functions** — input handling and streaming are genuinely well covered. The gap is
  concentrated in overlays.
- **Fix:** include `cli/src/**/*.tsx` in `collectCoverageFrom`; set the threshold at the current
  measured level, then raise it as C3 lands.
- **Changeset:** no.

### C3 — `AppOverlays.tsx`: 69 of 84 functions never execute, and it hosts the permission gate [AGENT]

**The highest-risk untested surface in the CLI.** 17.85% functions / 63.84% of 932 lines, fully
ungated (C2). It hosts `PermissionOverlay` (`:22`/`:158`), `PlanApprovalOverlay` (`:37`),
`ConfirmOverlay`, `AskUserDialog`.

The uncovered functions are the inline `onSelect` handlers at `:188`/`:214`/`:263`/`:294` —
including **`:214-216`, which maps a selected index → permission mode and calls
`persist("permissionMode", m)`**.

> **A regression mapping "select _plan_" → "persist _bypassPermissions_" ships green today.**

**Fix:** test the permission/plan-approval selection handlers. This and W2's guard are the only
items in this document worth _building_ test infrastructure for.

**Changeset:** no.

### C4 — `FormOverlay.tsx`: 0% functions, no co-located test [AGENT]

Violates the repo's co-located-test rule outright. 25.6% lines.

### C5 — Untested command dispatch [AGENT]

All under `cli/src/tui/commands/`: `mcp-commands.ts` (115 LOC), `skill-commands.ts` (69),
`commit-command.ts` (33), `pr-command.ts` (20), `view-commands.ts` (18), `runtime-handler.ts`
(13); plus `cli/src/mcp/mcp-client.ts`, `cli/src/cli/output.ts`.
**`commit-command` / `pr-command` shell out to git — mutating, with no direct test.**

**Reducers/state transitions are FINE** — `cli/src/tui/state/` has co-located tests throughout;
`state/types.ts` (955 LOC) is type-only and correctly excluded.

---

## 7. Do NOT do these (verified already solid — spending effort here is waste)

**Feature parity with Claude Code: ZERO gaps.** All 11 affordances verified present:
transcript search (`search-command.ts:50` + `format/scrollback-search.ts`), message edit +
**fork** (`App.tsx:1150-1159` `forkConversationAt`), rewind/checkpoints (`parity-commands.ts:98`

- `runtime/checkpoint-{capture,store}.ts`), copy code block (`registry.ts:152-184`), file
  refs/attachments (`tui/mention/` + `@image`/`@*.pdf` with OCR), **queued input while streaming**
  (`app/use-steer-queue.ts`), todo display (`CellView.tsx:403-428`), multi-line paste
  (`Input.tsx:3`), output truncation + expand (`expand-command.ts:64`, `inspect-command.ts:21`),
  `/help <cmd>` detail docs (`registry.ts:245-265`), external editor (`editor-command.ts:52,60`).

**Do not re-audit these — they are correct:**

- **`killTree`** (`cli/src/agent/run-shell.ts:44-77`) is textbook: `taskkill /pid <pid> /T /F`
  on Windows, negative-pid process group on POSIX with `detached: !isWindows`, SIGTERM→SIGKILL
  escalation on an unref'd 2s timer. **The classic Windows kill-only-the-parent zombie bug is
  already fixed.**
- **Abort propagation** — `AbortSignal` threaded through `runTurn` → `session.send` → `run-shell`
  and the goal/fix/loop runners; listener removed on cleanup (`run-shell.ts:189-192`); aborted
  runs resolve with `aborted:true` + exit 130.
- **Gate serialization** (`turn-engine.ts:87-150`) — the FIFO one-overlay-at-a-time queue is
  well-reasoned and prevents a stranded-resolver hang. **Don't touch.**
- **No idle-CPU bug.** All 9 `setInterval`s are correctly gated (Mascot only while animated,
  WorkingIndicator/BottomStatus only while streaming, agent-tree poll only while `treePolling`
  with a signature check). **A resting session runs zero intervals.** All 19 `setTimeout`s are
  one-shot.
- **Markdown streaming cache** (`markdown/render-cache.ts`) — `tokenizeCached` LRU +
  `highlightCached` keyed by (theme, lang, code) + `tokenizeTransient`, a dedicated single-entry
  cache so the reveal's growing-prefix strings don't evict committed cells from the shared LRU.
  **Streaming markdown is not re-parsed per delta.**
- **`<Static>` usage in scrollback** — flat 0.27ms at 2,000 cells. The `epoch` re-key
  (`Transcript.tsx:152`) is correct and debounced on resize (`app-helpers.ts:17`).
- **The composer is memoized at three levels** (`Input.tsx:90`, `:108`, `:781`). Per-keystroke
  cost is not here; it's P2.
- **Terminal restore on clean exit** — `mount.tsx:104-119`'s finally restores bracketed paste,
  title, mouse, alt screen; escapes are idempotent. **The only gap is the hard-signal path (R1).**
- **Cross-platform paths** — the `split(path.sep).join("/")` normalize idiom is used correctly
  (`skill/discover-skills.ts:291`, `commands/custom-commands.ts:98`); `where`/`which` properly
  platform-gated (`runtime/editor.ts:174`). No hard-coded `"/"` joins in production code.
- **`entry.ts` uses `process.exitCode`, never `process.exit()`** (`cli/src/cli/entry.ts:34,38`)
  — the event loop drains so a pending 400ms flush timer actually fires. Subtle and correct;
  it's what keeps W2 from being worse on clean exit.
- **`crash-log.ts`** — never-throws by construction; rotation handles the Windows
  rename-over-existing trap (`:75`).

**Union/registry completeness — all exhaustively diffed, all clean:** 41/41 `CommandEffect`
variants handled (`use-apply-effect.ts`); 25/25 `RuntimeRequest.feature` (`runtime/index.ts:333`);
14/14 `SettingsApplyTarget` (`App.tsx:1248`); 17/17 keybindings wired; 19/19 overlay components
mounted (`AppOverlays.tsx`); 11/11 `STATUS_SEGMENTS`; command registry has no unregistered
commands and `registry.ts:287-293` throws on both name and alias collisions at startup.

**Surfaces swept and clean:** `cli/src/serve/` (all 7 protocol frames accounted for;
`token_refresh` handled **and** tested at `bridge-client.test.ts:184`), `cli/src/plugin/`,
`cli/src/mcp/`, `cli/src/hooks/`, `cli/src/team/`, `cli/src/handoff/`.

**`lsp` works in the CLI — do not "fix" it.** Chain verified end-to-end: CLI schema
(`schema.ts:495`) → `to-build-context.ts:245` → `build-options.ts:2039`
(`appSettings?.lsp?.enabled ?? appSettings?.builtinTools?.lsp ?? false`) → `opts.lsp` (`:2058`,
whenever `opts.cwd` is set, which the CLI always sets) → `sidecar/dispatch/lsp-resolver-factory.mjs:21`
→ `sidecar/builtin-tools/index.mjs:155` registers the tools. Only `installDir` is Tauri-gated,
and the npm-first install ladder covers headless.
**Residue (real, small):** the `BuiltinToolsConfig.lsp` docstring in
`packages/agent-config-types/src/index.ts` says _"desktop only"_ — **that is wrong**, and it's
what made the omission of its three siblings (`codeGraph`, `astGrep`, `dependencyResearch`,
`webclone`) look principled. One-line doc fix. Whether those four are _also_ mislabeled was not
verified — each needs its own resolver-factory trace, and it's a missing-feature question, not
dormant code.

---

## 8. Open decisions — DO NOT decide these silently

An implementing agent must **stop and ask** rather than pick a default here.

### D1 — CLI and desktop memories are separate stores

The CLI restores Dexie from a JSON snapshot at `~/.cognia/db.json` into `fake-indexeddb`
(`cli/src/db/bootstrap.ts`); the desktop uses the Tauri webview's real IndexedDB. **`/remember`
in the CLI is invisible to the desktop and vice versa.**

Two consequences:

1. This **confirms local recall is the only sensible design** for W5 — routing CLI memory
   through the desktop bridge (as twin does) would query the _wrong database_. So W5 is
   unblocked.
2. Users will likely expect **one memory across both shells**. W5 makes the CLI internally
   coherent but does **not** unify the stores. That's a product call of a different magnitude.
   **Flagged, not solved.**

### D2 — Is `/goal`'s missing `activeGoal` deliberate?

`cli/` never passes `activeGoal` / `activePlan` / `activeLoop` to the options builder
(`build-options.ts:464`, `:473`, `:481`; consumed at `:2732`, `:2756-2768`, `:2776-2780`).
Zero hits in `cli/src`; positive control (`routingContextHint|skillRenderMode|preloadedEnv`)
returns 20+ hits, so the absence is genuine.

**Effect:** `/goal` _does_ run in the TUI (continuation prompts flow as user messages —
`goal-run.ts:132`), so this is **not** total dormancy. What silently doesn't happen:
`appendGoalContext` never runs → the goal's structured `<objective>` wrap + prompt-injection
warning is never appended; and `goalLoop` is hardcoded false at `build-options.ts:2732` → the
goal-loop surface skill never activates. **Net: CLI `/goal` runs with weaker grounding — and
weaker prompt-injection defense — than desktop `/goal`.**

**Why this is [OPEN] and not a work item:** adjacent precedent argues caution. `twinDeps` /
`twinUserMessage` are _also_ never passed, but that **is** deliberate and documented — the CLI
has no local twin data (`run.ts:165`), so it fetches from the running desktop and appends to
`systemPrompt` manually (`run.ts:170-181`). **There is no equivalent comment for `activeGoal`.**
Needs a maintainer's call. If it's deliberate, document it (see D4). If not, it's M: thread them
through `toBuildContext`, needs a Dexie read CLI-side.

**Not a finding (recorded so it isn't re-chased):** `build-options.ts:2765-2768` forwards
`activeGoal.config.maxBudgetUsd` → `opts.maxBudgetUsd`, and `goal-run.ts:120-129` omits
`budgetExceeded` which `turn-driver.ts:163` needs for `costLimited`. This looks like two-layer
budget dormancy. It collapses: `maxBudgetUsd` has **zero hits in `cli/src`**, and
`lib/goal/runtime.ts:129` resolves it to `undefined` when neither override nor appSettings
default is set. The CLI never sets it → there is no budget to enforce. That's a **missing
feature** (CLI can't configure goal budgets), not dormant code.

### D3 — PII enforcement is advisory-only

See W3. Making the red line CI-enforceable is a scope decision, not an implementation detail.

### D4 — Proposed house rule: intentional dormancy must be labeled

`cli/src/hooks/` contains the codebase's **exemplar of dormant-by-design done right**. Webhook
handlers are inert in the CLI, and that is correct — but it is inert on **all three axes at
once**:

1. **Documented at the type** — `types.ts:83-85`: _"recognized, inert in the core"_
2. **Surfaced in the UI** — `hooks-controller.ts:38`:
   `webhook → ${url} (inert — not run in the CLI)`; `:40`: `${type} handler (inert)`
3. **Pinned by a test** — `run-hooks.test.ts:132`: _"ignores webhook and unknown handlers (inert)"_

Contrast `autoRoute` (W4): undocumented, unsurfaced (the panel cheerfully reads "off" while
`config.json` says `true`), and untested at the broken link. **Indistinguishable from a defect —
which is exactly what it turned out to be.**

**Proposal:** add to `CLAUDE.md` — _intentional dormancy must be documented at the type AND
labeled inert in the UI AND pinned by a test._ Any two of three is a latent bug.
**This needs the user's approval before editing `CLAUDE.md`.**

---

## 9. Suggested order

```
Phase 0  T1 T2 T3 T4 T5           ~10 lines, all test-only. Restores a truthful gate.
         └─ do this first; a red gate is why W1/W2 survived

P0       W1  serve boot crash     ~4 lines + a .catch  (also turns T6 green)
         W2  db.json atomicity    S+M — the 3-part fix; part 3 is mandatory
         W3  PII pointers         S — docs/config only; start with pii-gate-auditor.md

Quick    P1  highlight-then-cap   S — 22.8s → 2.2ms, best ratio in the document
wins     W4  autoRoute            1 line + the structural Required<> fix
         W6  /memory search       S — core API already exists

Build    W5  CLI memory recall    M — unblocks W7
         W8  snapshot version     M — same seam as W2, consider pairing
         C1  cli/** threshold     lock in the 97% that already exists
         C3  AppOverlays perm     the permission gate is untested today

Later    P2 P3 P4 P5   perf (re-measure first)
         R1 R2 R3 R4 R5 resilience (R2 is S and unrecoverable-when-hit; consider promoting)
         W7 W9 C2 C4 C5
```

**One commit per item.** Conventional Commits, subject ≤72, imperative, no capitalized first
word (commitlint rejects it). Body explains _why_.

---

## 10. Provenance

Five parallel read-only audit agents; all headline claims independently re-verified by the audit
lead against the source before landing here. **No repository files were modified during the
audit.**

Every agent self-reported at least one error in its own method — a timed-out grep, an
unverified claim written as fact, a retracted finding. Those corrections are why the [CONFIRMED]
labels mean something. **Hold the same standard: if you find something in this document is
wrong, say so loudly rather than working around it.** Three of the items here exist precisely
because someone refused to accept a comfortable dismissal.
