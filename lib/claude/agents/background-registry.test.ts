import {
  startBackgroundRun,
  hasBackgroundRun,
  collectBackgroundResult,
  listBackgroundRuns,
  __clearAllBackgroundRunsForTesting,
} from "./background-registry"
import type { PluginSubagentDispatchResult } from "@/types/plugin/plugin-agent-sdk"

const ok = (text: string): PluginSubagentDispatchResult => ({
  text,
  channel: "sidecar",
  toolsAvailable: true,
  runId: "r1",
})

describe("background-registry", () => {
  beforeEach(() => {
    __clearAllBackgroundRunsForTesting()
  })

  it("parks a run and reports it as known", () => {
    startBackgroundRun("r1", Promise.resolve(ok("done")))
    expect(hasBackgroundRun("r1")).toBe(true)
    expect(listBackgroundRuns()).toEqual(["r1"])
  })

  it("collects a resolved result and drops the entry", async () => {
    startBackgroundRun("r1", Promise.resolve(ok("done")))
    const r = await collectBackgroundResult("r1")
    expect(r?.text).toBe("done")
    expect(hasBackgroundRun("r1")).toBe(false)
  })

  it("returns undefined for an unknown run id", async () => {
    expect(await collectBackgroundResult("nope")).toBeUndefined()
  })

  it("collapses a rejected run into an error envelope", async () => {
    startBackgroundRun("r1", Promise.reject(new Error("boom")))
    const r = await collectBackgroundResult("r1")
    expect(r?.finishReason).toBe("error")
    expect(r?.text).toBe("boom")
    expect(hasBackgroundRun("r1")).toBe(false)
  })

  it("awaits an in-flight run that settles later", async () => {
    let resolve!: (v: PluginSubagentDispatchResult) => void
    startBackgroundRun(
      "r1",
      new Promise<PluginSubagentDispatchResult>((res) => {
        resolve = res
      })
    )
    const collected = collectBackgroundResult("r1")
    resolve(ok("late"))
    expect((await collected)?.text).toBe("late")
  })
})
