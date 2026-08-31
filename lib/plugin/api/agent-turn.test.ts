/** @jest-environment jsdom */
/**
 * What matters here is the session reuse ladder and the permission posture:
 * a headless turn that silently widens permissions, or that spawns a new
 * session per call, is the failure mode this API exists to prevent.
 */

const getSession = jest.fn()
const listSessions = jest.fn(async () => [] as Array<Record<string, unknown>>)
const createSession = jest.fn(async () => ({ id: "sess-new" }))
const updateSession = jest.fn(async () => undefined)
const resolveCharacterById = jest.fn(async () => ({ id: "char-1" }))
const getSettings = jest.fn(async () => ({ theme: "dark" }))
const resolveSendOptions = jest.fn(async () => ({ cwd: "/repo" }) as Record<string, unknown>)
const runAndCaptureAssistantReply = jest.fn(async () => ({ text: "done", messageId: "m1" }))

jest.mock("@/lib/db/sessions", () => ({
  getSession: (...a: unknown[]) => (getSession as (...args: unknown[]) => unknown)(...a),
  listSessions: () => listSessions(),
  createSession: (...a: unknown[]) => (createSession as (...args: unknown[]) => unknown)(...a),
  updateSession: (...a: unknown[]) => (updateSession as (...args: unknown[]) => unknown)(...a),
}))
jest.mock("@/lib/db/characters", () => ({
  resolveCharacterById: (...a: unknown[]) =>
    (resolveCharacterById as (...args: unknown[]) => unknown)(...a),
}))
jest.mock("@/lib/db/settings", () => ({ getSettings: () => getSettings() }))
jest.mock("@/lib/claude/build-options", () => ({
  resolveSendOptions: (...a: unknown[]) =>
    (resolveSendOptions as (...args: unknown[]) => unknown)(...a),
}))
jest.mock("@/lib/claude/run-and-capture", () => ({
  runAndCaptureAssistantReply: (...a: unknown[]) =>
    (runAndCaptureAssistantReply as (...args: unknown[]) => unknown)(...a),
}))

import { PluginAgentTurnError, runPluginAgentTurn } from "./agent-turn"

const base = { characterId: "char-1", prompt: "go", cwd: "/repo" }

beforeEach(() => {
  jest.clearAllMocks()
  getSession.mockResolvedValue(null)
  listSessions.mockResolvedValue([])
  createSession.mockResolvedValue({ id: "sess-new" })
  resolveCharacterById.mockResolvedValue({ id: "char-1" })
  resolveSendOptions.mockResolvedValue({ cwd: "/repo" })
  runAndCaptureAssistantReply.mockResolvedValue({ text: "done", messageId: "m1" })
})

describe("runPluginAgentTurn", () => {
  it("refuses an empty prompt or cwd before touching the database", async () => {
    await expect(runPluginAgentTurn({ ...base, prompt: "  " })).rejects.toBeInstanceOf(
      PluginAgentTurnError
    )
    await expect(runPluginAgentTurn({ ...base, cwd: "" })).rejects.toBeInstanceOf(
      PluginAgentTurnError
    )
    expect(resolveCharacterById).not.toHaveBeenCalled()
  })

  it("refuses an unknown character rather than running a default persona", async () => {
    resolveCharacterById.mockResolvedValue(null as never)
    await expect(runPluginAgentTurn(base)).rejects.toThrow(/character "char-1" not found/)
  })

  it("reuses the character's most recent session instead of creating one per turn", async () => {
    listSessions.mockResolvedValue([{ id: "sess-old", characterId: "char-1", workingDir: "/repo" }])
    await expect(runPluginAgentTurn(base)).resolves.toMatchObject({ sessionId: "sess-old" })
    expect(createSession).not.toHaveBeenCalled()
  })

  it("repins a reused session onto the requested cwd", async () => {
    listSessions.mockResolvedValue([{ id: "sess-old", characterId: "char-1", workingDir: "/old" }])
    await runPluginAgentTurn(base)
    expect(updateSession).toHaveBeenCalledWith("sess-old", { workingDir: "/repo" })
  })

  it("creates a session only when the character has none", async () => {
    await expect(runPluginAgentTurn(base)).resolves.toMatchObject({ sessionId: "sess-new" })
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ characterId: "char-1", workingDir: "/repo" })
    )
  })

  it("leaves the character's permission posture alone unless asked", async () => {
    await runPluginAgentTurn(base)
    const [, , sendOptions] = runAndCaptureAssistantReply.mock.calls[0] as unknown[]
    expect(sendOptions).not.toHaveProperty("permissionMode")
  })

  it("applies an explicit bypass only for the call that asked for it", async () => {
    await runPluginAgentTurn({ ...base, permissionMode: "bypassPermissions" })
    const [, , sendOptions] = runAndCaptureAssistantReply.mock.calls[0] as unknown[]
    expect(sendOptions).toMatchObject({ permissionMode: "bypassPermissions" })
  })

  it("survives an unreadable settings row", async () => {
    getSettings.mockRejectedValue(new Error("db closed"))
    await expect(runPluginAgentTurn(base)).resolves.toMatchObject({ text: "done" })
    expect(resolveSendOptions).toHaveBeenCalledWith(expect.objectContaining({ appSettings: null }))
  })
})
