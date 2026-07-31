import { generateWorkflowRunTitle } from "./run-title"
import { runTitleTask } from "@/lib/ai/generation/run-title-task"

const getMock = jest.fn()
const updateMock = jest.fn()
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    workflowRuns: {
      get: (...a: unknown[]) => getMock(...a),
      update: (...a: unknown[]) => updateMock(...a),
    },
  }),
}))

const settingsRef = { value: { conversationTitle: { enabled: true }, language: "en" } as unknown }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => ({ settings: settingsRef.value }) },
}))

jest.mock("@/lib/ai/generation/run-title-task", () => ({ runTitleTask: jest.fn() }))
const runTitleTaskMock = runTitleTask as jest.MockedFunction<typeof runTitleTask>

function runRow(over: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    workflowId: "wf-1",
    status: "succeeded",
    workflowSnapshot: { id: "wf-1", name: "Nightly sync", description: "Sync the inbox" },
    input: { folder: "inbox" },
    output: { moved: 3 },
    ...over,
  }
}

beforeEach(() => {
  getMock.mockReset()
  updateMock.mockReset().mockResolvedValue(undefined)
  runTitleTaskMock.mockReset().mockResolvedValue("Synced inbox")
  settingsRef.value = { conversationTitle: { enabled: true }, language: "en" }
})

describe("generateWorkflowRunTitle", () => {
  it("builds a work-kind title task from the run and persists via runTitleTask", async () => {
    getMock.mockResolvedValue(runRow())
    const out = await generateWorkflowRunTitle("run-1")
    expect(out).toBe("Synced inbox")
    const args = runTitleTaskMock.mock.calls[0][0]
    expect(args.kind).toBe("work")
    expect(args.featureId).toBe("workflow-run-title")
    expect(args.sourceText).toContain("Nightly sync")
    expect(args.sourceText).toContain("Sync the inbox")
    expect(args.locale).toBe("en")
  })

  it("uses the error message as the result text for failed runs", async () => {
    getMock.mockResolvedValue(
      runRow({ status: "failed", error: { message: "boom" }, output: undefined })
    )
    await generateWorkflowRunTitle("run-1")
    expect(runTitleTaskMock.mock.calls[0][0].resultText).toBe("boom")
  })

  it("returns null and does not title when the run is missing", async () => {
    getMock.mockResolvedValue(undefined)
    expect(await generateWorkflowRunTitle("run-1")).toBeNull()
    expect(runTitleTaskMock).not.toHaveBeenCalled()
  })

  it("returns null when the run title was manually set", async () => {
    getMock.mockResolvedValue(runRow({ titleAuto: false }))
    expect(await generateWorkflowRunTitle("run-1")).toBeNull()
    expect(runTitleTaskMock).not.toHaveBeenCalled()
  })

  it("returns null when title generation is disabled", async () => {
    settingsRef.value = { conversationTitle: { enabled: false } }
    getMock.mockResolvedValue(runRow())
    expect(await generateWorkflowRunTitle("run-1")).toBeNull()
    expect(runTitleTaskMock).not.toHaveBeenCalled()
  })

  it("persist callback writes the title to the run row", async () => {
    getMock.mockResolvedValue(runRow())
    runTitleTaskMock.mockImplementation(async (args) => {
      await args.persist("Manual title")
      return "Manual title"
    })
    await generateWorkflowRunTitle("run-1")
    expect(updateMock).toHaveBeenCalledWith("run-1", { title: "Manual title", titleAuto: true })
  })

  it("never throws when the db read fails", async () => {
    getMock.mockRejectedValue(new Error("db down"))
    expect(await generateWorkflowRunTitle("run-1")).toBeNull()
  })

  it("isStillAuto callback re-reads the run row and reflects a later rename", async () => {
    getMock.mockResolvedValueOnce(runRow())
    // Second read (inside isStillAuto) shows a manual rename → abort.
    getMock.mockResolvedValueOnce(runRow({ titleAuto: false }))
    let stillAuto: boolean | undefined
    runTitleTaskMock.mockImplementation(async (args) => {
      stillAuto = await args.isStillAuto?.()
      return null
    })
    await generateWorkflowRunTitle("run-1")
    expect(stillAuto).toBe(false)
  })

  it("tolerates a non-serialisable run input", async () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    getMock.mockResolvedValue(runRow({ input: circular }))
    const out = await generateWorkflowRunTitle("run-1")
    expect(out).toBe("Synced inbox")
    // The circular input serialises to "" — the workflow name still drives it.
    expect(runTitleTaskMock.mock.calls[0][0].sourceText).toContain("Nightly sync")
  })

  it("handles a null input and a string output", async () => {
    getMock.mockResolvedValue(runRow({ input: null, output: "moved 3 messages" }))
    await generateWorkflowRunTitle("run-1")
    const args = runTitleTaskMock.mock.calls[0][0]
    expect(args.sourceText).toContain("Nightly sync")
    expect(args.resultText).toBe("moved 3 messages")
  })

  it("treats a JSON-unserialisable output (function) as empty", async () => {
    getMock.mockResolvedValue(runRow({ output: () => undefined }))
    await generateWorkflowRunTitle("run-1")
    expect(runTitleTaskMock.mock.calls[0][0].resultText).toBeUndefined()
  })
})
