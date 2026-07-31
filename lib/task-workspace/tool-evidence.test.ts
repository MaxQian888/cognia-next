const record = jest.fn(async (_input: unknown) => undefined)

jest.mock("./client", () => ({
  recordTaskResourceToolEvent: (input: unknown) => record(input),
}))
jest.mock("@/stores/task-workspace-store", () => ({
  useTaskWorkspaceStore: {
    getState: () => ({
      activeBySession: {
        "session-1": { runId: "workspace-run", executionRoot: "/isolated" },
      },
    }),
  },
}))

import { recordToolFileChanges } from "./tool-evidence"

describe("recordToolFileChanges", () => {
  beforeEach(() => jest.clearAllMocks())

  it("normalizes in-root tool paths and rejects paths outside the execution root", async () => {
    await recordToolFileChanges("session-1", "tool-1", [
      { path: "/isolated/src/a.ts", type: "update" },
      { path: "dist/b.js", type: "add" },
      { path: "/outside/secret", type: "delete" },
    ])
    expect(record).toHaveBeenCalledTimes(2)
    expect(record).toHaveBeenNthCalledWith(1, {
      runId: "workspace-run",
      path: "src/a.ts",
      kind: "modified",
      toolCallId: "tool-1",
    })
    expect(record).toHaveBeenNthCalledWith(2, {
      runId: "workspace-run",
      path: "dist/b.js",
      kind: "created",
      toolCallId: "tool-1",
    })
  })
})
