import { isTauri } from "@/lib/tauri"
import { resolveCharacterById } from "@/lib/db/characters"
import { getSession, listSessions, createSession, updateSession } from "@/lib/db/sessions"
import { getSettings } from "@/lib/db/settings"
import { resolveSendOptions } from "@/lib/claude/build-options"
import { runAndCaptureAssistantReply } from "@/lib/claude/run-and-capture"
import { AGENT_TURN_NODE, executeAgentTurn } from "./agent-turn"
import { roleCharacterId } from "../characters/pack"

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@/lib/db/characters", () => ({ resolveCharacterById: jest.fn() }))
jest.mock("@/lib/db/sessions", () => ({
  getSession: jest.fn(),
  listSessions: jest.fn(),
  createSession: jest.fn(),
  updateSession: jest.fn(),
}))
jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn() }))
jest.mock("@/lib/claude/build-options", () => ({ resolveSendOptions: jest.fn() }))
jest.mock("@/lib/claude/run-and-capture", () => ({ runAndCaptureAssistantReply: jest.fn() }))

const mIsTauri = isTauri as jest.Mock
const mResolveChar = resolveCharacterById as jest.Mock
const mGetSession = getSession as jest.Mock
const mListSessions = listSessions as jest.Mock
const mCreateSession = createSession as jest.Mock
const mUpdateSession = updateSession as jest.Mock
const mGetSettings = getSettings as jest.Mock
const mResolveSend = resolveSendOptions as jest.Mock
const mRun = runAndCaptureAssistantReply as jest.Mock

function makeCtx(params: Record<string, unknown>) {
  return {
    runId: "run1",
    workflowId: "wf1",
    stepId: "step1",
    params,
    upstream: {},
    trigger: { kind: "trigger.manual", payload: {}, originAt: 0 },
    signal: new AbortController().signal,
    log: jest.fn(),
    resolveSecret: jest.fn(),
  } as never
}

beforeEach(() => {
  jest.clearAllMocks()
  mIsTauri.mockReturnValue(true)
  mResolveChar.mockResolvedValue({ id: "c", name: "Go Refactorer", systemPrompt: "x" })
  mListSessions.mockResolvedValue([])
  mCreateSession.mockResolvedValue({ id: "sess-new" })
  mGetSession.mockImplementation(async (id: string) => ({ id, workingDir: "/repo" }))
  mGetSettings.mockResolvedValue({})
  mResolveSend.mockResolvedValue({ cwd: "/repo" })
  mRun.mockResolvedValue({ text: "done", messageId: "m1", a2uiSurfaces: {}, a2uiSurfaceOrder: [] })
})

describe("AGENT_TURN_NODE shape", () => {
  it("is a desktop-only, non-retryable plugin node requiring prompt + cwd", () => {
    expect(AGENT_TURN_NODE.kind).toBe("agent.turn")
    expect(AGENT_TURN_NODE.category).toBe("plugin")
    expect(AGENT_TURN_NODE.desktopOnly).toBe(true)
    expect(AGENT_TURN_NODE.retryable).toBe(false)
    const schema = AGENT_TURN_NODE.paramsSchema as { required?: string[] }
    expect(schema.required).toEqual(expect.arrayContaining(["prompt", "cwd"]))
    expect((AGENT_TURN_NODE.defaultParams as { role?: string }).role).toBe("refactorer")
    expect(AGENT_TURN_NODE.execute).toBe(executeAgentTurn)
  })
})

describe("executeAgentTurn validation", () => {
  it("rejects a missing prompt", async () => {
    await expect(executeAgentTurn(makeCtx({ cwd: "/repo", role: "refactorer" }))).rejects.toThrow(
      /prompt/
    )
  })

  it("rejects a missing cwd", async () => {
    await expect(executeAgentTurn(makeCtx({ prompt: "go", role: "refactorer" }))).rejects.toThrow(
      /cwd/
    )
  })

  it("rejects when neither characterId nor a known role is given", async () => {
    await expect(
      executeAgentTurn(makeCtx({ prompt: "go", cwd: "/repo", role: "wizard" }))
    ).rejects.toThrow(/role/)
  })

  it("rejects outside the desktop runtime", async () => {
    mIsTauri.mockReturnValue(false)
    await expect(
      executeAgentTurn(makeCtx({ prompt: "go", cwd: "/repo", role: "refactorer" }))
    ).rejects.toThrow(/desktop runtime/)
    expect(mRun).not.toHaveBeenCalled()
  })

  it("fails when the role character cannot be resolved (plugin disabled)", async () => {
    mResolveChar.mockResolvedValue(undefined)
    await expect(
      executeAgentTurn(makeCtx({ prompt: "go", cwd: "/repo", role: "refactorer" }))
    ).rejects.toThrow(/not found/)
  })
})

describe("executeAgentTurn happy path", () => {
  it("resolves role → character, creates a cwd-scoped session, and runs a headless turn", async () => {
    const res = await executeAgentTurn(
      makeCtx({ prompt: "Refactor the auth module", cwd: "/repo", role: "refactorer" })
    )
    expect(mResolveChar).toHaveBeenCalledWith(roleCharacterId("refactorer"))
    expect(mCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ characterId: roleCharacterId("refactorer"), workingDir: "/repo" })
    )
    expect(mResolveSend).toHaveBeenCalledWith(
      expect.objectContaining({ character: expect.any(Object) })
    )
    expect(mRun).toHaveBeenCalledWith(
      "sess-new",
      "Refactor the auth module",
      // The node stamps the headless bypass onto the resolved options; the
      // character definitions deliberately carry no permissionMode.
      { cwd: "/repo", permissionMode: "bypassPermissions" },
      expect.objectContaining({ timeoutMs: 600000 })
    )
    expect(res.output).toMatchObject({
      text: "done",
      messageId: "m1",
      characterId: roleCharacterId("refactorer"),
      sessionId: "sess-new",
    })
  })

  it("honours an explicit characterId over role", async () => {
    await executeAgentTurn(
      makeCtx({ prompt: "go", cwd: "/repo", characterId: "char_custom", role: "refactorer" })
    )
    expect(mResolveChar).toHaveBeenCalledWith("char_custom")
  })

  it("reuses the role's existing session and re-points its workingDir", async () => {
    mListSessions.mockResolvedValue([
      { id: "old", characterId: roleCharacterId("refactorer"), workingDir: "/stale" },
    ])
    await executeAgentTurn(makeCtx({ prompt: "go", cwd: "/repo", role: "refactorer" }))
    expect(mUpdateSession).toHaveBeenCalledWith("old", { workingDir: "/repo" })
    expect(mCreateSession).not.toHaveBeenCalled()
    expect(mRun).toHaveBeenCalledWith(
      "old",
      "go",
      { cwd: "/repo", permissionMode: "bypassPermissions" },
      expect.any(Object)
    )
  })

  it("passes a custom timeoutSec through to the runner", async () => {
    await executeAgentTurn(makeCtx({ prompt: "go", cwd: "/repo", role: "tester", timeoutSec: 30 }))
    expect(mRun).toHaveBeenCalledWith(
      expect.any(String),
      "go",
      expect.any(Object),
      expect.objectContaining({ timeoutMs: 30000 })
    )
  })
})

describe("executeAgentTurn session handling", () => {
  it("uses an explicit sessionId and re-points its workingDir when it differs", async () => {
    mGetSession.mockResolvedValue({ id: "sX", workingDir: "/stale" })
    await executeAgentTurn(
      makeCtx({ prompt: "go", cwd: "/repo", role: "refactorer", sessionId: "sX" })
    )
    expect(mGetSession).toHaveBeenCalledWith("sX")
    expect(mUpdateSession).toHaveBeenCalledWith("sX", { workingDir: "/repo" })
    expect(mListSessions).not.toHaveBeenCalled()
    expect(mCreateSession).not.toHaveBeenCalled()
    expect(mRun).toHaveBeenCalledWith("sX", "go", expect.any(Object), expect.any(Object))
  })

  it("does not re-point an explicit session already on the right cwd", async () => {
    mGetSession.mockResolvedValue({ id: "sX", workingDir: "/repo" })
    await executeAgentTurn(
      makeCtx({ prompt: "go", cwd: "/repo", role: "refactorer", sessionId: "sX" })
    )
    expect(mUpdateSession).not.toHaveBeenCalled()
  })

  it("falls back to reuse/create when the explicit sessionId no longer exists", async () => {
    // getSession returns undefined for the by-id lookup, then a row for the
    // resolveSendOptions re-fetch of the created session.
    mGetSession.mockResolvedValueOnce(undefined)
    await executeAgentTurn(
      makeCtx({ prompt: "go", cwd: "/repo", role: "refactorer", sessionId: "gone" })
    )
    expect(mListSessions).toHaveBeenCalled()
    expect(mCreateSession).toHaveBeenCalled()
  })

  it("reuses a matching session without an update when its cwd already matches", async () => {
    mListSessions.mockResolvedValue([
      { id: "old", characterId: roleCharacterId("refactorer"), workingDir: "/repo" },
    ])
    await executeAgentTurn(makeCtx({ prompt: "go", cwd: "/repo", role: "refactorer" }))
    expect(mUpdateSession).not.toHaveBeenCalled()
    expect(mCreateSession).not.toHaveBeenCalled()
  })

  it("applies bypassPermissions to the resolved send options, not to the character", async () => {
    // The headless runner has no UI to answer a permission prompt, so the
    // bypass must be applied — but ONLY here. Pinning it at the call site is
    // what keeps it off the character definitions, where it would also cover
    // ordinary interactive chat (see characters/pack.test.ts).
    const resolved: Record<string, unknown> = {}
    mResolveSend.mockResolvedValue(resolved)
    await executeAgentTurn(makeCtx({ prompt: "go", cwd: "/repo", role: "refactorer" }))
    expect(resolved.permissionMode).toBe("bypassPermissions")
    expect(mRun).toHaveBeenCalledWith(
      expect.any(String),
      "go",
      expect.objectContaining({ permissionMode: "bypassPermissions" }),
      expect.any(Object)
    )
  })
})

describe("executeAgentTurn fallbacks", () => {
  it("treats a missing params object as empty (rejects on prompt)", async () => {
    await expect(
      executeAgentTurn({ runId: "r", stepId: "s", signal: new AbortController().signal } as never)
    ).rejects.toThrow(/prompt/)
  })

  it("rejects when both role and characterId are absent", async () => {
    await expect(executeAgentTurn(makeCtx({ prompt: "go", cwd: "/repo" }))).rejects.toThrow(/role/)
  })

  it("emits role=null in the output when only a characterId is given", async () => {
    const res = await executeAgentTurn(
      makeCtx({ prompt: "go", cwd: "/repo", characterId: "char_custom" })
    )
    expect((res.output as { role: string | null }).role).toBeNull()
  })

  it("tolerates getSettings rejecting and a re-fetched session being absent", async () => {
    mGetSettings.mockRejectedValue(new Error("settings unavailable"))
    mGetSession.mockResolvedValue(undefined)
    await executeAgentTurn(makeCtx({ prompt: "go", cwd: "/repo", role: "refactorer" }))
    expect(mResolveSend).toHaveBeenCalledWith(
      expect.objectContaining({ session: null, appSettings: null })
    )
    expect(mRun).toHaveBeenCalled()
  })
})
