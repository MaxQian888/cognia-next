/** @jest-environment jsdom */
import type { AppSettings } from "@cognia/agent-config-types"

import type { FusionRunRow } from "../db/types"

const executed: Array<{ runId: string; settings: AppSettings | undefined; leaseOwner: string }> = []
let failNext = false
jest.mock("./orchestrator-host", () => ({
  executeFusionRun: async (
    deps: { appSettings: () => AppSettings | undefined; leaseOwner: string },
    input: { runId: string }
  ) => {
    executed.push({ runId: input.runId, settings: deps.appSettings(), leaseOwner: deps.leaseOwner })
    if (failNext) {
      failNext = false
      throw new Error("database closed")
    }
    return { kind: "succeeded" }
  },
}))
jest.mock("../chat/store-provider", () => ({ currentFusionStore: async () => ({}) }))
jest.mock("../db/outbox-appliers", () => ({ accountDatabaseAppliers: {} }))
jest.mock("../chat/chat-run-deps", () => ({ windowLeaseOwner: () => "window:test" }))

import { driveRun, holdRunDriver, isDrivingRun, orchestratedRunResumer } from "./run-driver"

const SNAPSHOT = { routerFusion: { enabled: true } } as unknown as AppSettings

function row(overrides: Partial<FusionRunRow>): FusionRunRow {
  return {
    runId: "run-1",
    surface: "gatewayRuns",
    driver: "orchestrator",
    status: "running",
    ...overrides,
  } as FusionRunRow
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  executed.length = 0
})

describe("driveRun", () => {
  it("drives a run once in this process however often it is started, and again once it stopped", async () => {
    driveRun("run-a", () => SNAPSHOT)
    driveRun("run-a", () => SNAPSHOT)
    expect(isDrivingRun("run-a")).toBe(true)
    await settle()
    expect(executed.map((e) => e.runId)).toEqual(["run-a"])
    expect(executed[0]).toMatchObject({ leaseOwner: "window:test", settings: SNAPSHOT })
    expect(isDrivingRun("run-a")).toBe(false)
    driveRun("run-a", () => SNAPSHOT)
    await settle()
    expect(executed.map((e) => e.runId)).toEqual(["run-a", "run-a"])
  })

  it("logs a run that could not be executed and lets it be started again", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {})
    failNext = true
    driveRun("run-b", () => SNAPSHOT)
    await settle()
    expect(error).toHaveBeenCalledWith(
      "[router-fusion] run run-b could not be executed",
      expect.any(Error)
    )
    expect(isDrivingRun("run-b")).toBe(false)
    error.mockRestore()
  })
})

describe("holdRunDriver", () => {
  it("keeps driveRun from starting a second executor for a run its caller drives", async () => {
    executed.length = 0
    const release = holdRunDriver("held-run")
    expect(isDrivingRun("held-run")).toBe(true)
    // What the cockpit's decision does for every run it resumes.
    driveRun("held-run", () => SNAPSHOT)
    await settle()
    expect(executed.filter((call) => call.runId === "held-run")).toHaveLength(0)

    release()
    release()
    expect(isDrivingRun("held-run")).toBe(false)
    driveRun("held-run", () => SNAPSHOT)
    await settle()
    expect(executed.filter((call) => call.runId === "held-run")).toHaveLength(1)
  })

  it("does not take over a run this process is already driving", async () => {
    driveRun("busy-run", () => SNAPSHOT)
    const release = holdRunDriver("busy-run")
    release()
    // The drive that was already running still owns the mark until it ends.
    expect(isDrivingRun("busy-run")).toBe(true)
    await settle()
    expect(isDrivingRun("busy-run")).toBe(false)
  })
})

describe("orchestratedRunResumer", () => {
  it("[ACC:REC-03] carries on an orchestrated run whose surface is on, from the sweep's settings", async () => {
    const resume = orchestratedRunResumer(SNAPSHOT, ["chat", "gatewayRuns"])
    expect(resume(row({ runId: "run-c" }))).toBe(true)
    await settle()
    expect(executed).toEqual([{ runId: "run-c", settings: SNAPSHOT, leaseOwner: "window:test" }])
  })

  it("refuses a run on a surface that was switched off, and a run nobody here can drive", async () => {
    const resume = orchestratedRunResumer(SNAPSHOT, ["chat"])
    expect(resume(row({ runId: "run-d", surface: "gatewayRuns" }))).toBe(false)
    expect(resume(row({ runId: "run-e", surface: "chat", driver: undefined }))).toBe(false)
    await settle()
    expect(executed).toEqual([])
  })
})
