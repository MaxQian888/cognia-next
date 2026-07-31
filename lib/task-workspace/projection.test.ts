const append = jest.fn(async (_runId: string, event: unknown) => event)
const recordEvent = jest.fn((_spanId: string, _event: unknown) => true)
const emitFinishedSpan = jest.fn((_span: unknown) => undefined)

jest.mock("@/lib/db/execution-runs", () => ({
  runEventJournal: { append: (runId: string, event: unknown) => append(runId, event) },
  semanticRunEvent: (type: string, payload: unknown, options?: Record<string, unknown>) => ({
    type,
    payload,
    ...(options ?? {}),
  }),
}))
jest.mock("@cognia/agent-trace/emitter", () => ({
  recordEvent: (spanId: string, event: unknown) => recordEvent(spanId, event),
  emitFinishedSpan: (span: unknown) => emitFinishedSpan(span),
}))

import { projectTaskWorkspaceRun } from "./projection"

describe("projectTaskWorkspaceRun", () => {
  beforeEach(() => jest.clearAllMocks())

  it("keeps paths private while Agent Trace receives aggregate metadata only", async () => {
    await projectTaskWorkspaceRun({
      executionRunId: "execution-1",
      taskWorkspaceRunId: "workspace-run-1",
      traceSpanId: "span-1",
      resources: [
        {
          path: "src/private.ts",
          oldPath: null,
          kind: "modified",
          captureClass: "source",
          origin: "agent",
          sensitive: false,
        },
        {
          path: "dist/bundle.js",
          oldPath: null,
          kind: "created",
          captureClass: "generated",
          origin: "agent",
          sensitive: false,
        },
      ],
      summary: {
        runId: "workspace-run-1",
        counts: { created: 1, modified: 1, deleted: 0, renamed: 0, source: 1, generated: 1 },
        eventCount: 2,
        overflowCount: 0,
        completeness: "complete",
      },
    })

    expect(append).toHaveBeenCalledWith(
      "execution-1",
      expect.objectContaining({
        type: "resource.changed",
        visibility: "private",
        payload: expect.objectContaining({ path: "src/private.ts" }),
      })
    )
    expect(append).toHaveBeenCalledWith(
      "execution-1",
      expect.objectContaining({
        type: "resource.summary",
        visibility: "summary",
        payload: expect.not.objectContaining({ path: expect.anything() }),
      })
    )
    expect(JSON.stringify(recordEvent.mock.calls)).not.toContain("src/private.ts")
    expect(JSON.stringify(recordEvent.mock.calls)).not.toContain("dist/bundle.js")
    expect(recordEvent).toHaveBeenCalledWith(
      "span-1",
      expect.objectContaining({
        name: "workspace.resources.changed",
        attributes: expect.objectContaining({ generated: 1, source: 1 }),
      })
    )
  })
})
