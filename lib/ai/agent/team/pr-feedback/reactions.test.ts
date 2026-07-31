import { buildNudgeIntents, PrReactionEngine, REVIEW_MAX_NUDGE, type PrNudge } from "./reactions"
import type { PrObservation } from "@/lib/github/pr-observe/types"

const ESC = String.fromCharCode(0x1b)

function mkObs(over: Partial<PrObservation> = {}): PrObservation {
  const base: PrObservation = {
    fetched: true,
    observedAt: 1,
    repo: "acme/app",
    pr: {
      url: "https://gh/acme/app/pull/5",
      number: 5,
      state: "open",
      draft: false,
      merged: false,
      closed: false,
      sourceBranch: "b",
      targetBranch: "main",
      headSha: "s",
      title: "t",
      additions: 1,
      deletions: 0,
      author: "dev",
    },
    ci: { summary: "passing", headSha: "s", failedChecks: [] },
    review: { decision: "none", threads: [] },
    mergeability: { state: "mergeable", mergeable: true, conflict: false, behindBase: false },
    changed: { metadata: false, ci: false, review: false },
  }
  return { ...base, ...over }
}

function failingCi(commit = "c1", logTail = "boom"): PrObservation["ci"] {
  return {
    summary: "failing",
    headSha: commit,
    failedChecks: [
      { name: "build", status: "completed", conclusion: "failure", commitHash: commit, logTail },
    ],
  }
}

describe("buildNudgeIntents", () => {
  it("returns nothing for an unfetched or terminal/draft PR", () => {
    expect(buildNudgeIntents(mkObs({ fetched: false }))).toEqual([])
    expect(buildNudgeIntents(mkObs({ pr: { ...mkObs().pr, merged: true } }))).toEqual([])
    expect(buildNudgeIntents(mkObs({ pr: { ...mkObs().pr, closed: true } }))).toEqual([])
    expect(buildNudgeIntents(mkObs({ pr: { ...mkObs().pr, draft: true } }))).toEqual([])
  })

  it("builds a CI nudge naming failing checks with a sanitized log tail", () => {
    const obs = mkObs({ ci: failingCi("c1", `${ESC}[31mERROR line${ESC}[0m`) })
    const [intent] = buildNudgeIntents(obs)
    expect(intent.category).toBe("ci")
    expect(intent.key).toBe("ci:https://gh/acme/app/pull/5")
    expect(intent.maxAttempts).toBe(0)
    expect(intent.message).toContain("CI is failing on your PR: build")
    expect(intent.message).toContain("ERROR line")
    expect(intent.message).not.toContain(ESC)
    expect(intent.sig).toContain("c1")
  })

  it("uses a generic CI message when no check names are present", () => {
    const obs = mkObs({
      ci: {
        summary: "failing",
        headSha: "c",
        failedChecks: [{ name: "", status: "completed", conclusion: "failure", commitHash: "c" }],
      },
    })
    expect(buildNudgeIntents(obs)[0].message).toBe(
      "CI is failing on your PR. Review the output below and push a fix."
    )
  })

  it("builds a review nudge from requested changes with comment bodies", () => {
    const obs = mkObs({
      review: {
        decision: "changes_requested",
        threads: [
          {
            id: "t1",
            path: "x.ts",
            line: 1,
            resolved: false,
            isBot: false,
            comments: [{ id: "c1", author: "rev", body: "please fix", isBot: false }],
          },
        ],
      },
    })
    const [intent] = buildNudgeIntents(obs)
    expect(intent.category).toBe("review")
    expect(intent.maxAttempts).toBe(REVIEW_MAX_NUDGE)
    expect(intent.message).toContain("A reviewer left feedback")
    expect(intent.message).toContain("please fix")
    expect(intent.sig).toBe("c1")
  })

  it("uses the decision as the review signature when there are no comment ids", () => {
    const obs = mkObs({ review: { decision: "changes_requested", threads: [] } })
    expect(buildNudgeIntents(obs)[0].sig).toBe("changes_requested")
  })

  it("builds a review nudge from an unresolved comment even without a decision", () => {
    const obs = mkObs({
      review: {
        decision: "none",
        threads: [
          {
            id: "t",
            path: "z",
            line: 2,
            resolved: false,
            isBot: false,
            comments: [{ id: "c9", author: "h", body: "hmm", isBot: false }],
          },
        ],
      },
    })
    expect(buildNudgeIntents(obs)[0].category).toBe("review")
  })

  it("builds a merge-conflict nudge", () => {
    const obs = mkObs({
      mergeability: { state: "conflicting", mergeable: false, conflict: true, behindBase: false },
    })
    const [intent] = buildNudgeIntents(obs)
    expect(intent.category).toBe("conflict")
    expect(intent.message).toContain("merge conflicts")
    expect(intent.sig).toBe("conflicting")
  })

  it("CI failure short-circuits ahead of review and conflict", () => {
    const obs = mkObs({
      ci: failingCi(),
      review: { decision: "changes_requested", threads: [] },
      mergeability: { state: "conflicting", mergeable: false, conflict: true, behindBase: false },
    })
    expect(buildNudgeIntents(obs).map((i) => i.category)).toEqual(["ci"])
  })

  it("review short-circuits ahead of conflict", () => {
    const obs = mkObs({
      review: { decision: "changes_requested", threads: [] },
      mergeability: { state: "conflicting", mergeable: false, conflict: true, behindBase: false },
    })
    expect(buildNudgeIntents(obs).map((i) => i.category)).toEqual(["review"])
  })
})

// ── engine ────────────────────────────────────────────────────────────────────

function makeEngine(over: { maxPerHour?: number; busyWindowMs?: number } = {}) {
  let clock = 1_000_000
  const captured: PrNudge[] = []
  const engine = new PrReactionEngine({
    now: () => clock,
    maxPerHour: over.maxPerHour ?? 100,
    busyWindowMs: over.busyWindowMs,
  })
  const ctx = { memberId: "m1", deliver: (n: PrNudge) => captured.push(n) }
  return {
    engine,
    captured,
    ctx,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

const ELEVEN_MIN = 11 * 60_000

describe("PrReactionEngine", () => {
  it("delivers a CI nudge once, dedups identical feedback, re-fires on a new commit", () => {
    const { engine, captured, ctx, advance } = makeEngine()
    engine.react(mkObs({ ci: failingCi("c1") }), ctx)
    engine.react(mkObs({ ci: failingCi("c1") }), ctx) // identical → dedup
    expect(captured).toHaveLength(1)
    expect(captured[0].generation).toBe(1)

    advance(ELEVEN_MIN) // clear the per-member cooldown
    engine.react(mkObs({ ci: failingCi("c2") }), ctx) // new commit → new sig
    expect(captured).toHaveLength(2)
    expect(captured[1].generation).toBe(2)
  })

  it("caps a review key at REVIEW_MAX_NUDGE distinct signatures", () => {
    const { engine, captured, ctx, advance } = makeEngine()
    for (let i = 0; i < REVIEW_MAX_NUDGE + 2; i++) {
      engine.react(
        mkObs({
          review: {
            decision: "changes_requested",
            threads: [
              {
                id: "t",
                path: "x",
                line: 1,
                resolved: false,
                isBot: false,
                comments: [{ id: `c${i}`, author: "r", body: "b", isBot: false }],
              },
            ],
          },
        }),
        ctx
      )
      advance(ELEVEN_MIN)
    }
    expect(captured).toHaveLength(REVIEW_MAX_NUDGE)
  })

  it("respects the per-member hourly cap", () => {
    const { engine, captured, ctx, advance } = makeEngine({ maxPerHour: 2 })
    // Three distinct PRs failing CI; the 3rd is rate-limited within the hour.
    for (const url of ["p/1", "p/2", "p/3"]) {
      engine.react(mkObs({ pr: { ...mkObs().pr, url }, ci: failingCi() }), ctx)
      advance(ELEVEN_MIN)
    }
    expect(captured).toHaveLength(2)
  })

  it("defers while the member is busy (recent tool activity)", () => {
    const { engine, captured } = makeEngine({ busyWindowMs: 60_000 })
    engine.react(mkObs({ ci: failingCi() }), {
      memberId: "m1",
      lastToolActivityAt: 1_000_000 - 100,
      deliver: (n) => captured.push(n),
    })
    expect(captured).toHaveLength(0)
  })

  it("redacts PII in the outbound message", () => {
    const { engine, captured, ctx } = makeEngine()
    engine.react(
      mkObs({
        review: {
          decision: "changes_requested",
          threads: [
            {
              id: "t",
              path: "x",
              line: 1,
              resolved: false,
              isBot: false,
              comments: [
                { id: "c", author: "r", body: "email me at alice@example.com", isBot: false },
              ],
            },
          ],
        },
      }),
      ctx
    )
    expect(captured).toHaveLength(1)
    expect(captured[0].message).not.toContain("alice@example.com")
    expect(captured[0].message).toContain("<EMAIL")
  })

  it("hydrates persisted dedup state so it does not re-nudge, and round-trips export", () => {
    const first = makeEngine()
    first.engine.react(mkObs({ ci: failingCi("c1") }), first.ctx)
    const sig = first.engine.exportSignature()
    expect(sig.seen?.["ci:https://gh/acme/app/pull/5"]).toBeDefined()

    const second = makeEngine()
    second.engine.hydrate(sig)
    second.engine.react(mkObs({ ci: failingCi("c1") }), second.ctx) // same sig → suppressed
    expect(second.captured).toHaveLength(0)
  })

  it("hydrate is idempotent and keeps the higher attempt count", () => {
    const { engine } = makeEngine()
    engine.hydrate({ seen: { k: "v" }, attempts: { k: 1 } })
    engine.hydrate({ seen: { k: "other" }, attempts: { k: 3 } }) // existing seen wins, higher attempts wins
    const out = engine.exportSignature()
    expect(out.seen).toEqual({ k: "v" })
    expect(out.attempts).toEqual({ k: 3 })
  })

  it("hydrate tolerates undefined", () => {
    const { engine } = makeEngine()
    expect(() => engine.hydrate(undefined)).not.toThrow()
  })
})
