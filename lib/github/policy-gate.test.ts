import { checkPolicy, mergePolicy } from "./policy-gate"
import { DEFAULT_GH_POLICY, type GhAction, type GhPolicy, type GhPolicyContext } from "./types"

const baseCtx = (overrides: Partial<GhPolicyContext> = {}): GhPolicyContext => ({
  policy: DEFAULT_GH_POLICY,
  now: Date.UTC(2026, 4, 12, 14, 0), // weekday afternoon — outside any quiet hours
  mergesTodayCount: 0,
  authorLogin: undefined,
  ciStatus: undefined,
  humanApproved: false,
  knownAllowedLogins: undefined,
  ...overrides,
})

const PR = { repo: "octocat/hello-world", prNumber: 1 }
const ISSUE = { repo: "octocat/hello-world", issueNumber: 1 }

describe("checkPolicy — merge", () => {
  const action: GhAction = { kind: "merge", pr: PR }

  it("denies when CI is not green", () => {
    const decision = checkPolicy(action, baseCtx({ ciStatus: "failure", humanApproved: true }))
    expect(decision.allow).toBe(false)
    if (!decision.allow) expect(decision.reason).toMatch(/CI=success/)
  })

  it("denies when human approval is missing", () => {
    const decision = checkPolicy(action, baseCtx({ ciStatus: "success", humanApproved: false }))
    expect(decision.allow).toBe(false)
    if (!decision.allow) expect(decision.reason).toMatch(/human approval/)
  })

  it("denies when daily merge cap reached", () => {
    const decision = checkPolicy(
      action,
      baseCtx({
        ciStatus: "success",
        humanApproved: true,
        mergesTodayCount: 5, // == DEFAULT_GH_POLICY.maxDailyMerges
      })
    )
    expect(decision.allow).toBe(false)
    if (!decision.allow) expect(decision.reason).toMatch(/daily merge cap/)
  })

  it("allows when CI green + approved + under cap and no author check needed", () => {
    const decision = checkPolicy(
      action,
      baseCtx({ ciStatus: "success", humanApproved: true, mergesTodayCount: 0 })
    )
    expect(decision.allow).toBe(true)
  })

  it("denies when author is not on the explicit allow-list", () => {
    const policy: GhPolicy = {
      ...DEFAULT_GH_POLICY,
      allowedAuthors: { kind: "explicit", logins: ["alice", "bob"] },
    }
    const decision = checkPolicy(
      action,
      baseCtx({
        policy,
        ciStatus: "success",
        humanApproved: true,
        authorLogin: "eve",
      })
    )
    expect(decision.allow).toBe(false)
    if (!decision.allow) expect(decision.reason).toMatch(/explicit allow-list/)
  })

  it("denies collaborators-mode merge when knownAllowedLogins is missing", () => {
    const decision = checkPolicy(
      action,
      baseCtx({
        ciStatus: "success",
        humanApproved: true,
        authorLogin: "alice",
      })
    )
    expect(decision.allow).toBe(false)
    if (!decision.allow) expect(decision.reason).toMatch(/knownAllowedLogins/)
  })

  it("allows collaborators-mode merge when author is in knownAllowedLogins", () => {
    const decision = checkPolicy(
      action,
      baseCtx({
        ciStatus: "success",
        humanApproved: true,
        authorLogin: "alice",
        knownAllowedLogins: ["alice", "bob"],
      })
    )
    expect(decision.allow).toBe(true)
  })
})

describe("checkPolicy — push", () => {
  it("denies pushes to a protected branch", () => {
    const action: GhAction = { kind: "push", repo: "o/r", branch: "main" }
    const decision = checkPolicy(action, baseCtx())
    expect(decision.allow).toBe(false)
    if (!decision.allow) expect(decision.reason).toMatch(/protection regex/)
  })

  it("allows pushes to a feature branch", () => {
    const action: GhAction = { kind: "push", repo: "o/r", branch: "feat/x" }
    expect(checkPolicy(action, baseCtx()).allow).toBe(true)
  })

  it("denies push to release/* branches per default policy", () => {
    const action: GhAction = { kind: "push", repo: "o/r", branch: "release/v1.0" }
    expect(checkPolicy(action, baseCtx()).allow).toBe(false)
  })
})

describe("checkPolicy — release", () => {
  it("always allows draft releases", () => {
    const action: GhAction = { kind: "release", repo: "o/r", tag: "v1", draft: true }
    expect(checkPolicy(action, baseCtx()).allow).toBe(true)
  })

  it("denies non-draft release without human approval", () => {
    const action: GhAction = { kind: "release", repo: "o/r", tag: "v1", draft: false }
    expect(checkPolicy(action, baseCtx({ humanApproved: false })).allow).toBe(false)
  })

  it("allows non-draft release when humanApproved", () => {
    const action: GhAction = { kind: "release", repo: "o/r", tag: "v1", draft: false }
    expect(checkPolicy(action, baseCtx({ humanApproved: true })).allow).toBe(true)
  })
})

describe("checkPolicy — comment / label / close", () => {
  it("allows comment with no author check", () => {
    const action: GhAction = { kind: "comment", pr: PR, body: "hello" }
    expect(checkPolicy(action, baseCtx()).allow).toBe(true)
  })

  it("denies comment from disallowed explicit author", () => {
    const policy: GhPolicy = {
      ...DEFAULT_GH_POLICY,
      allowedAuthors: { kind: "explicit", logins: ["alice"] },
    }
    const action: GhAction = { kind: "comment", pr: PR, body: "hi" }
    expect(checkPolicy(action, baseCtx({ policy, authorLogin: "eve" })).allow).toBe(false)
  })

  it("allows label with no author", () => {
    const action: GhAction = { kind: "label", target: ISSUE, labels: ["bug"] }
    expect(checkPolicy(action, baseCtx()).allow).toBe(true)
  })

  it("allows close action when author allow-list passes", () => {
    const policy: GhPolicy = {
      ...DEFAULT_GH_POLICY,
      allowedAuthors: { kind: "explicit", logins: ["alice"] },
    }
    const action: GhAction = { kind: "close", target: ISSUE }
    expect(checkPolicy(action, baseCtx({ policy, authorLogin: "alice" })).allow).toBe(true)
  })
})

describe("checkPolicy — quietHours", () => {
  it("denies during quiet hours and emits mustWait.until", () => {
    const policy: GhPolicy = {
      ...DEFAULT_GH_POLICY,
      // 00:00 → 23:59 UTC always covers the test instant.
      quietHours: { from: "00:00", to: "23:59", tz: "UTC" },
    }
    const action: GhAction = { kind: "comment", pr: PR, body: "hi" }
    const decision = checkPolicy(action, baseCtx({ policy }))
    expect(decision.allow).toBe(false)
    if (!decision.allow) {
      expect(decision.reason).toMatch(/quiet hours/)
      expect(decision.mustWait?.until).toBeGreaterThan(0)
    }
  })

  it("allows when current time is outside quietHours", () => {
    // Set a 3-hour window from 02:00–05:00 UTC. Test ctx uses 14:00 UTC.
    const policy: GhPolicy = {
      ...DEFAULT_GH_POLICY,
      quietHours: { from: "02:00", to: "05:00", tz: "UTC" },
    }
    const action: GhAction = { kind: "comment", pr: PR, body: "hi" }
    expect(checkPolicy(action, baseCtx({ policy })).allow).toBe(true)
  })
})

describe("mergePolicy", () => {
  it("returns base unchanged when no override", () => {
    expect(mergePolicy(DEFAULT_GH_POLICY)).toEqual(DEFAULT_GH_POLICY)
  })

  it("overlays scalar fields", () => {
    const merged = mergePolicy(DEFAULT_GH_POLICY, { maxDailyMerges: 1 })
    expect(merged.maxDailyMerges).toBe(1)
    expect(merged.requireGreenCi).toBe(true)
  })

  it("replaces array and object fields rather than concatenating", () => {
    const merged = mergePolicy(DEFAULT_GH_POLICY, {
      branchProtection: ["^prod/"],
      allowedAuthors: { kind: "explicit", logins: ["x"] },
    })
    expect(merged.branchProtection).toEqual(["^prod/"])
    expect(merged.allowedAuthors).toEqual({ kind: "explicit", logins: ["x"] })
  })
})
