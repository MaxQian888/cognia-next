import "."
import { getExecutor } from "../registry"

describe("team-nodes registration", () => {
  it.each([
    ["action.agent.turn", 1],
    ["action.character.create", 1],
    ["action.character.send", 1],
    ["action.character.update", 1],
    ["action.team.compose", 1],
    ["action.team.create", 1],
    ["action.team.delegate", 1],
    ["action.team.message", 1],
    ["action.team.reconcile", 1],
    ["action.team.run", 1],
    ["action.team.status", 1],
    ["action.team.task.dispatch", 1],
    ["action.team.task.review", 1],
    ["action.team.update", 1],
  ])("registers %s@%s", (kind, version) => {
    expect(getExecutor(kind as never, version)).toBeDefined()
  })
})

const mockGetCharacter = jest.fn()
const mockPersistMessages = jest.fn()
jest.mock("@/lib/db/characters", () => ({
  ...jest.requireActual("@/lib/db/characters"),
  getCharacter: (...args: unknown[]) => mockGetCharacter(...args),
}))
jest.mock("@/lib/db/sessions", () => ({
  ...jest.requireActual("@/lib/db/sessions"),
  listSessions: jest.fn(async () => []),
}))
jest.mock("@/lib/db/messages", () => ({
  ...jest.requireActual("@/lib/db/messages"),
  listMessages: jest.fn(async () => []),
  persistMessages: (...args: unknown[]) => mockPersistMessages(...args),
}))

describe("action.character.send", () => {
  it("marks the message it posts as a workflow's, never the person's (ADR-0239)", async () => {
    mockGetCharacter.mockResolvedValue({ id: "c1", name: "Ada" })
    const executor = getExecutor("action.character.send" as never, 1)!
    await executor.execute({
      params: { characterId: "c1", sessionId: "sess-1", content: "status please" },
      workflowId: "wf1",
      runId: "run1",
      stepId: "s1",
    } as never)
    expect(mockPersistMessages).toHaveBeenCalledWith("sess-1", [
      expect.objectContaining({
        id: "msg_wf_run1_s1",
        role: "user",
        metadata: { automatedTurn: { producer: "workflow" } },
      }),
    ])
  })
})
