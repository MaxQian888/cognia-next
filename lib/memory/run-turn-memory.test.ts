import { runTurnMemory } from "./run-turn-memory"

jest.mock("@/lib/db/sessions", () => ({
  getSession: jest.fn(),
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: jest.fn() },
}))
jest.mock("@/lib/memory/write/run-memory-extraction", () => ({
  buildAutoExtractionDeps: jest.fn(),
  runMemoryExtraction: jest.fn(),
  sessionProvenance: jest.fn(() => "user"),
}))
jest.mock("@/lib/memory/lifecycle/maintenance", () => ({
  scheduleMemoryMaintenance: jest.fn(),
}))

import { getSession } from "@/lib/db/sessions"
import { useSettingsStore } from "@/stores/settings"
import {
  buildAutoExtractionDeps,
  runMemoryExtraction,
  sessionProvenance,
} from "@/lib/memory/write/run-memory-extraction"
import { scheduleMemoryMaintenance } from "@/lib/memory/lifecycle/maintenance"

const mockGetSession = getSession as jest.Mock
const mockGetState = useSettingsStore.getState as jest.Mock
const mockBuildDeps = buildAutoExtractionDeps as jest.Mock
const mockRunExtraction = runMemoryExtraction as jest.Mock
const mockProvenance = sessionProvenance as jest.Mock
const mockSchedule = scheduleMemoryMaintenance as jest.Mock

const TRANSCRIPT = [
  { role: "user", text: "remember my timezone is UTC+8" },
  { role: "assistant", text: "noted — UTC+8" },
]

function setMemory(partial?: Record<string, unknown>) {
  mockGetState.mockReturnValue({ settings: { memory: partial } })
}

const INPUT = {
  userText: "remember my timezone is UTC+8",
  assistantText: "noted — UTC+8",
  transcript: TRANSCRIPT,
}

beforeEach(() => {
  jest.clearAllMocks()
  setMemory({}) // resolveMemoryConfig → defaults (enabled + autoExtract on)
  mockGetSession.mockResolvedValue({ id: "s1", characterId: "c1" })
  mockProvenance.mockReturnValue("user")
  mockBuildDeps.mockResolvedValue({ extractor: {}, consolidator: {} })
  mockRunExtraction.mockResolvedValue({ applied: [] })
})

describe("runTurnMemory", () => {
  it("extracts the new pair and schedules maintenance on a clean enabled turn", async () => {
    await runTurnMemory("s1", INPUT)

    expect(mockRunExtraction).toHaveBeenCalledTimes(1)
    const [extractionInput, deps] = mockRunExtraction.mock.calls[0]
    expect(extractionInput.newPair).toEqual({
      userText: "remember my timezone is UTC+8",
      assistantText: "noted — UTC+8",
    })
    expect(extractionInput.recentMessages).toEqual(TRANSCRIPT)
    expect(extractionInput.scope).toBe("global")
    expect(extractionInput.characterId).toBe("c1")
    expect(extractionInput.provenance).toBe("user")
    expect(extractionInput.source).toEqual({ sessionId: "s1" })
    expect(deps).toEqual({ extractor: {}, consolidator: {} })

    expect(mockSchedule).toHaveBeenCalledTimes(1)
    const [scheduleParams] = mockSchedule.mock.calls[0]
    expect(scheduleParams.sessionId).toBe("s1")
    expect(scheduleParams.transcript).toEqual(TRANSCRIPT)
    expect(scheduleParams.provenance).toBe("user")
  })

  it("only keeps the last 10 transcript entries as recent context", async () => {
    const long = Array.from({ length: 14 }, (_, i) => ({ role: "user", text: `m${i}` }))
    await runTurnMemory("s1", { ...INPUT, transcript: long })
    const [extractionInput] = mockRunExtraction.mock.calls[0]
    expect(extractionInput.recentMessages).toHaveLength(10)
    expect(extractionInput.recentMessages[0]).toEqual({ role: "user", text: "m4" })
    // Maintenance still sees the full transcript.
    expect(mockSchedule.mock.calls[0][0].transcript).toHaveLength(14)
  })

  it("no-ops on empty user text before reading settings", async () => {
    await runTurnMemory("s1", { ...INPUT, userText: "   " })
    expect(mockGetState).not.toHaveBeenCalled()
    expect(mockGetSession).not.toHaveBeenCalled()
    expect(mockRunExtraction).not.toHaveBeenCalled()
    expect(mockSchedule).not.toHaveBeenCalled()
  })

  it("no-ops when there are no settings", async () => {
    mockGetState.mockReturnValue({ settings: null })
    await runTurnMemory("s1", INPUT)
    expect(mockGetSession).not.toHaveBeenCalled()
    expect(mockRunExtraction).not.toHaveBeenCalled()
  })

  it("no-ops when memory is disabled", async () => {
    setMemory({ enabled: false })
    await runTurnMemory("s1", INPUT)
    expect(mockGetSession).not.toHaveBeenCalled()
    expect(mockRunExtraction).not.toHaveBeenCalled()
    expect(mockSchedule).not.toHaveBeenCalled()
  })

  it("no-ops when autoExtract is off", async () => {
    setMemory({ autoExtract: false })
    await runTurnMemory("s1", INPUT)
    expect(mockRunExtraction).not.toHaveBeenCalled()
  })

  it("no-ops for a temporary session", async () => {
    setMemory({ temporary: true })
    await runTurnMemory("s1", INPUT)
    expect(mockRunExtraction).not.toHaveBeenCalled()
    expect(mockSchedule).not.toHaveBeenCalled()
  })

  it("no-ops when the session row is gone", async () => {
    mockGetSession.mockResolvedValue(undefined)
    await runTurnMemory("s1", INPUT)
    expect(mockRunExtraction).not.toHaveBeenCalled()
    expect(mockSchedule).not.toHaveBeenCalled()
  })

  it("skips extraction but still schedules maintenance when no deps can be built", async () => {
    mockBuildDeps.mockResolvedValue(null)
    await runTurnMemory("s1", INPUT)
    expect(mockRunExtraction).not.toHaveBeenCalled()
    expect(mockSchedule).toHaveBeenCalledTimes(1)
  })

  it("swallows extraction failures (never breaks the send)", async () => {
    mockRunExtraction.mockRejectedValue(new Error("boom"))
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    await expect(runTurnMemory("s1", INPUT)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
