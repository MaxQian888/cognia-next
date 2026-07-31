import {
  createRealPrFeedbackTimers,
  PrFeedbackController,
  type PrFeedbackDeps,
  type PrObservationRecord,
  type TimerHandle,
} from "./observer"
import type { TeammatePrBinding } from "./binding"
import type { NudgeIntent, PrNudge } from "./reactions"
import type { PrObservation } from "@/lib/github/pr-observe/types"

// ── deterministic async timer harness ─────────────────────────────────────────
// setTimer callbacks are async (they await pollOnce, which reschedules in its
// finally), so `tick()` awaits the fired callback fully before returning.

function harness() {
  let now = 0
  let seq = 0
  const timers: Array<{
    at: number
    fn: () => void | Promise<void>
    handle: TimerHandle
    id: number
  }> = []
  const timerDeps: Pick<PrFeedbackDeps, "now" | "setTimer" | "clearTimer"> = {
    now: () => now,
    setTimer: (fn, ms) => {
      const handle: TimerHandle = { cancelled: false }
      timers.push({ at: now + ms, fn, handle, id: seq++ })
      return handle
    },
    clearTimer: (h) => {
      h.cancelled = true
    },
  }
  async function tick(): Promise<boolean> {
    const live = timers.filter((t) => !t.handle.cancelled)
    if (live.length === 0) return false
    live.sort((a, b) => a.at - b.at || a.id - b.id)
    const t = live[0]
    timers.splice(timers.indexOf(t), 1)
    now = Math.max(now, t.at)
    await t.fn()
    return true
  }
  async function run(maxTicks = 40): Promise<void> {
    for (let i = 0; i < maxTicks; i++) if (!(await tick())) return
  }
  return { timerDeps, tick, run, pending: () => timers.filter((t) => !t.handle.cancelled).length }
}

// ── observation factory ────────────────────────────────────────────────────────

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
      headSha: "s1",
      title: "t",
      additions: 1,
      deletions: 0,
      author: "dev",
    },
    ci: { summary: "passing", headSha: "s1", failedChecks: [] },
    review: { decision: "none", threads: [] },
    mergeability: { state: "mergeable", mergeable: true, conflict: false, behindBase: false },
    changed: { metadata: true, ci: true, review: true },
    etags: {},
  }
  return { ...base, ...over }
}

function failingObs(over: Partial<PrObservation> = {}): PrObservation {
  return mkObs({
    ci: {
      summary: "failing",
      headSha: "s1",
      failedChecks: [
        {
          name: "build",
          status: "completed",
          conclusion: "failure",
          commitHash: "s1",
          logTail: "boom",
        },
      ],
    },
    ...over,
  })
}

const binding: TeammatePrBinding = {
  runId: "run-1",
  teamId: "team-a",
  memberId: "m1",
  taskId: "t1",
  repo: "acme/app",
  branch: "agent/run-1/m1/t1",
}

function makeController(over: Partial<PrFeedbackDeps>) {
  const h = harness()
  const captured: PrNudge[] = []
  const persisted: PrObservationRecord[] = []
  const deps: PrFeedbackDeps = {
    ...h.timerDeps,
    pollIntervalMs: 1000,
    fetch: async () => mkObs(),
    persist: (r) => {
      persisted.push(r)
    },
    deliver: (_b, n) => captured.push(n),
    ...over,
  }
  const controller = new PrFeedbackController(deps)
  return { controller, captured, persisted, ...h }
}

describe("PrFeedbackController", () => {
  it("polls, reacts to failing CI, and persists a ci_failed record", async () => {
    const { controller, captured, persisted, tick } = makeController({
      fetch: async () => failingObs(),
    })
    controller.track(binding)
    await tick() // immediate first poll
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({ category: "ci", memberId: "m1" })
    expect(persisted).toHaveLength(1)
    expect(persisted[0].derivedStatus).toBe("ci_failed")
    expect(persisted[0].signature.seen).toBeDefined()
    controller.dispose()
  })

  it("skips react/persist when the observation is unchanged", async () => {
    let call = 0
    const { controller, captured, persisted, tick } = makeController({
      fetch: async () => {
        call += 1
        return call === 1
          ? failingObs()
          : failingObs({ changed: { metadata: false, ci: false, review: false } })
      },
    })
    controller.track(binding)
    await tick() // changed → react + persist
    await tick() // unchanged → skip
    expect(captured).toHaveLength(1)
    expect(persisted).toHaveLength(1)
    controller.dispose()
  })

  it("stops polling once the PR is merged (terminal)", async () => {
    let call = 0
    const { controller, persisted, tick, pending } = makeController({
      fetch: async () => {
        call += 1
        return call === 1
          ? failingObs()
          : mkObs({ pr: { ...mkObs().pr, merged: true, state: "closed" } })
      },
    })
    controller.track(binding)
    await tick() // open failing
    await tick() // merged → terminal
    expect(persisted[persisted.length - 1].derivedStatus).toBe("merged")
    expect(pending()).toBe(0) // no further poll scheduled
    expect(await tick()).toBe(false)
  })

  it("keeps polling while no PR is found yet", async () => {
    const { controller, captured, persisted, tick, pending } = makeController({
      fetch: async () => ({ ...mkObs(), fetched: false }),
    })
    controller.track(binding)
    await tick()
    expect(captured).toHaveLength(0)
    expect(persisted).toHaveLength(0)
    expect(pending()).toBe(1) // rescheduled
    controller.dispose()
  })

  it("runs the reviewer once per head commit and routes changes_requested", async () => {
    const reviewer = jest.fn(async (): Promise<NudgeIntent | null> => ({
      key: "review:https://gh/acme/app/pull/5:ao:run-1",
      sig: "s1",
      message: "AO reviewer requests changes",
      maxAttempts: 3,
      category: "review",
    }))
    let call = 0
    const { controller, captured, tick } = makeController({
      reviewer,
      fetch: async () => {
        call += 1
        // poll 1 & 2 share head s1; poll 3 advances to s2.
        const sha = call >= 3 ? "s2" : "s1"
        return mkObs({
          pr: { ...mkObs().pr, headSha: sha },
          ci: { summary: "passing", headSha: sha, failedChecks: [] },
        })
      },
    })
    controller.track(binding)
    await tick() // s1 → reviewer runs
    await tick() // s1 again → reviewer skipped (same head)
    await tick() // s2 → reviewer runs again
    expect(reviewer).toHaveBeenCalledTimes(2)
    // The reviewer mock returns the same verdict signature both times, so the
    // second is deduped by the shared engine ledger — one review nudge total.
    expect(captured.filter((n) => n.category === "review")).toHaveLength(1)
    controller.dispose()
  })

  it("hydrates a persisted signature so it does not re-nudge", async () => {
    const loadSignature = jest.fn(async () => ({
      seen: { "ci:https://gh/acme/app/pull/5": "build:s1:boom" },
      attempts: { "ci:https://gh/acme/app/pull/5": 1 },
    }))
    const { controller, captured, tick } = makeController({
      fetch: async () => failingObs(),
      loadSignature,
    })
    controller.track(binding)
    await tick()
    expect(loadSignature).toHaveBeenCalled()
    expect(captured).toHaveLength(0) // already seen this exact CI failure
    controller.dispose()
  })

  it("surfaces a fetch error and keeps polling", async () => {
    const onError = jest.fn()
    let call = 0
    const { controller, captured, tick } = makeController({
      onError,
      fetch: async () => {
        call += 1
        if (call === 1) throw new Error("network")
        return failingObs()
      },
    })
    controller.track(binding)
    await tick() // throws
    expect(onError).toHaveBeenCalledWith(binding, expect.any(Error))
    await tick() // recovers
    expect(captured).toHaveLength(1)
    controller.dispose()
  })

  it("track is idempotent and a no-op after dispose", async () => {
    const fetch = jest.fn(async () => mkObs())
    const { controller } = makeController({ fetch })
    controller.track(binding)
    controller.track(binding)
    expect(controller.tracked()).toBe(1)
    controller.dispose()
    controller.track({ ...binding, taskId: "t2" })
    expect(controller.tracked()).toBe(1)
  })

  it("dispose cancels the pending first poll before it fires", async () => {
    const fetch = jest.fn(async () => mkObs())
    const { controller, run } = makeController({ fetch })
    controller.track(binding)
    controller.dispose()
    await run()
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe("PrFeedbackController.settle", () => {
  it("resolves immediately when nothing is tracked", async () => {
    const { controller } = makeController({})
    await expect(controller.settle(1000)).resolves.toBeUndefined()
  })

  it("settle(0) resolves after each binding's first poll", async () => {
    const { controller, tick } = makeController({
      fetch: async () => ({ ...mkObs(), fetched: false }),
    })
    controller.track(binding)
    const settled = controller.settle(0)
    await tick() // first poll completes
    await expect(settled).resolves.toBeUndefined()
    controller.dispose()
  })

  it("resolves at the timeout when no PR reaches a terminal state", async () => {
    const { controller, run } = makeController({ fetch: async () => mkObs() }) // open, non-terminal
    controller.track(binding)
    const settled = controller.settle(500)
    await run(8)
    await expect(settled).resolves.toBeUndefined()
    controller.dispose()
  })

  it("resolves early when all PRs are terminal", async () => {
    const { controller, tick } = makeController({
      fetch: async () => mkObs({ pr: { ...mkObs().pr, merged: true, state: "closed" } }),
    })
    controller.track(binding)
    const settled = controller.settle(1_000_000)
    await tick() // merged → terminal → settle resolves
    await expect(settled).resolves.toBeUndefined()
  })

  it("dispose resolves a pending settle", async () => {
    const { controller } = makeController({ fetch: async () => mkObs() })
    controller.track(binding)
    const settled = controller.settle(1_000_000)
    controller.dispose()
    await expect(settled).resolves.toBeUndefined()
  })
})

describe("createRealPrFeedbackTimers", () => {
  it("schedules, fires, and cancels via real timers", () => {
    jest.useFakeTimers()
    try {
      const t = createRealPrFeedbackTimers()
      const fn = jest.fn()
      const cancelled = t.setTimer(fn, 100)
      t.clearTimer(cancelled)
      jest.advanceTimersByTime(200)
      expect(fn).not.toHaveBeenCalled()

      t.setTimer(fn, 100)
      jest.advanceTimersByTime(200)
      expect(fn).toHaveBeenCalledTimes(1)
      expect(typeof t.now()).toBe("number")
    } finally {
      jest.useRealTimers()
    }
  })
})
