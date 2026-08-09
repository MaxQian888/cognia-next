import {
  buildSessionPeerManifestEntries,
  isSessionPeerBuiltinTool,
  runSessionPeerBuiltinTool,
  SESSION_PEER_TOOL_NAMES,
  type SessionPeerToolRunDeps,
} from "./session-peer-builtin-tools"

function deps(): SessionPeerToolRunDeps {
  return {
    gate: () => true,
    listReachable: jest.fn(async () => [
      { id: "peer-1", title: "Review", status: "idle" as const },
    ]),
    send: jest.fn(async (input) => ({ ok: true, ...input, status: "delivered" as const })),
  }
}

describe("session peer built-in tools", () => {
  it("advertises discovery and plain-text send with strict schemas", () => {
    const entries = buildSessionPeerManifestEntries()
    expect(entries.map((entry) => entry.name)).toEqual([
      SESSION_PEER_TOOL_NAMES.listSessions,
      SESSION_PEER_TOOL_NAMES.sendMessage,
    ])
    expect(entries.every((entry) => entry.jsonSchema.additionalProperties === false)).toBe(true)
    expect(isSessionPeerBuiltinTool(SESSION_PEER_TOOL_NAMES.sendMessage)).toBe(true)
    expect(isSessionPeerBuiltinTool("team_send_message")).toBe(false)
  })

  it("discovers only through the caller session identity", async () => {
    const d = deps()
    await expect(
      runSessionPeerBuiltinTool(SESSION_PEER_TOOL_NAMES.listSessions, {}, d, {
        sessionId: "sender-1",
      })
    ).resolves.toEqual({
      ok: true,
      sessions: [{ id: "peer-1", title: "Review", status: "idle" }],
    })
    expect(d.listReachable).toHaveBeenCalledWith("sender-1")
  })

  it("sends an agent-origin untrusted message and defaults to trigger_turn", async () => {
    const d = deps()
    await runSessionPeerBuiltinTool(
      SESSION_PEER_TOOL_NAMES.sendMessage,
      { target_session_id: "peer-1", message: "Review this" },
      d,
      { sessionId: "sender-1" }
    )
    expect(d.send).toHaveBeenCalledWith({
      senderSessionId: "sender-1",
      receiverSessionId: "peer-1",
      content: "Review this",
      intent: "trigger_turn",
      origin: "agent",
    })
  })

  it("fails closed on invalid, self-targeted, or PII-gate-blocked input", async () => {
    const d = deps()
    await expect(
      runSessionPeerBuiltinTool(
        SESSION_PEER_TOOL_NAMES.sendMessage,
        { target_session_id: "sender-1", message: "self" },
        d,
        { sessionId: "sender-1" }
      )
    ).resolves.toMatchObject({ ok: false })

    d.gate = () => false
    await expect(
      runSessionPeerBuiltinTool(
        SESSION_PEER_TOOL_NAMES.sendMessage,
        { target_session_id: "peer-1", message: "secret" },
        d,
        { sessionId: "sender-1" }
      )
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining("PII") })
  })
})
