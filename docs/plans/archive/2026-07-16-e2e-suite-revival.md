# E2E Suite Revival — Remediation Plan (2026-07-16)

**Status: EXECUTED 2026-07-17.** Waves 0–4 landed as ~14 commits on `dev`; see
**§7 Execution Record & Baseline** at the bottom for what shipped, the decisions taken
on the three OPEN questions, the product bugs the new tests surfaced, and the
first real baseline. The body below is preserved as the original audit.

**Original status (2026-07-16):** none of this is implemented. Every finding below is a verified defect in the
Playwright E2E suite (`tests/e2e/`, 154 spec files on disk), its CI wiring
(`.github/workflows/{ci,test}.yml`), or its typecheck configuration.

**Origin:** a read-only audit across three axes — infrastructure quality, subsystem coverage,
and CI enforcement. The headline is not "coverage is thin". It is that **three independent
failures each, on their own, make this suite incapable of catching a regression before merge.**
Fixing any one of them in isolation changes nothing.

---

## 0. How to use this document

Each work item is self-contained: problem → evidence → fix → verification. Items are
independent unless a **Depends on** line says otherwise. One item, one commit.

### 0.1 Confidence labels — read this before you touch anything

| Label           | Meaning                                                                              | What you must do                                                 |
| --------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| **[CONFIRMED]** | The plan author ran the command / read the file end-to-end. Output is quoted inline. | Trust it. Line numbers drift — re-locate by symbol, not by line. |
| **[AGENT]**     | A subagent reported it with evidence; not independently re-run by the plan author.   | **Re-verify before acting.** Especially counts and percentages.  |
| **[OPEN]**      | A genuine design decision. No correct answer derivable from the code.                | **Do not decide it silently.** See §5.                           |

### 0.2 The one thing to understand before you start

There are **three stacked failures**. They are not three symptoms of one cause — they are
three separate walls, and the suite is behind all of them:

| #     | Wall                                                                                                                      | Consequence                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **1** | The CI pipeline has **never compiled**. 22/22 `startup_failure`, since Initial commit (~2.5 months).                      | No test has _ever_ run in CI. Not E2E, not Jest, not lint, not typecheck. |
| **2** | The `tauri` project **collects 0 tests** — a fixture-scope error, platform-independent.                                   | 18 spec files / 26 tests have been phantom coverage since 2026-05-19.     |
| **3** | **69% of all assertions** are `toBeVisible` / `toBeEnabled`. ~90 of 282 collected tests cannot fail for a product reason. | Even a running suite would wave regressions through.                      |

**Sequencing follows from this.** Wave 0 exists because there is currently **no feedback loop
at all**: you cannot know whether any test fix worked, because nothing runs. Do not start at
Wave 3 — you would be writing assertions into a void.

**Expect red.** Turning on 282 tests that have never once run green in CI will not be quiet.
Wave 0 deliberately ends at "capture the real baseline", not "make it green".

### 0.3 Repo gates that apply to every item

From `CLAUDE.md` — hard rules:

- **Co-located tests.** New/changed files under `components/**`, `hooks/**`, `lib/**`,
  `src-tauri/src/**` need a co-located test. **Mostly N/A here** — `tests/e2e/` is exempt
  from the co-located rule (it is the test tier), but W3.4 and W4.x touch product code.
- **No simplifications.** Do not stub or `// TODO later` a production path. If an item can't
  be done as written, stop and surface the blocker.
- **i18n.** No hard-coded user-facing strings in `.tsx`; keys in **both** `en.json` and
  `zh-CN.json`. Relevant to W3.4.
- **Changeset.** Marked per item. Test/CI-only work skips it; W3.4 is user-facing.
- **Never `--no-verify`.** Hook fails → fix the cause, re-stage, new commit.

### 0.4 Tooling traps specific to this work

- **`rtk` masks exit codes** for jest/playwright/cargo. For any gate, run
  `npx playwright test ...` directly and read the summary line yourself. `rtk proxy <cmd>`
  when you need the raw stream.
- **`PLAYWRIGHT_TAURI=1` poisons the entire run**, not just the tauri project. With it set,
  `npx playwright test --list` returns `Total: 0 tests in 0 files` for _everything_. Never set
  it while debugging chromium/mobile. [CONFIRMED]
- **`test:e2e:changed` is a trap.** It is `playwright test --only-changed=master`, and `master`
  is **1256 commits behind** `dev`. The diff is **11,835 files** — the "changed only" filter
  selects essentially the whole suite. Same shape as the known-broken `coverage:changed` gate.
  Do not use it to scope work. [CONFIRMED]
- **Shared working tree.** Other sessions edit this checkout concurrently. Never bare-stash;
  don't trust full-suite counts you didn't just produce.
- **The mock fleet accumulates state.** Nothing calls `reset()` between tests today (because
  nothing calls the mock control API at all — see W3.1). Once you start using it, `reset()` in
  `afterEach` becomes mandatory or `fullyParallel: true` will bleed scenarios across workers.

---

## 1. STATUS — what is already good (do NOT redo)

This suite is not incompetent. It is well-engineered machinery that was never connected to a
runner, and the disconnection hid everything else.

- **`tests/e2e/workflows/engine/`** (5 files) is the standard the rest should meet. Its author
  knew — `engine/branch-routing.spec.ts:3-6` states outright: _"The existing
  `nodes/flow/branch.spec.ts` only asserts the seeded node renders and that *a* run lands
  succeeded — it never checks that the engine took the correct arm. A regression that ran BOTH
  arms would pass it."_ It then seeds a real graph, reads the real event timeline, and asserts
  the other arm did **not** execute. **Copy this pattern.** [CONFIRMED]
- **`scripts/e2e/serve-out.mjs`** greps the exported chunks for `__cogniaResetDb` and refuses
  to start without it. Correct fail-fast design, with its own test.
- **`global-setup.ts`** `startOrFallback` handles `EADDRINUSE` by falling back to port 0;
  teardown is best-effort across all six mocks.
- **The CI design** — 2 projects × 2 shards, static-export serving (no Turbopack per-route
  compiles), blob reporter → `merge-reports`, trace/video `retain-on-failure`, `forbidOnly` on
  CI. This is textbook. It has simply never executed.
- **`assertLatestRunStatus`** (`workflow-spec-helpers.ts:103-141`) binds to the real run row via
  `__cogniaReadRuns` rather than "some pill is visible", and the doc comment explains why.
- **Hard waits: only 7 in the whole suite.** Genuinely good discipline.
- **`.only`: zero.**

---

## 2. Work items

### WAVE 0 — Restore the feedback loop

> **Nothing else in this document is verifiable until this wave lands.** There is currently no
> CI signal of any kind.

#### W0.1 — `ci.yml` requests no permissions; every run `startup_failure`s [CONFIRMED]

**Problem.** The entire `CI/CD Pipeline` has never compiled. Not "runs and fails" — GitHub
refuses to create the run at all, so zero jobs exist.

**Evidence.**

```
$ gh run list --limit 60
  22  CI/CD Pipeline    startup_failure     ← 22/22, no exceptions
$ gh run list --workflow=test.yml
  (empty — test.yml has never produced a run)
```

Three ingredients:

| Ingredient                                  | Evidence                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Caller declares **no** `permissions:` block | `grep -n "permissions:" .github/workflows/ci.yml` → no match                                           |
| Callee requests write                       | `test.yml:102-105` — `coverage-merge` asks `pull-requests: write` + `checks: write`                    |
| Repo default is read                        | `gh api repos/{owner}/{repo}/actions/permissions/workflow` → `{"default_workflow_permissions":"read"}` |

A called workflow may never request more than the caller holds → GitHub refuses to compile.
`git log -S "checks: write" -- .github/workflows/test.yml` → `559088198 Initial commit`.
**Broken since day one.** `actionlint` does not catch this.

**Not a Dependabot/fork-token quirk:** 3 of the 22 failures are `push master`. [CONFIRMED]

**The single consumer of those scopes** is one step:

```yaml
# test.yml:161-166
- name: Publish Test Results
  uses: EnricoMi/publish-unit-test-result-action@v2
  if: always() && github.event_name == 'pull_request'
```

**Fix.** → **[OPEN-1] in §5.** This is a real design decision, not a 3-line patch: Dependabot
`pull_request` events receive a read-only `GITHUB_TOKEN` that `permissions:` **cannot**
escalate, and 19 of the 22 failing runs are Dependabot. Granting write in `ci.yml` fixes
`push master` but leaves every Dependabot PR still `startup_failure`ing. Decide §5 first.

**Verify.**

```bash
actionlint .github/workflows/ci.yml .github/workflows/test.yml
gh workflow run ci.yml --ref <your-branch>
gh run list --workflow=ci.yml --limit 1     # must NOT be startup_failure
```

**Changeset:** no (CI-only).

---

#### W0.2 — `dev` is not in the trigger list; the pipeline isn't even attempted [CONFIRMED]

**Problem.** All work happens on `dev`. `origin/dev`'s `ci.yml` triggers only on
`master` / `develop`. Pushing to `dev` doesn't attempt the pipeline.

**Evidence.**

```
$ git show origin/dev:.github/workflows/ci.yml | sed -n '20,30p'
on:
  push:
    branches: [master, develop]      # ← no dev
  pull_request:
    branches: [master, develop]      # ← no dev

$ git rev-list --count origin/master..origin/dev
1256
```

A local **unpushed** commit `20295b83e` already adds `dev` to both trigger lists — **but it does
not add the `permissions:` block.** Merging it alone converts "never attempted" into "attempted
and startup_failure". [CONFIRMED]

**Fix.** Land W0.1 and W0.2 in the **same commit**. Never W0.2 alone.

**Verify.** Push to a branch off `dev`; confirm a run is created and reaches the `test` job.

**Depends on:** W0.1. **Changeset:** no.

---

#### W0.3 — The E2E suite is never typechecked [CONFIRMED]

**Problem.** This is the _mechanism_ that let W1.1 (a fixture that has never once executed)
survive code review and sit unnoticed for two months. Fix it or the class of bug recurs.

**Evidence.**

```jsonc
// tsconfig.json:76-87
"exclude": [
  "node_modules", "docs", "mobile", "sidecar", "services/share-server",
  "out", ".next",
  "tests/e2e",              // ← the entire E2E suite
  "playwright.config.ts",   // ← and its config
  "packages/*/tsup.config.ts"
]
```

ESLint _does_ cover the directory (no ignore entry in `eslint.config.mjs`), so lint is the only
gate — and lint cannot see fixture-scope collisions or type errors.

Known latent type error, shipped because nothing compiles it: `mocks/anthropic/server.ts:248`
reads `body.stream`, absent from the `MessagesRequestPayload` interface (lines 19-27). [AGENT
— re-verify]

**Fix.** Remove `"tests/e2e"` and `"playwright.config.ts"` from `exclude`. Expect a burst of
errors on first run; fix them in this commit or a stacked follow-up, but do **not** re-add the
exclusion to make it quiet.

**Verify.**

```bash
npx tsc --noEmit 2>&1 | grep -E "tests/e2e|playwright.config" | head -50
# Gate on "no NEW errors" — the repo's typecheck baseline is known-broken
# (see memory: typecheck-baseline-broken). Capture the before/after counts.
```

**Changeset:** no.

---

#### W0.4 — Capture the real baseline

**Problem.** Nobody knows what actually passes. Every number in this document is a _static_
count. The dynamic truth is unknown because the suite has never run in CI.

**Fix.** No code. Run the suite and **write the result into this file** under a new
`## 7. Baseline (YYYY-MM-DD)` heading: pass/fail/flake per project, wall-clock, and the list of
failing specs.

```bash
pnpm test:e2e:build                    # NEXT_PUBLIC_E2E=1 static export → out/
PLAYWRIGHT_STATIC=1 npx playwright test --project=chromium     --reporter=list
PLAYWRIGHT_STATIC=1 npx playwright test --project=mobile-pixel-7 --reporter=list
# Do NOT set PLAYWRIGHT_TAURI=1 (see §0.4)
```

Run each **twice** and diff — anything that flips is a flake and goes on the quarantine list.
`retries: CI ? 1 : 0` (`playwright.config.ts:67`) will silently launder flake into green once
CI is live; know your flakes _before_ that.

**Depends on:** W0.1, W0.2. **Changeset:** no.

---

### WAVE 1 — Un-ghost the tauri project

#### W1.1 — `tauri` collects 0 tests; the fixture has never executed [CONFIRMED]

**Problem.** 18 spec files / 26 tests are phantom coverage. **This is not a macOS problem** —
it is a collection-time error, identical on Windows, including the nightly CI job.

**Evidence.** Reproduced locally:

```
$ PLAYWRIGHT_TAURI=1 npx playwright test --list --project=tauri
Fixture "context" has already been registered as a { scope: 'test' } fixture
defined in node_modules/.pnpm/playwright@1.61.1/.../playwright/lib/index.js:774:27
   at tauri/fixtures.ts:40
Total: 0 tests in 0 files          exit=1
```

`tests/e2e/tauri/fixtures.ts:56-62` re-registers Playwright's built-in **test-scoped** `context`
fixture at **worker** scope:

```ts
context: [
  async ({ browser }, provide) => {
    const ctx = browser.contexts()[0] ?? (await browser.newContext())
    await provide(ctx)
  },
  { scope: "worker" },     // ← illegal: built-in `context` is test-scoped
],
```

`git log -- tests/e2e/tauri/fixtures.ts` → **exactly one commit**, `979e1b5a1 2026-05-19
test(e2e): migrate tauri-driver to webview2 cdp + expand spec coverage`. Never modified since.
**Written, reviewed, merged, never executed once.**

The docstring at `tests/e2e/tauri/chat/reply-renders.spec.ts:22-23` claims this suite is
"verified by the nightly Windows CI job". **That claim is false** — the job exits 1 and has no
`continue-on-error`, so it has been failing nightly for two months.

**Fix.** Drop the `context` override entirely — the built-in test-scoped `context` derived from
the worker-scoped `browser` is what you want. If a shared context across tests is genuinely
required (the CDP fixture reuses one WebView2 page), express it as a _differently named_
worker fixture (e.g. `tauriContext`) and have a test-scoped `context` read from it. Do **not**
shadow a built-in name.

**Verify.**

```bash
PLAYWRIGHT_TAURI=1 npx playwright test --list --project=tauri   # must list 26 tests, exit 0
PLAYWRIGHT_TAURI=1 npx playwright test --list                   # must still list ALL projects
```

**Depends on:** W0.3 (typecheck would have caught this; land it first so it stays caught).
**Changeset:** no.

---

#### W1.2 — `defaultBinaryPath()` resolves the wrong binary [CONFIRMED]

**Problem.** The local default spawns the **plugin-author CLI**, not the Tauri app.

**Evidence.**

```ts
// tests/e2e/helpers/tauri-cdp-launch.ts:44-47
const exe = process.platform === "win32" ? "cognia.exe" : "cognia"
return path.resolve(process.cwd(), "target", "debug", exe)
```

- Tauri app crate: `src-tauri/Cargo.toml:2` → `name = "cognia-next"`
- `target/debug/cognia` is: `crates/cognia-cli/Cargo.toml:10` → `[[bin]] name = "cognia"`

CI papers over it: `test.yml:553` sets
`PLAYWRIGHT_TAURI_BIN: ${{ github.workspace }}\target\debug\cognia-next.exe`. **That override is
exactly why a wrong default survived** — the only path that runs never uses the default.

Locally, `pnpm test:e2e:tauri` spawns the CLI, which exits immediately; `waitForCdp` then burns
60s and throws `Timed out waiting for CDP on port 9222` (`tauri-cdp-launch.ts:72`).

**Fix.** Default to `cognia-next`. Keep `PLAYWRIGHT_TAURI_BIN` as the override, and drop the
now-redundant hardcode in `test.yml:553` so the default is actually exercised.

**Verify.** `PLAYWRIGHT_TAURI=1 pnpm test:e2e:tauri` on Windows reaches CDP connect rather than
timing out. On macOS it will still fail — that's W1.4, not this item.

**Depends on:** W1.1. **Changeset:** no.

---

#### W1.3 — An unguarded tauri launch kills the whole run [CONFIRMED]

**Problem.** `global-setup.ts:103-105` calls `launchTauriCdp()` whenever `PLAYWRIGHT_TAURI=1`,
with no platform guard and no try/catch. A throw out of `globalSetup` aborts **every** project,
not just `tauri`. Combined with W1.1, this is why `PLAYWRIGHT_TAURI=1` returns
`Total: 0 tests in 0 files` for the entire suite.

**Fix.** Wrap the launch. On failure (or on a platform with no CDP-capable webview), log loudly
and let the `tauri` project fail/skip on its own — never take chromium and mobile down with it.

**Verify.** With `PLAYWRIGHT_TAURI=1` and a deliberately bogus `PLAYWRIGHT_TAURI_BIN`,
`npx playwright test --list` must still list the chromium + mobile tests.

**Depends on:** W1.1. **Changeset:** no.

---

#### W1.4 — macOS has no WKWebView CDP; this is architectural, not a bug [OPEN-2]

**Problem.** `tauri-cdp-launch.ts:99` drives the webview via
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=…`. That is a **Microsoft
WebView2** loader variable. macOS Tauri uses WKWebView, which ignores it and exposes no CDP
endpoint. `chromium.connectOverCDP` can never work there. The only `process.platform` checks in
the file are cosmetic (exe suffix line 45, `taskkill` line 140).

Tauri's own docs: _"Driven directly, only Windows and Linux are supported on desktop, as macOS
has no WKWebView driver tool available"_ — Apple ships no WebDriver for WKWebView.

**Consequence.** Even fully fixed, the tauri suite is **Windows/Linux-only**, and it holds the
_only_ E2E coverage of **chat** and **subscription/keyring**. On the primary dev machine
(macOS) those flows are untestable end-to-end.

**Fix.** → **[OPEN-2] in §5.** Three real options, materially different in cost.

**Depends on:** W1.1–W1.3.

---

#### W1.5 — `master`'s nightly invokes a project that doesn't exist [CONFIRMED]

**Problem.** `git show origin/master:.github/workflows/test.yml:322` runs
`playwright test --project=tauri-driver`, but `playwright.config.ts` names the project `tauri`.
Dead command. Also, `test.yml`'s `schedule: cron "0 3 * * *"` only fires from the **default
branch**, and `master`'s copy of `test.yml` has no `schedule:` — so the nightly does not exist
at all. [AGENT — re-verify the `master:test.yml` trigger block]

**Fix.** Fold into the W0.1/W0.2 commit if you are already touching triggers; otherwise a
standalone cleanup once `dev` merges to `master`.

**Changeset:** no.

---

### WAVE 2 — Delete the tests that cannot fail

> These are worse than no tests: they consume wall-clock and report green while the feature is
> broken or absent. Every item here is _removing_ false signal.

#### W2.1 — `outbound-queue.spec.ts`: 17 tests, all no-ops [CONFIRMED]

**Evidence.** Read end-to-end. Every one of the 17 `COMMAND_KINDS` produces a byte-identical
test:

```ts
if (typeof w.__cogniaEnqueueOutbound === "function") {   // bridge missing → silent no-op
  await w.__cogniaEnqueueOutbound({ command: cmd, payload: { e2e: true } })
}
…
await expect(page.getByTestId("offline-banner"))
  .toBeHidden({ timeout: 15_000 })
  .catch(() => undefined)                                 // ← the ONLY assertion, swallowed
```

`kind` appears in **no assertion**. The docstring claims it "exercises every command kind
end-to-end"; it enqueues and never verifies the queue drained. The file header even warns
_"drift here silently passes the spec while production commands rot"_ and cites an
`outbound-queue-spec-parity` unit test guarding the list — **a parity gate protecting a list
that drives 17 tests asserting nothing.**

**Fix.** Remove `.catch()`. Remove the `typeof === "function"` guard — if the bridge is missing,
that is a **failure**, not a skip. Assert the actual outcome: poll the `mobileOutboundQueue`
row for the enqueued `kind` and assert it reaches a drained/succeeded state. The per-kind loop
only earns its keep if the assertion is per-kind.

**Verify.** Break the queue runner on purpose (early-return in the drain path) → the spec must
go red. **If it stays green, the fix isn't done.**

**Changeset:** no.

---

#### W2.2 — Four self-disabling skips [CONFIRMED]

**Problem.** `if (!(await x.count())) test.skip()` — the element being missing (i.e. the feature
regressed or was deleted) causes a **skip**, which reports green. These tests are structurally
incapable of catching the regression they exist for.

| File:line                                   | Skips when                    |
| ------------------------------------------- | ----------------------------- |
| `mobile/i18n-switch.spec.ts:19`             | the language switcher is gone |
| `mobile/oauth-in-app-browser.spec.ts:22`    | the OAuth button is gone      |
| `mobile/interactions/long-press.spec.ts:19` | the long-press target is gone |
| `mobile/interactions/swipe-row.spec.ts:23`  | the swipeable row is gone     |

Worse for the interaction pair: their own `beforeEach` calls `resetCogniaDb` (`swipe-row:13`),
wiping the inbox → zero rows → **always skips**. The comment at `swipe-row:20-21` admits it:
_"the assertion soft-passes because the data-testid won't match."_ [AGENT — re-verify the
always-skips claim by running the two specs and reading the skip count]

**Fix.** Seed the precondition in `beforeEach` (the row / the switcher / the button), then
`await expect(target).toBeVisible()` — a hard assertion. Absence must fail.

**Verify.** Run the four specs; the report must show **0 skipped**.

**Changeset:** no.

---

#### W2.3 — `.or(h1, h2)` fallbacks make assertions unfalsifiable [AGENT — 8 sites, re-verify]

**Problem.** The clearest case:

```ts
// workflows/editor/settings-workflows-tabs.spec.ts:27
const tabMark = page.getByTestId(tab.testid).or(page.locator("h1, h2").first())
await expect(tabMark).toBeVisible({ timeout: 15_000 })
```

Every page has an `h1`/`h2`. These **5 tests pass even if Settings→Workflows is deleted
entirely.** The comment at 25-26 ("Specs are tolerant") is self-aware.

Other reported sites: `mobile/me-settings.spec.ts:19`, `mobile/mdns-discovery.spec.ts:24`
(`.or(getByText(/discovered|发现/i))` — never proves the injected mDNS result surfaced),
`mobile/interactions/pull-to-refresh.spec.ts:18`,
`workflows/editor/expression-field.spec.ts:25`, `mobile/biometric-guard.spec.ts:39`.

**Fix.** Drop the `.or()` fallback; assert the real testid/role. If it is genuinely flaky,
that's a bug to fix or quarantine — not to paper over with a locator that always matches.

**Verify.** Delete the target component locally → the spec must go red.

**Changeset:** no.

---

#### W2.4 — `telegram-bidirectional.spec.ts`: 5 tests, 0 product coverage [AGENT — re-verify]

**Problem.** Reported: lines 69-75 and 86-92 use
`await expect(banner).toBeVisible().catch(() => { test.skip() })` — self-nullifying. Neither
test seeds an account, so `AccountGate` blocks `/inbox` → `test.skip()` fires **every run**.
The other 3 (lines 97, 106, 114) assert the _mock server_ responds to
`getMe`/`getUpdates`/`sendMessage` — they test the mock, not the app.

Also hardcodes `APP_BASE_URL = "http://localhost:3000"` at line 36, ignoring
`baseURL` / `PLAYWRIGHT_BASE_URL`. [CONFIRMED — the histogram shows `${APP_BASE_URL}` gotos]

**Fix.** Seed the account (see `tests/e2e/global-setup.ts` + the AccountGate seed pattern —
memory: `browser-e2e-accountgate-and-bridges`). Delete the three mock self-tests. Use `baseURL`.

**Verify.** 0 skipped; the remaining tests drive the real inbox.

**Changeset:** no.

---

#### W2.5 — `plugins/responsive.spec.ts`: 60 tests (21% of the suite), 0 layout assertions [CONFIRMED]

**Problem.** Read end-to-end. Structure: 4 viewports × (7 tabs + 2) + 4 viewports × (4 subtabs

- 2. = 60 tests, **the single largest file in the suite**. 10 are skipped. The 50 that run
     assert nothing viewport-specific.

Three distinct defects:

1. **Assertions on Tailwind class strings** — `plugins/responsive.spec.ts:83`
   `.locator(".lg\\:grid-cols-\\[200px_1fr\\]")`, line 170 `.grid.grid-cols-1.md\\:grid-cols-2`.
   The comment (167-169) admits it asserts the class _"rather than measuring layout"_, and the
   test is described as **"viewport-agnostic"**. A viewport-agnostic responsive test is not a
   responsive test — it passes with the CSS deleted, and fails on a cosmetic class rename.
   Exactly inverted signal.
2. **Dead code shaped like assertions** — lines 86-90 compute `sheetTriggerCount` and `rail`,
   then discard both via `void`. The test is titled _"category rail visible at lg+, sheet
   trigger below"_ and its `if (vp.width >= 1024)` / `else` branches **assert the identical
   thing** (`gridContainer` visible, lines 84 and 94). The branch is decorative; neither
   promised behavior is tested.
3. **The tab tests never check the tab** — lines 65-67 assert _a_ tablist is visible and _a_
   tab is selected, never comparing against the URL's `tab` param. If `?tab=devtools` silently
   fell back to `installed`, it passes. Same defect at 151-153.

**Fix.** Collapse to ~8 tests that measure: `boundingBox()` widths, column counts, and
rail-vs-sheet presence at the `lg` boundary; and assert the active tab's accessible name
matches the URL param. **Cutting 52 tests here increases real coverage** and reclaims 21% of the
suite's wall-clock. Consider `toMatchAriaSnapshot` for the chrome structure.

**Verify.** New tests must fail when the `lg:` breakpoint rule is removed from the component.

**Depends on:** W3.4 unblocks the 8 skipped audit-tab tests. **Changeset:** no.

---

### WAVE 3 — Make the assertions real

#### W3.1 — ~800 lines of mock capture/scenario engine with zero callers [CONFIRMED]

**Problem.** This is the highest-leverage item in the document: **the infrastructure to do this
correctly already exists and is fully built. Nobody calls it.** Classic built-but-dormant.

**Evidence.** `tests/e2e/mocks/github/server.ts`'s own header states the intended contract:

> _"Specs flip the credential store baseUrl to `server.baseUrl` and **assert on `capturedCalls`**
> after the executor runs."_

Actual usage:

```
$ grep -rl "capturedCalls\|waitForCalls\|setScenario" tests/e2e --include="*.spec.ts" | wc -l
0
```

Zero specs import any of the four `mocks/` servers. The scenario engines
(`rate-limited` / `auth-error` / `not-found` / `validation-failed` / `server-error`), the
capture arrays, `waitForCalls(predicate)`, `setPullRequest`/`setIssue` seeding — all unexercised.

The consequence, in the 12 most dangerous specs. Their **titles promise a wire assertion their
bodies never make**:

```
action-github/merge-pr.spec.ts:33        test("manual run hits PUT /repos/.../pulls/:n/merge")
action-github/review-pr.spec.ts:34       test("manual run hits POST /repos/.../pulls/:n/reviews")
action-github/close-pr.spec.ts:34        test("manual run hits PATCH /repos/.../pulls/:n with state=closed")
action-github/push-tag.spec.ts:34        test("manual run hits POST /repos/.../git/refs with refs/tags/<tag>")
…12 total (create-release, open-pr, comment-pr, comment-issue, review-pr-inline,
   label-issue, generate-changelog, close-issue)
```

Each body contains only `assertLatestRunStatus(page, wfId, "succeeded")`. Across all 62 node
specs: **0 verify what the node sent; 0 assert node output content.**

**Be precise about what green currently proves.** The mock 404s unknown routes
(`server.ts:133`), so **path + method have implicit coverage** — a wrong endpoint does turn the
run red. **Payload has none.** And payload is exactly where the dangerous bugs live: wrong merge
method, wrong PR number, `APPROVE` vs `REQUEST_CHANGES`, wrong tag name.

**Fix.** Wire the 12 GitHub specs to the contract the mock already advertises:

```ts
const [call] = await github.waitForCalls(
  (c) => c.method === "PUT" && c.path === `/repos/${owner}/${repo}/pulls/${n}/merge`
)
expect(call.body).toMatchObject({ merge_method: "squash" })
```

Reaching the mock from a spec needs a handle — today they are only reachable via base URLs
published to `process.env` by global-setup, plus the anthropic `/__control` HTTP plane. Prefer
extending the `/__control` pattern to the github mock over exporting a live object across the
global-setup process boundary. **Add `reset()` in `afterEach`** — nothing resets today, so
`capturedCalls` accumulates unbounded across the run, and `fullyParallel: true` will bleed
captures between workers the moment this starts being used.

**Verify.** Change `merge_method` in the executor → the spec must go red. It currently does not.

**Depends on:** W0.4. **Changeset:** no.

---

#### W3.2 — The mock defaults away the bug it should catch [CONFIRMED]

**Problem.** The mock never validates a body; it echoes with `?? ""` fallbacks. The worst:

```ts
// tests/e2e/mocks/github/server.ts:218
state: (req.body as { event?: string }).event ?? "COMMENTED",
```

An executor that fails to send `event: "APPROVE"` gets a **201 and a green run**. The mock is
actively laundering the defect.

**Fix.** Validate required fields per route and return `422` when absent — the
`validation-failed` scenario already exists for this. Delete the `??` fallbacks on
**required** fields (keep them only where GitHub itself defaults).

**Verify.** Drop `event` from the review-pr executor → spec red.

**Depends on:** W3.1. **Changeset:** no.

---

#### W3.3 — 46 test names say "persist"; nothing persists [CONFIRMED]

**Problem.**

```
$ grep -rl "fillInspectorField" tests/e2e --include="*.spec.ts" | wc -l
0
$ find tests/e2e/workflows/nodes -name "*.spec.ts" | xargs grep -l "persist" | wc -l
46
```

`fillInspectorField` (`workflow-spec-helpers.ts:44-56`) is the **only** helper that types a value
into an inspector field, and it has **zero callers**. Meanwhile 46 of 62 node specs put
"persist" in the test name, and `reopenAndAssertNode` (`:144-151`) only asserts the node _kind_
is on canvas via `getByTestId('wf-node-<kind>')`.

`action-desktop/click.spec.ts:21` is titled _"seeded click renders + elementHandle + button
persist"_ and asserts only that two fields are **visible**. **No node spec ever fills a field
and reads it back.**

**Fix.** In each node spec's persist test: `fillInspectorField` with a distinctive value →
`saveWorkflow` → `reopenAndAssertNode` → **assert the field still holds that value**. Where a
name promises `X + Y persist`, assert X and Y — or rename the test to what it does.

**Verify.** Break the inspector's save path → the persist tests must go red.

**Depends on:** W0.4. **Changeset:** no.

---

#### W3.4 — A real i18n bug is silencing 8 tests [CONFIRMED]

**Problem.** A test found a genuine product bug and was disabled instead of the bug being fixed.

```ts
// plugins/responsive.spec.ts:137-138
const SKIP_AUDIT_FOR_INVALID_I18N_KEYS = sub === "audit"
;(SKIP_AUDIT_FOR_INVALID_I18N_KEYS ? test.skip : test)(...)
// plus a standalone test.skip at :178
```

The comment documents the cause: `i18n/messages/{en,zh-CN}.json` contains **dotted keys** under
`workflows.nodes.*` (e.g. `"trigger.manual"`, `"action.team.run"`) that next-intl rejects as
`INVALID_KEY`. This raises a Next.js dev overlay on any route traversing that namespace —
including the audit sub-tab via `PluginPointDiagnosticsPanel` — covering the page.

**This is shipped, user-facing, and still live.** Related to memory
`i18n-icu-escaping-and-validator`. Note the overlay is a _dev_ artifact, so the static-export
CI path may behave differently — confirm which surface actually breaks for users before scoping.

**Fix.** Reshape the `workflows.nodes` namespace so keys are not dotted (nest them), update both
`en.json` and `zh-CN.json`, run `pnpm i18n:build` and `pnpm lint:i18n`. Then un-skip the 8 tests.
This touches product code and message files — **Working Rule 4 applies**.

**Verify.** `pnpm lint:i18n`; the 8 previously-skipped tests pass; the audit tab renders with no
overlay.

**Changeset:** **yes** — user-facing (`patch`).

---

### WAVE 4 — Cover the core product

#### W4.1 — The main chat flow has zero E2E in the only project that runs [CONFIRMED]

**Problem.** `app/page.tsx` renders `DesktopChatWorkspace` at `/` — the product's primary
surface. It is `goto`'d **166 times**, and **148 of those are immediately followed by
`resetCogniaDb`**: it is a bootstrap-and-wipe springboard, never driven.

```
chromium project (the only desktop project that runs by default): 101 specs
  → specs exercising chat: 0
```

The only chat E2E lives in `tests/e2e/tauri/chat/*` — the project that collects 0 tests (W1.1)
and, once fixed, is Windows-only (W1.4) and doesn't gate PRs.

**The tauri chat specs are good** — real UI driving, real sidecar, real SSE, correct `afterEach`
scenario reset. `reply-renders.spec.ts:43-45` uses a `mock-anthropic-echo` marker as
proof-of-hermeticity, which is a genuinely clever technique. **Port that pattern**, don't
reinvent it.

**Fix.** Add a chromium chat spec driving the real composer against the anthropic mock: type →
send → assert the streamed reply renders → assert the turn persists across reload. The mock
already implements the real Messages SSE sequence (`message_start` → `content_block_delta` →
`message_stop`) and is abort-aware, so interrupt is testable too.

Caveat: `mocks/anthropic/server.ts:337` exposes `/v1/embeddings`, an **OpenAI-shaped endpoint
that does not exist on Anthropic** — fabricated surface. Don't build new assertions on it.
[AGENT — re-verify]

**Verify.** The new spec fails when the send path is broken.

**Depends on:** W0.4. **Changeset:** no.

---

#### W4.2 — The data-loss subsystem is guarded by one button's visibility [CONFIRMED]

**Problem.** `tests/e2e/mobile/backup.spec.ts` — the entire file, for ADR-0001 (data backup /
transfer):

```ts
test("backup card renders + export button is enabled", async ({ page }) => {
  const exportBtn = page.getByRole("button", { name: /export|导出/i }).first()
  await expect(exportBtn).toBeVisible({ timeout: 15_000 })
  await expect(exportBtn).toBeEnabled()
})
```

No export. No import. No round-trip. This is the highest-consequence subsystem in the matrix
(irreversible user data loss) and it has the shallowest test in the suite.

**Fix.** Seed known data → export → wipe the DB → import the export → assert the data is
byte-identical. This is the one test whose absence can cost a user everything.

**Verify.** Corrupt the export serializer → spec red.

**Depends on:** W0.4. **Changeset:** no.

---

#### W4.3 — 79 of 92 routes are never visited [CONFIRMED] → triage [OPEN-3]

**Evidence.** Every route any spec ever navigates to:

```
166 /          19 /pair        15 /settings    14 /workflows/editor
  7 /workflows/runs   7 /workflows   6 /me   5 /plugins   4 /inbox
  3 /workflows/run    3 /discover    2 /skills   1 /share-target   1 /github-delivery
```

13 of 92. Never visited by any spec: `/agent-teams`, `/agent-teams/workspace`, `/memory`,
`/twin`, `/browser`, `/goals`, `/pet`, `/fleet`, `/observability`, `/performance`, `/search`,
`/source-control`, `/share/view`, `/scheduler`, `/remote-sessions`, `/a2ui`, `/agent-runs`,
`/logs`, and **all ~40 `/me/*` settings routes**.

Near-misses that read as coverage but aren't: Twin appears only via `/discover?tab=twin` in two
_mobile_ specs; Agent Team appears only as workflow _nodes_
(`nodes/action-team/{create,run,update}`) — that exercises the node wrapper, not the workspace.

`/settings` covers only 6 `section=` values (`subscription`, `plugins`, `github-delivery`,
`ocr`, `workflows`, `connections`) — and **subscription + ocr are covered only by tauri specs**,
i.e. currently zero.

**Fix.** → **[OPEN-3] in §5.** Do not reflexively write 79 route smoke tests — that reproduces
the `responsive.spec.ts` mistake at 10× scale. Triage by blast radius.

---

## 3. Sequencing & dependencies

```
WAVE 0 ──────────────────────────────────────────────  BLOCKS EVERYTHING
  W0.1 permissions ──┐
  W0.2 dev trigger ──┴─► same commit (never W0.2 alone)
  W0.3 typecheck ────► independent, land early (it's the mechanism behind W1.1)
  W0.4 baseline ─────► needs W0.1+W0.2

WAVE 1 (needs W0.3)          WAVE 2 (needs W0.4)        WAVE 3 (needs W0.4)
  W1.1 fixture scope           W2.1 outbound-queue        W3.1 mock contract ──┐
   ├─► W1.2 binary             W2.2 self-skips           W3.2 strict body  ◄──┘
   ├─► W1.3 setup guard        W2.3 .or() fallbacks       W3.3 persist round-trip
   ├─► W1.4 macOS [OPEN-2]     W2.4 telegram              W3.4 i18n ──► unblocks 8 of W2.5
   └─► W1.5 master cleanup     W2.5 responsive ◄──────────────────────────┘

WAVE 4 (needs W0.4; W4.1 benefits from W1.1's ported patterns)
  W4.1 chat    W4.2 backup round-trip    W4.3 triage [OPEN-3]
```

**Suggested first PR:** W0.1 + W0.2 + W0.3 only. Nothing else. The point is to learn what the
real baseline looks like before committing to the rest — see §0.2.

**Suggested second PR:** W1.1 + W1.3 (both one-liners, both un-ghost 26 tests).

---

## 4. Whole-epic verification

```bash
# 1. The pipeline compiles and runs
gh run list --workflow=ci.yml --limit 5        # no startup_failure

# 2. All projects collect
npx playwright test --list                     # 282+ tests
PLAYWRIGHT_TAURI=1 npx playwright test --list  # still lists ALL projects, +26 tauri

# 3. Typecheck sees the suite
npx tsc --noEmit                               # no NEW errors vs baseline

# 4. Nothing silently skips
npx playwright test --project=chromium --reporter=list | grep -c "skipped"   # → 0

# 5. Mutation spot-checks — the real gate. Each MUST go red:
#    - change merge_method in the github mergePr executor      → W3.1
#    - drop `event` from the review-pr executor                → W3.2
#    - break the inspector save path                           → W3.3
#    - early-return in the outbound queue drain                → W2.1
#    - delete the lg: breakpoint rule from the plugin rail     → W2.5
#    - break the chat send path                                → W4.1
#    - corrupt the backup export serializer                    → W4.2
```

**Item 5 is the only verification that matters.** Green tests are not evidence; tests that go
red when you break the thing are. Every item in Waves 2–4 ships with its mutation check or it
isn't done.

---

## 5. Open decisions — do not decide these silently

### [OPEN-1] How to resolve the permission escalation (blocks W0.1)

`coverage-merge` requests `pull-requests: write` + `checks: write`. Exactly **one** step uses
them: `EnricoMi/publish-unit-test-result-action@v2` (`test.yml:161-166`, gated
`if: github.event_name == 'pull_request'`). 19 of 22 failing runs are Dependabot PRs, which
receive a **read-only token that `permissions:` cannot escalate**.

| Option                                                                                                   | Fixes push | Fixes Dependabot PRs       | Cost                  |
| -------------------------------------------------------------------------------------------------------- | ---------- | -------------------------- | --------------------- |
| **(a)** Add `permissions:` to `ci.yml` granting the write scopes                                         | ✅         | ❌ still `startup_failure` | 3 lines               |
| **(b)** Drop the `Publish Test Results` step; keep artifacts + job summary                               | ✅         | ✅                         | lose in-PR test table |
| **(c)** Move publishing to a separate `workflow_run`-triggered workflow (the standard fork-safe pattern) | ✅         | ✅                         | new workflow file     |

**Recommendation: (b) now, (c) later if the in-PR table is missed.** The repo explicitly values
zero-config (`test.yml` header: _"works OUT-OF-THE-BOX without requiring any secrets"_), and
(b) removes the escalation entirely rather than negotiating around it. **Needs a maintainer
call** — it trades a reporting affordance for a working pipeline.

### [OPEN-2] macOS tauri E2E strategy (blocks W1.4)

Apple ships no WKWebView WebDriver. Tauri's official position: tauri-driver is Windows/Linux
only.

| Option                                                                                                           | Gets macOS | Cost                                                                           |
| ---------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------ |
| **(a)** Accept Windows/Linux-only; keep CDP                                                                      | ❌         | free — but chat/subscription stay untestable on the primary dev machine        |
| **(b)** Migrate to WebdriverIO + `@wdio/tauri-service` (embedded WebDriver server — the **official** macOS path) | ✅         | rewrite the fixture + runner; leaves the Playwright ecosystem for this project |
| **(c)** CrabNebula's cross-platform `tauri-driver` fork                                                          | ✅         | **paid API key** for macOS                                                     |

**Recommendation:** (a) short-term — W1.1–W1.3 already restore the Windows/CI path, which is
where the nightly runs. Then push the _assertions_ down: most of what the tauri chat specs
verify (SSE rendering, interrupt, error reply) can run in chromium against the anthropic mock
(W4.1), leaving tauri to cover only genuinely IPC-bound behavior. Revisit (b) only if the
IPC-bound residue turns out to matter on macOS. **Needs a maintainer call.**

### [OPEN-3] Which of the 79 uncovered routes deserve E2E (blocks W4.3)

Do **not** write 79 smoke tests. Proposed triage, ranked by irreversible damage:

1. **Data loss** — backup/restore (W4.2, already scoped), session import.
2. **Sends to real humans** — inbox / 11 IM connector adapters, github-delivery.
3. **Credentials** — subscription/keyring (currently tauri-only ⇒ zero).
4. **Public exposure** — `/share/view`, share links.
5. **Core value** — chat (W4.1), agent-teams, memory, twin.

Everything below that is likely better served by the existing Jest tier than by E2E.
**Needs a product call on 2–5.**

---

## 6. Source evidence

**Verified by the plan author** (commands re-run, output quoted above): CI run history
(22/22 `startup_failure`; `test.yml` 0 runs), `default_workflow_permissions: read`, absent
`permissions:` in `ci.yml`, `test.yml:102-105`, branch protection 404 + empty rulesets,
`origin/dev` triggers, `master..dev` = 1256, unpushed `20295b83e`, `test:e2e:changed` → 11,835
files, tauri collection error + `exit=1` + whole-run poisoning, `git log` on `fixtures.ts` (1
commit, 2026-05-19), `tsconfig.json` exclude block, `fillInspectorField` 0 callers, 46 "persist"
specs, `defaultBinaryPath` vs `src-tauri/Cargo.toml:2` vs `crates/cognia-cli/Cargo.toml:10`,
`PLAYWRIGHT_TAURI_BIN` override at `test.yml:553`, `master:test.yml:322` `--project=tauri-driver`,
the 12 GitHub spec titles, `capturedCalls`/`waitForCalls`/`setScenario` 0 callers,
`server.ts:218` `?? "COMMENTED"`, `server.ts:133` 404 path, 474 expects / 331 visibility (69%),
route histogram + 79 never-visited routes, `goto("/")` ×166 / 148 followed by `resetCogniaDb`,
chromium 101 specs / 0 chat, `outbound-queue.spec.ts` and `responsive.spec.ts` and
`backup.spec.ts` read end-to-end, 4 self-disabling skips, 7 `waitForTimeout`, 0 `.only`,
`Total: 282 tests in 136 files`.

**Reported by subagent, NOT re-verified** — marked [AGENT] inline, re-verify before acting:
the `.or()` site list beyond `settings-workflows-tabs.spec.ts:27`, locator census (getByTestId
239 / locator 144 / getByRole 96), `telegram-bidirectional` test breakdown, `swipe-row`
always-skips, `db-reset.ts:63-100` boot race, `mocks/anthropic/server.ts:248` `body.stream`
type error, `/v1/embeddings` fabricated surface, `master:test.yml` schedule block, the
~90/282 "cannot fail" aggregate.

**External references:**

- [Playwright — Best Practices](https://playwright.dev/docs/best-practices) — test user-visible
  behavior; avoid implementation details (directly indicts W2.5's class-string assertions).
- [Playwright — Test sharding](https://playwright.dev/docs/test-sharding) — the blob/merge
  design in `test.yml` already follows this.
- [Playwright — ARIA snapshots](https://playwright.dev/docs/aria-snapshots) — candidate for
  W2.5's chrome-structure assertions.
- [Tauri v2 — WebDriver](https://v2.tauri.app/develop/tests/webdriver/) — source for [OPEN-2];
  _"only Windows and Linux are supported on desktop, as macOS has no WKWebView driver tool
  available"_.
- [VS Code — smoke tests](https://github.com/microsoft/vscode/blob/main/test/smoke/README.md) —
  _"Hope is your worst enemy in UI tests"_; no arbitrary waits.
- [Element Web — Playwright e2e](https://github.com/element-hq/matrix-react-sdk/blob/develop/docs/playwright.md)
  — testcontainers running a real Synapse rather than mocks; the contrast that makes W3.1's
  unused mock contract so costly.

---

## 7. Execution Record & Baseline (2026-07-17)

Executed in one pass, ~14 commits on `dev` (from `ci: drop write-scope publish step…`
through `test(e2e): static-mode budget…`). One item = one commit wherever files
didn't overlap.

### 7.1 Decisions taken on the OPEN questions

| Question                              | Decision                                                                                                                                                                                                                        | Notes                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **[OPEN-1]** CI permission escalation | **(b)** — the `EnricoMi/publish-unit-test-result-action` step and the `pull-requests/checks: write` scopes are deleted. junit stays in artifacts + job summary.                                                                 | Local `actionlint` shows only pre-existing shellcheck style findings; the compile-level proof needs the first push. |
| **[OPEN-2]** macOS tauri E2E          | **(a)** — tauri project stays Windows-only (CDP is a WebView2 loader feature). global-setup warn-skips the launch off-Windows; cross-platform chat assertions moved to the browser-runnable mobile standalone spec (see 7.3-D). | Documented in `tauri-cdp-launch.ts` header.                                                                         |
| **[OPEN-3]** 79 uncovered routes      | **Only W4.1 + W4.2 this round** (maintainer call). The blast-radius triage in §5 stands as the backlog order: ① backup/session-import ② inbox/connector sends ③ subscription/keyring ④ /share/view ⑤ agent-teams/memory/twin.   |                                                                                                                     |

### 7.2 What changed beyond the plan's letter

- **W0.2 was already merged** (`20295b83e` reached `dev` before execution), so W0.1 shipped alone.
- **W1.5 self-heals**: `origin/master`'s `test.yml` (no `schedule:`, dead `--project=tauri-driver`)
  is simply replaced by `dev`'s corrected copy on the next merge — verified `dev`'s copy is right.
- **W3.4 was already fixed in the product**: the i18n split-source migration nested
  `workflows.nodes.*` properly (zero dotted keys remain). The 8 blocked tests were retired
  with the rest of the responsive sweep rewrite (W2.5) — the settings-workflows audit tab
  now passes without skips.
- The typecheck unlock (W0.3) surfaced 11 errors, including two real bugs the plan didn't
  know about: `getActiveAccountId` reading a nonexistent field (always returned null) and
  the multi-step orchestration spec reading `run.events` (lives in `workflowRunEvents`).

### 7.3 Product defects the new tests exposed (the actual payoff)

- **A. Workflow run-history crash** _(fixed + changeset)_ — `run-list.tsx` read
  `runs[0].workflowSnapshot.name` unguarded; any run row without an embedded snapshot
  (older schema, imports) crashed the whole `/workflows/runs` route. Found the moment the
  rewritten runs-filter spec drove the real page.
- **B. Mobile backup restore impossible** _(fixed + changeset)_ — mobile export ALWAYS
  encrypts, but import fed the envelope straight into `migrateEnvelope`, which throws on
  encrypted input: a phone could never restore its own backup. Import now decrypts with
  the passphrase field (+ passphrase-required / wrong-passphrase copy in both locales).
  The W4.2 round-trip spec (seed → export → wipe → import → data back) is green and
  failed before the fix.
- **C. GitHub workflow executors had no mock seam** _(fixed)_ — `configureMockBaseUrls({github})`
  had NO consumer; runs either phantom-succeeded (trigger fired before the github-delivery
  plugin registered its executors) or would have called api.github.com. `getOctokitForRepo`
  now honors the published mock base URL under `NEXT_PUBLIC_E2E=1` (dead-code-eliminated
  in production), and specs register the fixture repo in the plugin's registry, which also
  waits out plugin activation.
- **D. Standalone (BYOK) chat is dormant** _(NOT fixed — out of scope, pinned)_ —
  `runStandaloneTurn` has zero product callers: the whole BYOK path exists (mode chooser,
  provider settings, engine, unit tests) but the mobile composer's send was never routed
  to it. The W4.1 spec is checked in as `test.fixme` and is the acceptance test for the
  wiring. This also means the primary chat flow STILL has no runnable E2E in a默认 project
  until either this wiring lands or the tauri nightly is treated as the gate.
- **E. Pull-to-refresh dies under real touch** _(NOT fixed — candidate)_ — the primitive
  sets no `touch-action`, so a vertical touch drag becomes a native scroll gesture and the
  pointer stream is cancelled; on real phones the pull likely rubber-bands a few px and
  dies. The spec pins the component contract via synthetic pointers and documents this.
- **F. Boot-time schema-upgrade wedge** _(mitigated in test infra — product candidate)_ —
  `page.reload()` leaves the old document's IndexedDB connections alive long enough to
  block the plugin manager's dynamic Dexie bump ("Upgrade 'cognia-claude' blocked by other
  connection"); test infra now re-boots through `about:blank` (boot-to-ready ~2s, stable).
  Under parallel workers, plugin activation itself has been measured at 10-45s (solo ~5s) —
  hence the 60s static / 90s mobile budgets and `test.slow()` on the github specs. A
  product-side look at the dynamic `version().stores()`-on-every-boot design is warranted.

### 7.4 Baseline (2026-07-17, static export, workers=4, this machine)

Run after all waves landed. **Two consecutive runs** of
`PLAYWRIGHT_STATIC=1 npx playwright test --project=chromium --project=mobile-pixel-7`:

| Run | passed | failed | skipped | wall-clock |
| --- | ------ | ------ | ------- | ---------- |
| 1   | 155    | 71     | 2       | 16.4m      |
| 2   | 155    | 71     | 2       | 16.3m      |

**Flakes: zero.** The failure SET is byte-identical across both runs (symmetric
difference = 0, 71 in common) — the suite is fully deterministic on this machine at
`workers=4`. The 2 skips are the deliberate `fixme` (standalone chat) pair.

Failure taxonomy (run 1, 71 total):

| Class                                       | Count | Reading                                                                                                                                                                                                                               |
| ------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toBeVisible` / element not found           | 28    | Mixed: contention-slow mounts + genuinely missing UI in untouched legacy specs                                                                                                                                                        |
| interaction timeouts (click/fill at 60-90s) | ~18   | Full-suite load profile; these same specs pass solo/2-worker                                                                                                                                                                          |
| run-status equality (`failed:` runs)        | 13    | Mostly `action-github/*` under load — executor runs exceed activation/HTTP windows                                                                                                                                                    |
| dead-by-construction legacy specs           | ~7    | `import("@/…")` inside `page.evaluate` (workflows/runs/rerun/run-detail/run-list/event-log-replay), one invalid CSS selector (`[data-step=3]`), one `fill()` on a non-editable — these can never have passed and are now honestly red |

By directory: mobile 28 · workflows 18 · action-github 12 · workflows/editor 7 ·
workflows/runs 4 · other 2.

Known-red classes going into CI:

- `action-github/*` "manual run" specs flake under 4-worker contention on this machine
  (plugin-activation latency, 7.3-F) while passing solo/2-worker — treat wall-clock and
  worker count as the first CI tuning knobs (CI runners have 2 cores; consider `--workers=2`
  for the e2e job).
- `standalone-chat.spec.ts` is `fixme` by design (7.3-D).
- Anything not touched by this epic keeps whatever state the baseline shows; the numbers
  below are the honest starting line, not a claim of green.

### 7.5 Follow-ups (ordered)

1. Push `dev` → confirm the pipeline compiles (first-ever CI run) and capture the CI-side
   baseline; tune e2e workers/sharding if the contention class from 7.4 reproduces.
2. Wire the standalone chat engine (7.3-D) and flip the W4.1 spec from `fixme` to live.
3. Product fixes for 7.3-E (touch-action) and 7.3-F (plugin Dexie bump design).
4. Continue the OPEN-3 triage ladder: ② connector sends → ③ subscription/keyring →
   ④ /share/view → ⑤ agent-teams/memory/twin.
5. Extend the persist round-trip pattern (fill → save → reopen → read back,
   `expectInspectorFieldValue`) from the 6 representative node specs to the rest as they
   are touched; titles were already de-falsified suite-wide.
