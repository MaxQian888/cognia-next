// The ladder's own contract, with small hand-built profiles. The real rail
// profiles are pinned end to end by ./ladder.pins.test.ts.

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  buildApprovalRequiredSet,
  buildPerCallApprovalSet,
  decidePermission,
  firstHardDenial,
  requiresPerCallApproval,
} from "./ladder.ts"
import type { LadderCall, LadderPolicy, LadderStep, RailProfile } from "./ladder.ts"

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cognia-ladder-unit-")))
const WRITE = "mcp__cognia-tools__write"
const READ = "mcp__cognia-tools__read"
const ASK_USER = "mcp__cognia-plugin-tools__ask_user"

function profile(steps: LadderStep[], extra: Partial<RailProfile> = {}): RailProfile {
  return { steps, confinementErrors: "ignore", acceptsEdit: () => false, ...extra }
}

function policy(extra: Partial<LadderPolicy> = {}): LadderPolicy {
  return {
    mode: "default",
    ruleset: undefined,
    suppress: null,
    alwaysAllow: null,
    confinement: undefined,
    sandboxScope: undefined,
    cwd: ROOT,
    pluginAccess: new Map(),
    ...extra,
  }
}

function call(toolName: string, input: unknown, extra: Partial<LadderCall> = {}): LadderCall {
  return { toolName, input, policy: policy(), canPrompt: true, ...extra }
}

function countingGuard(answer: "ask" | null) {
  const seen: string[] = []
  return { seen, check: (toolName: string) => (seen.push(toolName), answer) }
}

const CONFINED = { enabled: true, roots: [ROOT] }
const CREDENTIAL = { file_path: path.join(ROOT, ".ssh", "id_rsa"), content: "x" }
const OUTSIDE = { file_path: path.join(os.tmpdir(), "elsewhere", "a.ts"), content: "x" }

test("a profile with no steps asks", () => {
  assert.deepEqual(decidePermission(profile([]), call(WRITE, {})), { kind: "ask" })
})

test("the first step with an opinion wins, so the profile's order decides", () => {
  const both = call(WRITE, CREDENTIAL, {
    policy: policy({ mode: "plan", confinement: CONFINED }),
  })
  const credentialFirst = decidePermission(profile(["credential-path", "plan-mode-emulated"]), both)
  const planFirst = decidePermission(profile(["plan-mode-emulated", "credential-path"]), both)
  assert.deepEqual(credentialFirst, { kind: "deny", reason: { code: "credential-path" } })
  assert.deepEqual(planFirst, { kind: "deny", reason: { code: "plan-mode" } })
})

test("an aborted signal denies before anything else runs", () => {
  const controller = new AbortController()
  controller.abort()
  const guard = countingGuard(null)
  const outcome = decidePermission(profile(["interrupted", "doom"]), {
    ...call(READ, {}),
    signal: controller.signal,
    doomGuard: guard,
  })
  assert.deepEqual(outcome, { kind: "deny", reason: { code: "interrupted" } })
  assert.deepEqual(guard.seen, [])
})

test("the PII step denies input that would leak personal data", () => {
  const steps = profile(["input-pii"])
  assert.deepEqual(decidePermission(steps, call(WRITE, { content: "mail a@example.com" })), {
    kind: "deny",
    reason: { code: "input-pii" },
  })
  assert.deepEqual(decidePermission(steps, call(WRITE, { content: "hello" })), { kind: "ask" })
})

test("a sandbox-scope refusal carries the enforcer's own error", () => {
  const outcome = decidePermission(
    profile(["sandbox-scope"]),
    call(WRITE, OUTSIDE, { policy: policy({ sandboxScope: { writableRoots: [ROOT] } }) })
  )
  assert.equal(outcome.kind, "deny")
  assert.ok(outcome.kind === "deny" && outcome.reason.code === "sandbox-scope")
  assert.ok(outcome.reason.error instanceof Error)
  assert.match(outcome.reason.error.message, /sandbox\.policy\.writableRoots/)
})

test("a throwing ruleset fails the call instead of falling through", () => {
  const exploding = new Proxy(
    {},
    {
      get() {
        throw new Error("boom")
      },
      ownKeys() {
        throw new Error("boom")
      },
    }
  )
  assert.throws(
    () =>
      decidePermission(
        profile(["ruleset"]),
        call(WRITE, {}, { policy: policy({ ruleset: exploding }) })
      ),
    /boom/
  )
})

test("confinementErrors picks between failing the call and ignoring the classifier", () => {
  const exploding = {
    get enabled(): boolean {
      throw new Error("bad policy")
    },
  }
  const c = call(WRITE, CREDENTIAL, { policy: policy({ confinement: exploding }) })
  assert.throws(
    () => decidePermission(profile(["credential-path"], { confinementErrors: "throw" }), c),
    /bad policy/
  )
  assert.deepEqual(decidePermission(profile(["credential-path"]), c), { kind: "ask" })
})

test("ask_user passes, and the Cognia-only plan step leaves it and foreign tools alone", () => {
  assert.deepEqual(decidePermission(profile(["ask-user"]), call(ASK_USER, {})), { kind: "allow" })
  const plan = profile(["plan-mode-cognia"])
  const inPlan = (toolName: string) =>
    decidePermission(plan, call(toolName, {}, { policy: policy({ mode: "plan" }) }))
  assert.deepEqual(inPlan(ASK_USER), { kind: "ask" })
  assert.deepEqual(inPlan("mcp__github__create_issue"), { kind: "ask" })
  assert.deepEqual(inPlan("Write"), { kind: "ask" })
  assert.deepEqual(inPlan(READ), { kind: "ask" })
  assert.deepEqual(inPlan(WRITE), { kind: "deny", reason: { code: "plan-mode" } })
})

test("emulated plan mode allows read-only tools and the exit signal, and denies the rest", () => {
  const plan = profile(["plan-mode-emulated"])
  const inPlan = (toolName: string) =>
    decidePermission(plan, call(toolName, {}, { policy: policy({ mode: "plan" }) })).kind
  assert.equal(inPlan(READ), "allow")
  assert.equal(inPlan("mcp__cognia-tools__exit_plan_mode"), "allow")
  assert.equal(inPlan("mcp__cognia-plugin-tools__dispatch_agent"), "allow")
  assert.equal(inPlan(WRITE), "deny")
  assert.equal(inPlan("mcp__github__create_issue"), "deny")
  assert.equal(
    decidePermission(plan, call(WRITE, {}, { policy: policy({ mode: "default" }) })).kind,
    "ask"
  )
})

test("a doomed repeat disarms bypass and every grant", () => {
  const steps = profile(["doom", "bypass", "grants"])
  const granted = policy({
    mode: "bypassPermissions",
    suppress: [WRITE],
    alwaysAllow: [WRITE],
    ruleset: { [WRITE]: "allow" },
  })
  const doomed = countingGuard("ask")
  assert.deepEqual(
    decidePermission(steps, call(WRITE, {}, { policy: granted, doomGuard: doomed })),
    {
      kind: "ask",
    }
  )
  assert.deepEqual(doomed.seen, [WRITE])
  const fine = countingGuard(null)
  assert.deepEqual(decidePermission(steps, call(WRITE, {}, { policy: granted, doomGuard: fine })), {
    kind: "allow",
  })
})

test("grants: suppress, always-allow and a truthy ruleset's allow, unless confinement asks", () => {
  const steps = profile(["grants"])
  for (const grant of [
    { suppress: [WRITE] },
    { alwaysAllow: [WRITE] },
    { ruleset: { [WRITE]: "allow" } },
  ]) {
    assert.equal(decidePermission(steps, call(WRITE, {}, { policy: policy(grant) })).kind, "allow")
    const escaping = policy({ ...grant, confinement: CONFINED })
    assert.equal(decidePermission(steps, call(WRITE, OUTSIDE, { policy: escaping })).kind, "ask")
  }
  assert.equal(
    decidePermission(steps, call(WRITE, {}, { policy: policy({ ruleset: null }) })).kind,
    "ask"
  )
})

test("acceptEdits consults the profile's edit set only in acceptEdits mode", () => {
  const steps = profile(["grants"], { acceptsEdit: (toolName) => toolName === WRITE })
  const inMode = (mode: string, input: unknown = {}, confinement?: typeof CONFINED) =>
    decidePermission(steps, call(WRITE, input, { policy: policy({ mode, confinement }) })).kind
  assert.equal(inMode("acceptEdits"), "allow")
  assert.equal(inMode("default"), "ask")
  assert.equal(inMode("acceptEdits", OUTSIDE, CONFINED), "ask")
})

test("dontAsk allows read-only built-ins and grants, and denies everything else", () => {
  const steps = profile(["doom", "dont-ask"])
  const dontAsk = (
    toolName: string,
    extra: Partial<LadderPolicy> = {},
    doom: "ask" | null = null
  ) =>
    decidePermission(
      steps,
      call(
        toolName,
        {},
        {
          policy: policy({ mode: "dontAsk", ...extra }),
          doomGuard: countingGuard(doom),
        }
      )
    )
  assert.equal(dontAsk(READ).kind, "allow")
  assert.equal(dontAsk(WRITE, { suppress: [WRITE] }).kind, "allow")
  assert.deepEqual(dontAsk(WRITE), { kind: "deny", reason: { code: "dont-ask" } })
  assert.deepEqual(dontAsk(READ, {}, "ask"), { kind: "deny", reason: { code: "dont-ask" } })
})

test("with no approval channel only read-only built-ins pass", () => {
  const steps = profile(["approval-channel"])
  assert.equal(decidePermission(steps, call(READ, {}, { canPrompt: false })).kind, "allow")
  assert.deepEqual(decidePermission(steps, call(WRITE, {}, { canPrompt: false })), {
    kind: "deny",
    reason: { code: "no-approval-channel" },
  })
  assert.equal(decidePermission(steps, call(WRITE, {})).kind, "ask")
})

test("firstHardDenial runs only the checks it is given and never counts a doom call", () => {
  const guard = countingGuard("ask")
  const rail = profile(["doom", "ruleset"])
  const c = call(
    WRITE,
    {},
    {
      policy: policy({ ruleset: { [WRITE]: "deny" } }),
      doomGuard: guard,
    }
  )
  assert.deepEqual(firstHardDenial(rail, ["ruleset"], c), { code: "ruleset" })
  assert.equal(firstHardDenial(rail, ["interrupted"], c), undefined)
  assert.deepEqual(guard.seen, [])
})

// ADR-0201: a plugin tool that declared `requiresApproval` (browser_fill_credential)
// asks a human on every call — no grant, ruleset allow, acceptEdits or bypass
// may skip it, and dontAsk denies it.
const FILL = "mcp__cognia-plugin-tools__browser_fill_credential"
const NAVIGATE = "mcp__cognia-plugin-tools__browser_navigate"
const SET_FILES = "mcp__cognia-plugin-tools__browser_set_files"
const MANIFEST = [
  { name: "browser_fill_credential", requiresApproval: true },
  { name: "browser_set_files", requiresApproval: true },
  { name: "browser_evaluate", requiresApproval: true },
  { name: "browser_navigate", requiresApproval: false },
  { name: "ask_user", requiresApproval: true },
  { name: 42, requiresApproval: true },
  null,
]
const PER_CALL = buildPerCallApprovalSet(MANIFEST)

test("the per-call set keeps only listed plugin tools that declared requiresApproval", () => {
  assert.deepEqual(
    [...buildApprovalRequiredSet(MANIFEST)],
    ["browser_fill_credential", "browser_set_files", "browser_evaluate"]
  )
  assert.deepEqual([...PER_CALL], ["browser_fill_credential", "browser_set_files"])
  assert.equal(requiresPerCallApproval(SET_FILES, PER_CALL), true)
  assert.deepEqual([...buildPerCallApprovalSet([{ name: "browser_set_files" }])], [])
  // A name alone does not qualify: the manifest must declare it.
  assert.deepEqual([...buildPerCallApprovalSet([{ name: "browser_fill_credential" }])], [])
  assert.deepEqual([...buildPerCallApprovalSet(undefined)], [])
  assert.equal(requiresPerCallApproval(FILL, PER_CALL), true)
  assert.equal(requiresPerCallApproval(NAVIGATE, PER_CALL), false)
  assert.equal(requiresPerCallApproval("mcp__other__browser_fill_credential", PER_CALL), false)
  assert.equal(requiresPerCallApproval(FILL, null), false)
})

test("a per-call tool skips every allow shortcut and asks", () => {
  const steps = profile(["bypass", "grants"], { acceptsEdit: () => true })
  for (const tool of [FILL, SET_FILES]) {
    for (const mode of ["bypassPermissions", "acceptEdits", "default"]) {
      const granted = call(
        tool,
        { ref: "f", paths: ["a.txt"] },
        {
          policy: policy({
            mode,
            alwaysAllow: [tool],
            suppress: [tool],
            perCallApproval: PER_CALL,
          }),
        }
      )
      assert.deepEqual(decidePermission(steps, granted), { kind: "ask" })
    }
  }
  // The same grants still allow a tool that did not declare it.
  const other = call(
    NAVIGATE,
    {},
    {
      policy: policy({ alwaysAllow: [NAVIGATE], perCallApproval: PER_CALL }),
    }
  )
  assert.deepEqual(decidePermission(steps, other), { kind: "allow" })
})

test("dontAsk denies a per-call tool even when granted", () => {
  for (const tool of [FILL, SET_FILES]) {
    const outcome = decidePermission(
      profile(["dont-ask"]),
      call(
        tool,
        {},
        { policy: policy({ mode: "dontAsk", alwaysAllow: [tool], perCallApproval: PER_CALL }) }
      )
    )
    assert.deepEqual(outcome, { kind: "deny", reason: { code: "dont-ask" } })
  }
})
