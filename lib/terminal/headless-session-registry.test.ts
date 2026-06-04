import {
  __clearRunSessionsForTesting,
  closeRunSessions,
  deregisterRunSession,
  listRunSessions,
  registerRunSession,
} from "./headless-session-registry"

const mockInvoke = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

const mockKillFromDock = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("./spawn-orchestrator", () => ({
  killFromDock: (...args: unknown[]) => mockKillFromDock(...args),
}))

jest.mock("@/stores/terminal/terminal-store", () => ({
  useTerminalStore: { getState: () => ({ kind: "store-stub" }) },
}))

beforeEach(() => {
  __clearRunSessionsForTesting()
  mockInvoke.mockReset().mockResolvedValue(undefined)
  mockKillFromDock.mockReset().mockResolvedValue(undefined)
})

describe("headless session registry", () => {
  it("registers and lists sessions per run, deduped", () => {
    registerRunSession("run-1", "s-a", "headless")
    registerRunSession("run-1", "s-b", "dock")
    registerRunSession("run-1", "s-a", "headless") // duplicate
    registerRunSession("run-2", "s-c", "headless")
    expect(listRunSessions("run-1").map((e) => e.sessionId)).toEqual(["s-a", "s-b"])
    expect(listRunSessions("run-2")).toHaveLength(1)
    expect(listRunSessions("unknown")).toEqual([])
  })

  it("deregisters a single session", () => {
    registerRunSession("run-1", "s-a", "headless")
    registerRunSession("run-1", "s-b", "dock")
    deregisterRunSession("run-1", "s-a")
    expect(listRunSessions("run-1").map((e) => e.sessionId)).toEqual(["s-b"])
    // Unknown ids are a no-op.
    deregisterRunSession("run-1", "ghost")
    deregisterRunSession("ghost-run", "s-b")
  })

  it("closes headless sessions via the Tauri kill command", async () => {
    registerRunSession("run-1", "hl-1", "headless")
    await closeRunSessions("run-1")
    expect(mockInvoke).toHaveBeenCalledWith("terminal_headless_kill", { sessionId: "hl-1" })
    expect(listRunSessions("run-1")).toEqual([])
  })

  it("closes dock sessions via killFromDock with the live store", async () => {
    registerRunSession("run-1", "tab-1", "dock")
    await closeRunSessions("run-1")
    expect(mockKillFromDock).toHaveBeenCalledWith("tab-1", { kind: "store-stub" })
  })

  it("isolates close failures so the rest still close", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("backend gone"))
    registerRunSession("run-1", "hl-1", "headless")
    registerRunSession("run-1", "hl-2", "headless")
    await expect(closeRunSessions("run-1")).resolves.toBeUndefined()
    expect(mockInvoke).toHaveBeenCalledTimes(2)
  })

  it("is idempotent for unknown runs and double closes", async () => {
    await expect(closeRunSessions("never-registered")).resolves.toBeUndefined()
    registerRunSession("run-1", "hl-1", "headless")
    await closeRunSessions("run-1")
    mockInvoke.mockClear()
    await closeRunSessions("run-1")
    expect(mockInvoke).not.toHaveBeenCalled()
  })
})
