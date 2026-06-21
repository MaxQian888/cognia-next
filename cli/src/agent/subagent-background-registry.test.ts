/**
 * @jest-environment node
 */
import {
  __clearAllCliBackgroundRunsForTesting,
  collectCliBackgroundResult,
  countRunningCliBackgroundRuns,
  hasCliBackgroundRun,
  listCliBackgroundRuns,
  startCliBackgroundRun,
} from "./subagent-background-registry"

afterEach(() => __clearAllCliBackgroundRunsForTesting())

/** A promise plus its resolve/reject so a test can settle a parked run on demand. */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("startCliBackgroundRun / hasCliBackgroundRun", () => {
  it("registers a run as in-flight before it settles", () => {
    const d = deferred<string>()
    startCliBackgroundRun("r1", "reviewer", d.promise, 1000)
    expect(hasCliBackgroundRun("r1")).toBe(true)
    expect(countRunningCliBackgroundRuns()).toBe(1)
    d.resolve("done")
  })

  it("flips status to done once the promise resolves", async () => {
    const d = deferred<string>()
    startCliBackgroundRun("r1", "reviewer", d.promise)
    d.resolve("[reviewer]\nlooks good")
    await d.promise
    const [info] = listCliBackgroundRuns()
    expect(info.status).toBe("done")
    expect(countRunningCliBackgroundRuns()).toBe(0)
  })

  it("flips status to error when the promise rejects", async () => {
    const d = deferred<string>()
    startCliBackgroundRun("r1", "reviewer", d.promise)
    d.reject(new Error("boom"))
    await d.promise.catch(() => undefined)
    const [info] = listCliBackgroundRuns()
    expect(info.status).toBe("error")
  })
})

describe("collectCliBackgroundResult", () => {
  it("awaits an in-flight run, returns its result, and drops the entry", async () => {
    const d = deferred<string>()
    startCliBackgroundRun("r1", "reviewer", d.promise)
    const collected = collectCliBackgroundResult("r1")
    d.resolve("the result")
    expect(await collected).toBe("the result")
    expect(hasCliBackgroundRun("r1")).toBe(false)
  })

  it("returns a settled run synchronously and drops it", async () => {
    const d = deferred<string>()
    startCliBackgroundRun("r1", "reviewer", d.promise)
    d.resolve("ready")
    await d.promise
    expect(await collectCliBackgroundResult("r1")).toBe("ready")
    expect(hasCliBackgroundRun("r1")).toBe(false)
  })

  it("returns undefined for an unknown / already-collected id", async () => {
    expect(await collectCliBackgroundResult("ghost")).toBeUndefined()
  })

  it("returns the error message for a rejected run and drops the entry", async () => {
    const d = deferred<string>()
    startCliBackgroundRun("r1", "reviewer", d.promise)
    d.reject(new Error("nope"))
    expect(await collectCliBackgroundResult("r1")).toBe("nope")
    expect(hasCliBackgroundRun("r1")).toBe(false)
  })

  it("stringifies a non-Error rejection", async () => {
    const d = deferred<string>()
    startCliBackgroundRun("r1", "reviewer", d.promise)
    d.reject("plain string")
    expect(await collectCliBackgroundResult("r1")).toBe("plain string")
  })
})

describe("listCliBackgroundRuns", () => {
  it("snapshots parked runs with their metadata", () => {
    const a = deferred<string>()
    const b = deferred<string>()
    startCliBackgroundRun("r1", "reviewer", a.promise, 1000)
    startCliBackgroundRun("r2", "writer", b.promise, 2000)
    const list = listCliBackgroundRuns()
    expect(list).toHaveLength(2)
    expect(list.map((r) => r.subagentId).sort()).toEqual(["reviewer", "writer"])
    expect(list.find((r) => r.runId === "r1")?.startedAt).toBe(1000)
    a.resolve("x")
    b.resolve("y")
  })
})
