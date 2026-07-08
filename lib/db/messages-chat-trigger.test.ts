/** @jest-environment jsdom */
/**
 * Verifies that `persistMessages` fires `trigger.chat.message` exactly once
 * per newly-arrived user message. The earlier 15 tests in `messages.test.ts`
 * cover the diff/upsert mechanics; this file focuses on the trigger fan-out
 * we added in M2.
 */
import "fake-indexeddb/auto"
import type { UIMessage } from "ai"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"
import { persistMessages } from "./messages"
import { createSession } from "./sessions"

const dispatchTriggerMock = jest.fn()
const findMatchingWorkflowsMock = jest.fn()

jest.mock("@/lib/workflow/runtime/trigger-bridge", () => ({
  __esModule: true,
  dispatchTrigger: (...args: unknown[]) => dispatchTriggerMock(...args),
}))

jest.mock("@/lib/workflow/runtime/trigger-subscriptions", () => ({
  __esModule: true,
  findMatchingWorkflows: (...args: unknown[]) => findMatchingWorkflowsMock(...args),
}))

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  await whenSeeded()
  dispatchTriggerMock.mockReset()
  findMatchingWorkflowsMock.mockReset()
})

function userMessage(id: string, text: string): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
  } as UIMessage
}

function assistantMessage(id: string, text: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
  } as UIMessage
}

// Allow microtasks to drain so the fire-and-forget trigger fan-out completes.
const flush = async () => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  }
}

describe("persistMessages → trigger.chat.message", () => {
  it("fires the trigger once per new user message", async () => {
    const session = await createSession({ title: "t", kind: "direct", characterId: "char_x" })
    findMatchingWorkflowsMock.mockReturnValue([
      { workflowId: "wf_match", nodeId: "n1", params: {} },
    ])

    await persistMessages(session.id, [userMessage("m_user_1", "hi")])
    await flush()

    expect(findMatchingWorkflowsMock).toHaveBeenCalledWith("trigger.chat.message", {
      characterId: "char_x",
      sessionId: session.id,
    })
    expect(dispatchTriggerMock).toHaveBeenCalledTimes(1)
    const arg = dispatchTriggerMock.mock.calls[0][0] as { kind: string; workflowId: string }
    expect(arg.kind).toBe("trigger.chat.message")
    expect(arg.workflowId).toBe("wf_match")
  })

  it("does not refire when the message id already exists", async () => {
    const session = await createSession({ title: "t", kind: "direct", characterId: "char_x" })
    findMatchingWorkflowsMock.mockReturnValue([{ workflowId: "wf_x", nodeId: "n", params: {} }])
    await persistMessages(session.id, [userMessage("m_user_1", "hi")])
    await flush()
    expect(dispatchTriggerMock).toHaveBeenCalledTimes(1)
    dispatchTriggerMock.mockClear()

    // Re-persist the same message with an appended assistant turn — the user
    // message id is unchanged, so the trigger should NOT refire.
    await persistMessages(session.id, [
      userMessage("m_user_1", "hi"),
      assistantMessage("m_asst_1", "hello"),
    ])
    await flush()
    expect(dispatchTriggerMock).not.toHaveBeenCalled()
  })

  it("ignores assistant-only persists", async () => {
    const session = await createSession({ title: "t", kind: "direct", characterId: "char_x" })
    findMatchingWorkflowsMock.mockReturnValue([{ workflowId: "wf", nodeId: "n", params: {} }])
    await persistMessages(session.id, [assistantMessage("m_a", "system seed")])
    await flush()
    expect(dispatchTriggerMock).not.toHaveBeenCalled()
  })

  it("skips dispatch when no workflow matches", async () => {
    const session = await createSession({ title: "t", kind: "direct", characterId: "char_x" })
    findMatchingWorkflowsMock.mockReturnValue([])
    await persistMessages(session.id, [userMessage("m_user_1", "hi")])
    await flush()
    expect(findMatchingWorkflowsMock).toHaveBeenCalled()
    expect(dispatchTriggerMock).not.toHaveBeenCalled()
  })

  it("dispatch failures do not surface to the caller", async () => {
    const session = await createSession({ title: "t", kind: "direct", characterId: "char_x" })
    findMatchingWorkflowsMock.mockReturnValue([
      { workflowId: "wf_broken", nodeId: "n", params: {} },
    ])
    dispatchTriggerMock.mockRejectedValue(new Error("orchestrator down"))
    await expect(
      persistMessages(session.id, [userMessage("m_user_1", "hi")])
    ).resolves.toBeUndefined()
    await flush()
  })
})
