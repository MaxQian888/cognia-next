import { createBudgetGuard } from "./budget-guard"
import type { TeamNotifier } from "./team-notifier"
import type { ConcurrencyController } from "@/lib/workflow/runtime/concurrency-controller"
import type { ModelPreferenceController } from "@/lib/workflow/runtime/model-preference-controller"

interface RecordingNotifier extends TeamNotifier {
  calls: Array<{ kind: string } & Record<string, unknown>>
}

const fakeNotifier = (): RecordingNotifier => {
  const calls: Array<{ kind: string } & Record<string, unknown>> = []
  return {
    calls,
    notify: (p) => {
      calls.push({ kind: "notify", ...p })
    },
    suspend: () => {
      calls.push({ kind: "suspend" })
    },
    resume: () => {
      calls.push({ kind: "resume" })
    },
  }
}

interface RecordingConcurrency extends ConcurrencyController {
  reduced: number[]
}

const fakeConcurrency = (): RecordingConcurrency => {
  let current = 5
  const reduced: number[] = []
  return {
    reduced,
    get: () => current,
    reduceTo: (n) => {
      reduced.push(n)
      if (n < current) current = n
    },
    subscribe: () => () => {},
  }
}

interface RecordingModelPref extends ModelPreferenceController {
  downshiftCount: number
}

const fakeModelPref = (): RecordingModelPref => {
  let downshiftCount = 0
  return {
    get downshiftCount() {
      return downshiftCount
    },
    get: () => ({ preferCheap: downshiftCount > 0 }),
    downshift: () => {
      downshiftCount += 1
    },
    subscribe: () => () => {},
  }
}

describe("BudgetGuard", () => {
  it("status starts ok with 0 used", () => {
    const g = createBudgetGuard({
      runId: "r1",
      limit: 1000,
      onCritical: "notify",
      notifier: fakeNotifier(),
    })
    expect(g.status()).toEqual({ used: 0, limit: 1000, level: "ok" })
  })

  it("limit=0 means unlimited; level stays ok", () => {
    const g = createBudgetGuard({
      runId: "r1",
      limit: 0,
      onCritical: "notify",
      notifier: fakeNotifier(),
    })
    g.add({ promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 })
    expect(g.status().level).toBe("ok")
  })

  it("fires warning_crossed exactly once at 80%", () => {
    const notifier = fakeNotifier()
    const g = createBudgetGuard({
      runId: "r1",
      limit: 100,
      onCritical: "notify",
      notifier,
    })
    const fn = jest.fn()
    g.on("warning_crossed", fn)
    g.add({ promptTokens: 70, completionTokens: 0, totalTokens: 70 })
    expect(fn).not.toHaveBeenCalled()
    g.add({ promptTokens: 11, completionTokens: 0, totalTokens: 11 })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith({ runId: "r1" })
    g.add({ promptTokens: 5, completionTokens: 0, totalTokens: 5 })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("fires critical_crossed exactly once at 95% with onCritical=notify", () => {
    const notifier = fakeNotifier()
    const g = createBudgetGuard({
      runId: "r1",
      limit: 100,
      onCritical: "notify",
      notifier,
    })
    const fn = jest.fn()
    g.on("critical_crossed", fn)
    g.add({ promptTokens: 96, completionTokens: 0, totalTokens: 96 })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith({ runId: "r1" })
    expect(g.status().level).toBe("critical")
    expect(notifier.calls.some((c) => c.kind === "notify")).toBe(true)
  })

  it("onCritical=pause_for_review emits pause_for_review event", () => {
    const g = createBudgetGuard({
      runId: "r1",
      limit: 100,
      onCritical: "pause_for_review",
      notifier: fakeNotifier(),
    })
    const fn = jest.fn()
    g.on("pause_for_review", fn)
    g.add({ promptTokens: 96, completionTokens: 0, totalTokens: 96 })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith({ runId: "r1" })
  })

  it("onCritical=reduce_concurrency calls concurrencyCtrl.reduceTo(1)", () => {
    const ctrl = fakeConcurrency()
    const g = createBudgetGuard({
      runId: "r1",
      limit: 100,
      onCritical: "reduce_concurrency",
      notifier: fakeNotifier(),
      concurrencyCtrl: ctrl,
    })
    g.add({ promptTokens: 96, completionTokens: 0, totalTokens: 96 })
    expect(ctrl.reduced).toContain(1)
  })

  it("onCritical=handoff_to_background downshifts model + reduces concurrency + suspends notifier", () => {
    const notifier = fakeNotifier()
    const ctrl = fakeConcurrency()
    const modelPref = fakeModelPref()
    const g = createBudgetGuard({
      runId: "r1",
      limit: 100,
      onCritical: "handoff_to_background",
      notifier,
      concurrencyCtrl: ctrl,
      modelCtrl: modelPref,
    })
    const enteredBg = jest.fn()
    g.on("entered_background_mode", enteredBg)
    g.add({ promptTokens: 96, completionTokens: 0, totalTokens: 96 })
    expect(ctrl.reduced).toContain(1)
    expect(modelPref.downshiftCount).toBe(1)
    expect(notifier.calls.some((c) => c.kind === "suspend")).toBe(true)
    expect(enteredBg).toHaveBeenCalledTimes(1)
  })

  it("extendLimit resets warned/critical so they can re-fire", () => {
    const g = createBudgetGuard({
      runId: "r1",
      limit: 100,
      onCritical: "notify",
      notifier: fakeNotifier(),
    })
    const warn = jest.fn()
    const crit = jest.fn()
    g.on("warning_crossed", warn)
    g.on("critical_crossed", crit)
    g.add({ promptTokens: 96, completionTokens: 0, totalTokens: 96 })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(crit).toHaveBeenCalledTimes(1)
    g.extendLimit(100)
    expect(g.status()).toEqual({ used: 96, limit: 200, level: "ok" })
    g.add({ promptTokens: 65, completionTokens: 0, totalTokens: 65 })
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it("custom warnAt / critAt thresholds are honored", () => {
    const g = createBudgetGuard({
      runId: "r1",
      limit: 100,
      warnAt: 0.5,
      critAt: 0.7,
      onCritical: "notify",
      notifier: fakeNotifier(),
    })
    const warn = jest.fn()
    g.on("warning_crossed", warn)
    g.add({ promptTokens: 51, completionTokens: 0, totalTokens: 51 })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it("unsubscribe stops event delivery", () => {
    const g = createBudgetGuard({
      runId: "r1",
      limit: 100,
      onCritical: "notify",
      notifier: fakeNotifier(),
    })
    const fn = jest.fn()
    const unsub = g.on("warning_crossed", fn)
    unsub()
    g.add({ promptTokens: 81, completionTokens: 0, totalTokens: 81 })
    expect(fn).not.toHaveBeenCalled()
  })
})
