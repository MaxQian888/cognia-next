import type { ChatSession } from "@cognia/agent-config-types"

import {
  createSessionOnPairedHost,
  HOST_SESSION_CREATE_WAIT_MS,
  HostSessionRefusedError,
  hostSessionSeed,
  type HostSessionCreateDeps,
} from "./host-session-create"

const session = (overrides: Partial<ChatSession> = {}): ChatSession =>
  ({
    id: "session-new",
    title: "New conversation",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }) as ChatSession

function deps(
  settlement: Awaited<ReturnType<NonNullable<HostSessionCreateDeps["awaitSettlement"]>>>,
  row: { id: string } | null = { id: "row-1" }
) {
  const enqueue = jest.fn().mockResolvedValue(row)
  const awaitSettlement = jest.fn().mockResolvedValue(settlement)
  return {
    enqueue,
    awaitSettlement,
    deps: { enqueue, awaitSettlement } as unknown as HostSessionCreateDeps,
  }
}

describe("hostSessionSeed", () => {
  it("carries the session's own choices as ids only", () => {
    expect(
      hostSessionSeed(
        session({
          projectId: "p1",
          characterId: "agent-1",
          model: "gpt-test",
          providerOverride: "openai",
          systemPrompt: "never on the wire",
          workingDir: "/Users/me/never-on-the-wire",
        })
      )
    ).toEqual({ projectId: "p1", characterId: "agent-1", model: "gpt-test", provider: "openai" })
  })

  it("is omitted when the session has no choices to seed", () => {
    expect(hostSessionSeed(session())).toBeUndefined()
  })
})

describe("createSessionOnPairedHost", () => {
  it("queues a seeded create and reports the Host's acceptance", async () => {
    const { enqueue, awaitSettlement, deps: d } = deps({ outcome: "applied" })
    await expect(
      createSessionOnPairedHost(session({ projectId: "p1", model: "m" }), { title: " Plan " }, d)
    ).resolves.toBe("host")
    expect(enqueue).toHaveBeenCalledWith({
      sessionId: "session-new",
      action: { kind: "session.create", title: "Plan", seed: { projectId: "p1", model: "m" } },
    })
    expect(awaitSettlement).toHaveBeenCalledWith("row-1", {
      timeoutMs: HOST_SESSION_CREATE_WAIT_MS,
    })
  })

  it("stays local when no paired Host negotiated HostState", async () => {
    const { awaitSettlement, deps: d } = deps({ outcome: "applied" }, null)
    await expect(createSessionOnPairedHost(session(), {}, d)).resolves.toBe("local")
    expect(awaitSettlement).not.toHaveBeenCalled()
  })

  it("stays local against a Host too old to know the intent", async () => {
    const { deps: d } = deps({ outcome: "rejected", code: "host_state_invalid_submit_request" })
    await expect(createSessionOnPairedHost(session(), {}, d)).resolves.toBe("local")
  })

  it("treats a redelivered create the Host already applied as created", async () => {
    const { deps: d } = deps({ outcome: "rejected", code: "host_state_session_exists" })
    await expect(createSessionOnPairedHost(session(), {}, d)).resolves.toBe("host")
  })

  it("leaves a create the Host has not answered yet queued", async () => {
    const { deps: d } = deps({ outcome: "pending" })
    await expect(createSessionOnPairedHost(session(), {}, d)).resolves.toBe("pending")
  })

  it("throws the Host's refusal so the conversation is never activated", async () => {
    const { deps: d } = deps({ outcome: "rejected", code: "host_state_project_not_found" })
    const attempt = createSessionOnPairedHost(session({ projectId: "local-only" }), {}, d)
    await expect(attempt).rejects.toBeInstanceOf(HostSessionRefusedError)
    await expect(attempt).rejects.toMatchObject({ code: "host_state_project_not_found" })
  })
})
