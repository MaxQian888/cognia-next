import type { UIMessage } from "ai"

import { isSkillSuggestionEligible, prepareSkillRecordingFromSource } from "./session-suggestion"

const mockCreateRecording = jest.fn()
const mockCheckpointRecording = jest.fn()
const mockListMessages = jest.fn()
const mockGetAttempt = jest.fn()
const mockReset = jest.fn()
const mockSetEdits = jest.fn()
const mockDispatch = jest.fn(() => true)

jest.mock("@/lib/db/skill-recordings", () => ({
  createRecording: (...args: unknown[]) => mockCreateRecording(...args),
  checkpointRecording: (...args: unknown[]) => mockCheckpointRecording(...args),
}))
jest.mock("@/lib/db/messages", () => ({
  listMessages: (...args: unknown[]) => mockListMessages(...args),
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ agentTaskAttempts: { get: (...args: unknown[]) => mockGetAttempt(...args) } }),
}))
jest.mock("@/stores/skills/recorder-store", () => ({
  useRecorderStore: {
    getState: () => ({
      phase: "idle",
      reset: mockReset,
      setEdits: mockSetEdits,
      dispatch: mockDispatch,
      recordingId: null,
      bundleId: null,
      steps: [],
      inputVariables: [],
      draft: null,
      candidateDraft: null,
      generation: null,
      capturedSteps: [],
      edits: { bySeq: {}, manual: [] },
    }),
  },
}))
jest.mock("@cognia/logging", () => ({
  loggers: { agent: { child: () => ({ info: jest.fn(), warn: jest.fn() }) } },
}))

const message = (role: UIMessage["role"], text: string): UIMessage => ({
  id: `${role}-${text}`,
  role,
  parts: [{ type: "text", text }],
})

beforeEach(() => {
  jest.clearAllMocks()
  mockCreateRecording.mockResolvedValue(undefined)
  mockCheckpointRecording.mockResolvedValue(undefined)
})

describe("isSkillSuggestionEligible", () => {
  it("requires a successful reusable outcome", () => {
    expect(
      isSkillSuggestionEligible({
        completed: true,
        turns: 3,
        errorCount: 0,
        denialCount: 0,
        toolCallTotal: 3,
        passedTests: 0,
        failedTests: 0,
        commitCount: 0,
      })
    ).toBe(true)
  })

  it.each([
    { completed: false },
    { turns: 1 },
    { errorCount: 1 },
    { denialCount: 1 },
    { toolCallTotal: 0, passedTests: 0, commitCount: 0 },
    { failedTests: 1 },
  ])("rejects non-positive outcomes: %o", (patch) => {
    expect(
      isSkillSuggestionEligible({
        completed: true,
        turns: 3,
        errorCount: 0,
        denialCount: 0,
        toolCallTotal: 3,
        passedTests: 0,
        failedTests: 0,
        commitCount: 0,
        ...patch,
      })
    ).toBe(false)
  })
})

describe("prepareSkillRecordingFromSource", () => {
  it("does not load session content until explicitly invoked", () => {
    expect(mockListMessages).not.toHaveBeenCalled()
  })

  it("loads on confirmation, stores only redacted review steps, and opens Recorder review", async () => {
    mockListMessages.mockResolvedValue([
      message("user", "Email alice@example.com and complete the release"),
      message("assistant", "Release completed successfully"),
    ])

    const result = await prepareSkillRecordingFromSource({ kind: "session", sessionId: "s1" })

    expect(mockListMessages).toHaveBeenCalledWith("s1")
    expect(result.stepCount).toBe(2)
    const input = mockCreateRecording.mock.calls[0][0]
    expect(input).toMatchObject({
      id: result.recordingId,
      status: "drafting",
      source: { kind: "session", sessionId: "s1" },
    })
    const edits = mockCheckpointRecording.mock.calls[0][1].edits
    expect(JSON.stringify(edits)).not.toContain("alice@example.com")
    expect(JSON.stringify(edits)).toContain("<EMAIL_001>")
    expect(mockSetEdits).toHaveBeenCalledWith(edits)
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "REATTACH",
        snapshot: expect.objectContaining({ phase: "review" }),
      })
    )
    expect(mockDispatch).toHaveBeenCalledWith({ type: "OPEN", source: "session-suggestion" })
  })

  it("loads a successful run result only after confirmation", async () => {
    mockGetAttempt.mockResolvedValue({ status: "completed", result: "Reusable successful steps" })

    await expect(
      prepareSkillRecordingFromSource({ kind: "run", runId: "attempt-1" })
    ).resolves.toMatchObject({ stepCount: 1 })
    expect(mockGetAttempt).toHaveBeenCalledWith("attempt-1")
  })

  it("fails closed for empty, unsuccessful, or still-running sources", async () => {
    mockListMessages.mockResolvedValue([])
    await expect(
      prepareSkillRecordingFromSource({ kind: "session", sessionId: "empty" })
    ).rejects.toThrow("skill-source-empty")

    mockGetAttempt.mockResolvedValue({ status: "failed", result: "partial" })
    await expect(prepareSkillRecordingFromSource({ kind: "run", runId: "failed" })).rejects.toThrow(
      "skill-source-not-successful"
    )
  })
})
