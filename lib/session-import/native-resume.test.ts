import type { ChatSession } from "@cognia/agent-config-types"

import { resumeImportedSessionNative } from "./native-resume"

function imported(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "import:codex:thread-1",
    title: "Imported",
    createdAt: 0,
    updatedAt: 0,
    importOwnership: "source-mirror",
    importRuntimeBinding: {
      nativeSessionId: "thread-1",
      presetId: "codex",
      cwd: "/workspace",
      resumeMethod: "protocol",
    },
    ...overrides,
  } as ChatSession
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    config: { id: "agent-1", metadata: { preset: "codex" } },
    connectionStatus: "connected",
    validity: {
      sessionExtensions: {
        "session/resume": { state: "supported" },
      },
    },
    ...overrides,
  } as never
}

describe("resumeImportedSessionNative", () => {
  const resumeSession = jest.fn(async () => ({ id: "thread-1" }))
  const bind = jest.fn(async () => {})
  const exists = jest.fn(async () => true)

  beforeEach(() => {
    resumeSession.mockClear()
    bind.mockClear()
    exists.mockReset().mockResolvedValue(true)
  })

  it("requires a native id and matching preset", async () => {
    const result = await resumeImportedSessionNative(
      imported({ importRuntimeBinding: { nativeSessionId: "thread-1" } }),
      {
        manager: { getAllAgents: () => [agent()], resumeSession },
        fs: { exists },
        bind,
      }
    )
    expect(result).toEqual({ ok: false, code: "preset-missing" })
    expect(resumeSession).not.toHaveBeenCalled()
  })

  it("does not auto-connect or resume an unverified capability", async () => {
    const result = await resumeImportedSessionNative(imported(), {
      manager: {
        getAllAgents: () => [
          agent({
            connectionStatus: "disconnected",
            validity: {
              blockingReason: "codex executable was not found",
              sessionExtensions: { "session/resume": { state: "unknown" } },
            },
          }),
        ],
        resumeSession,
      },
      fs: { exists },
      bind,
    })
    expect(result).toEqual({
      ok: false,
      code: "runtime-unavailable",
      detail: "codex executable was not found",
    })
    expect(resumeSession).not.toHaveBeenCalled()
  })

  it("refuses a missing working directory", async () => {
    exists.mockResolvedValue(false)
    const result = await resumeImportedSessionNative(imported(), {
      manager: { getAllAgents: () => [agent()], resumeSession },
      fs: { exists },
      bind,
    })
    expect(result).toEqual({ ok: false, code: "cwd-missing", detail: "/workspace" })
  })

  it("binds only after the resume handshake succeeds", async () => {
    const result = await resumeImportedSessionNative(imported(), {
      manager: { getAllAgents: () => [agent()], resumeSession },
      fs: { exists },
      bind,
      now: () => "2026-08-29T00:00:00.000Z",
    })
    expect(resumeSession).toHaveBeenCalledWith("agent-1", "thread-1", { cwd: "/workspace" })
    expect(bind).toHaveBeenCalledWith("import:codex:thread-1", {
      nativeSessionId: "thread-1",
      presetId: "codex",
      cwd: "/workspace",
      resumeMethod: "protocol",
      verifiedAt: "2026-08-29T00:00:00.000Z",
    })
    expect(result).toEqual({ ok: true, agentId: "agent-1", nativeSessionId: "thread-1" })
  })

  it("keeps the mirror read-only when the handshake fails", async () => {
    resumeSession.mockRejectedValueOnce(new Error("session expired"))
    const result = await resumeImportedSessionNative(imported(), {
      manager: { getAllAgents: () => [agent()], resumeSession },
      fs: { exists },
      bind,
    })
    expect(result).toEqual({ ok: false, code: "handshake-failed", detail: "session expired" })
    expect(bind).not.toHaveBeenCalled()
  })
})
