import type { UIMessage } from "ai"
import type { ChatSession } from "@cognia/agent-config-types"

jest.mock("@/hooks/chat/chat-send-bridge", () => ({ sendChatMessage: jest.fn() }))
jest.mock("@/hooks/chat/steer-runtime", () => ({ sessionStatusOf: jest.fn(() => "idle") }))
jest.mock("./user-actions", () => ({ enableProjectCoordination: jest.fn() }))

import {
  CONTINUE_RESULT_MAX_CHARS,
  continueAsProject,
  renderContinueSeed,
  type ContinueAsProjectDeps,
} from "./continue-as-project"

const NOW = 9_000

function session(extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "s1",
    kind: "direct",
    title: "Refactor billing",
    projectId: "p1",
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  } as ChatSession
}

const message = (id: string, role: "user" | "assistant", text: string): UIMessage =>
  ({ id, role, parts: [{ type: "text", text }] }) as UIMessage

function setup(row: ChatSession | undefined, messages: UIMessage[] = []) {
  const rows = new Map(row ? [[row.id, row]] : [])
  const deps: ContinueAsProjectDeps = {
    getSession: async (id) => rows.get(id),
    updateSession: jest.fn(async (id, patch) => {
      rows.set(id, { ...rows.get(id)!, ...patch })
    }),
    listMessages: async () => messages,
    statusOf: jest.fn(() => "idle" as const),
    enable: jest.fn(async () => ({ id: "coord", projectId: "p1" }) as ChatSession),
    send: jest.fn(() => true),
    gate: jest.fn(() => true),
    now: () => NOW,
  }
  return { deps, rows }
}

describe("continueAsProject", () => {
  it("turns the conversation into a completed thread and seeds the coordinator", async () => {
    const { deps, rows } = setup(session(), [
      message("u1", "user", "Please refactor billing"),
      message("a1", "assistant", "Done with the invoice module."),
    ])
    const result = await continueAsProject(
      { sessionId: "s1", coordinatorTitle: "Project coordinator" },
      deps
    )
    expect(deps.enable).toHaveBeenCalledWith("p1", "Project coordinator")
    expect(result).toMatchObject({ kind: "continued", seeded: true })
    expect(rows.get("s1")).toMatchObject({
      projectRole: "thread",
      parentSessionId: "coord",
      projectThread: {
        coordinatorSessionId: "coord",
        brief: "Refactor billing",
        proposedBy: "user",
      },
      attachedChild: {
        lifecycleOwnerSessionId: "coord",
        workspace: "independent",
        status: "completed",
        result: { summary: "Done with the invoice module.", messageId: "a1", completedAt: NOW },
      },
    })
    const [target, seed] = (deps.send as jest.Mock).mock.calls[0]
    expect(target).toBe("coord")
    expect(seed).toContain('Continue the conversation "Refactor billing"')
    expect(seed).toContain("thread s1")
    expect(seed).toContain("Please refactor billing")
  })

  it("keeps a secret out of the seed and the recorded result", async () => {
    const { deps, rows } = setup(session(), [message("a1", "assistant", "key sk-live-1")])
    ;(deps.gate as jest.Mock).mockImplementation((text: string) => !text.includes("sk-live"))
    await continueAsProject({ sessionId: "s1", coordinatorTitle: "C" }, deps)
    expect(rows.get("s1")?.attachedChild?.result).toBeUndefined()
    const seed = (deps.send as jest.Mock).mock.calls[0][1] as string
    expect(seed).not.toContain("sk-live")
    expect(seed).toContain("read it with read_thread_report")
  })

  it("names the thread by id when even its title would be refused", async () => {
    const { deps } = setup(session({ title: "mail bob@example.com" }))
    ;(deps.gate as jest.Mock).mockImplementation((text: string) => !text.includes("@example"))
    await continueAsProject({ sessionId: "s1", coordinatorTitle: "C" }, deps)
    const seed = (deps.send as jest.Mock).mock.calls[0][1] as string
    expect(seed).toContain('Continue the conversation "s1"')
  })

  it("truncates a long result and reports an unseeded coordinator", async () => {
    const { deps, rows } = setup(session(), [
      message("a1", "assistant", "x".repeat(CONTINUE_RESULT_MAX_CHARS + 20)),
    ])
    ;(deps.send as jest.Mock).mockReturnValue(false)
    const result = await continueAsProject({ sessionId: "s1", coordinatorTitle: "C" }, deps)
    expect(result).toMatchObject({ kind: "continued", seeded: false })
    expect(rows.get("s1")?.attachedChild?.result?.summary).toHaveLength(CONTINUE_RESULT_MAX_CHARS)
  })

  it("refuses without touching anything", async () => {
    const { deps } = setup(session({ projectRole: "coordinator" }))
    await expect(
      continueAsProject({ sessionId: "s1", coordinatorTitle: "C" }, deps)
    ).resolves.toEqual({
      kind: "refused",
      reason: "already-project",
    })
    expect(deps.enable).not.toHaveBeenCalled()
    expect(deps.updateSession).not.toHaveBeenCalled()
  })
})

describe("renderContinueSeed", () => {
  it("asks the coordinator to plan what remains", () => {
    const seed = renderContinueSeed({ title: "T", threadId: "t1", context: "ctx" })
    expect(seed).toContain("propose_threads")
    expect(seed).toContain("Context from that conversation:\n\nctx")
  })
})
