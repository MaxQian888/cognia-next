/** @jest-environment jsdom */
/**
 * What matters here is caller-owned session reuse and the permission posture:
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
const parkOutcome = jest.fn(async (): Promise<Record<string, unknown>> => ({ kind: "expired" }))
const parkFinish = jest.fn(async () => undefined)
const createUnattendedPark = jest.fn((_options: Record<string, unknown>) => ({
  park: () => parkOutcome(),
  finish: (...a: unknown[]) => (parkFinish as (...args: unknown[]) => unknown)(...a),
  runId: () => null,
}))

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
jest.mock("@/lib/claude/unattended-park", () => ({
  createUnattendedPark: (options: Record<string, unknown>) => createUnattendedPark(options),
}))
const recordSurfaceUsage = jest.fn(async (..._args: unknown[]) => null as unknown)
jest.mock("@/lib/db/session-usage", () => ({
  ...jest.requireActual("@/lib/db/session-usage"),
  recordSurfaceUsage: (...a: unknown[]) => recordSurfaceUsage(...a),
}))
jest.mock("@/lib/claude/run-and-capture", () => ({
  runAndCaptureAssistantReply: (...a: unknown[]) =>
    (runAndCaptureAssistantReply as (...args: unknown[]) => unknown)(...a),
}))

import { PluginAgentTurnError, runPluginAgentTurn } from "./agent-turn"
import {
  __resetClaimedTurnUsageForTesting,
  isTurnUsageClaimed,
} from "@/lib/usage/claimed-turn-usage"

const caller = { grantSource: { kind: "plugin" as const, id: "acme" } }
const owner = { kind: "plugin" as const, id: "acme" }
const ownedSession = {
  id: "sess-owned",
  characterId: "char-1",
  workingDir: "/repo",
  agentTurnOwner: owner,
}

function runTurn(
  request: Parameters<typeof runPluginAgentTurn>[0],
  options: Parameters<typeof runPluginAgentTurn>[1] = caller
) {
  return runPluginAgentTurn(request, options)
}

const base = { characterId: "char-1", prompt: "go", cwd: "/repo" }

beforeEach(() => {
  jest.clearAllMocks()
  getSession.mockResolvedValue(null)
  listSessions.mockResolvedValue([])
  createSession.mockResolvedValue({ id: "sess-new" })
  resolveCharacterById.mockResolvedValue({ id: "char-1" })
  resolveSendOptions.mockResolvedValue({ cwd: "/repo" })
  runAndCaptureAssistantReply.mockResolvedValue({ text: "done", messageId: "m1" })
  parkOutcome.mockResolvedValue({ kind: "expired" })
  recordSurfaceUsage.mockResolvedValue(null)
  __resetClaimedTurnUsageForTesting()
})

/** The host's own grant every unattended turn carries (ADR-0224 A7). */
const HOST_GRANT = { schemaVersion: 1, source: owner, permissionProfile: {} }

describe("runPluginAgentTurn", () => {
  it("parks a permission ask and reports needs_approval when nobody answers", async () => {
    runAndCaptureAssistantReply.mockImplementation(async (...args: unknown[]) => {
      const opts = args[3] as {
        onPermissionRequest?: (req: unknown) => Promise<{ decision: string; message?: string }>
      }
      const decision = await opts.onPermissionRequest?.({
        type: "permission_request",
        sessionId: "s1",
        requestId: "r1",
        toolUseID: "tu1",
        toolName: "Edit",
        input: {},
      })
      expect(decision?.decision).toBe("deny")
      expect(decision?.message).toContain("needs_approval")
      return { text: "I could not edit the file.", messageId: "m1" }
    })
    const result = await runTurn({ characterId: "c1", prompt: "go", cwd: "/repo" })
    expect(result.status).toBe("needs_approval")
    expect(result.needsApproval).toEqual([
      expect.objectContaining({ requestId: "r1", toolName: "Edit" }),
    ])
    expect(parkFinish).toHaveBeenCalledWith("completed", undefined)
  })

  it("resumes the turn when a person approves the parked request", async () => {
    parkOutcome.mockResolvedValue({ kind: "approved", decision: { decision: "allow" } })
    runAndCaptureAssistantReply.mockImplementation(async (...args: unknown[]) => {
      const opts = args[3] as {
        onPermissionRequest?: (req: unknown) => Promise<{ decision: string }>
        pauseTimeoutWhileAwaitingPermission?: boolean
      }
      expect(opts.pauseTimeoutWhileAwaitingPermission).toBe(true)
      const decision = await opts.onPermissionRequest?.({
        type: "permission_request",
        sessionId: "s1",
        requestId: "r1",
        toolUseID: "tu1",
        toolName: "Edit",
        input: {},
      })
      expect(decision).toEqual({ decision: "allow", attribution: { authority: "human" } })
      return { text: "Edited.", messageId: "m1" }
    })
    const result = await runTurn(base)
    expect(result.status).toBe("completed")
  })

  it("parks a Bot's turn under its own name and links it to the Bots page", async () => {
    await runTurn(base, {
      grantSource: { kind: "bot", id: "inst-1" },
      unattendedLabel: "Bot: Release notes",
    })
    expect(createUnattendedPark).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "bot", sessionId: "sess-new", label: "Bot: Release notes" })
    )
    expect(resolveSendOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityGrants: [{ ...HOST_GRANT, source: { kind: "bot", id: "inst-1" } }],
      })
    )
  })

  // ADR-0239: a Bot's recipient list reaches the turn's outbound planning.
  it("plans the turn's outbound calls with the caller's recipient lists", async () => {
    const lists = [{ policyRef: "bot:inst-1", fingerprints: ["fp"] }]
    await runTurn(base, {
      grantSource: { kind: "bot", id: "inst-1" },
      outboundOrigin: { rootSessionId: "bot:inst-1" },
      outboundPolicyGrants: lists,
    })
    const [, , , opts] = runAndCaptureAssistantReply.mock.calls[0] as unknown[]
    expect((opts as { outboundPolicy?: unknown }).outboundPolicy).toEqual({
      unattended: true,
      origin: { rootSessionId: "bot:inst-1" },
      policyGrants: lists,
    })

    runAndCaptureAssistantReply.mockClear()
    await runTurn(base, { grantSource: { kind: "bot", id: "inst-1" }, outboundPolicyGrants: [] })
    const [, , , bare] = runAndCaptureAssistantReply.mock.calls[0] as unknown[]
    expect((bare as { outboundPolicy?: unknown }).outboundPolicy).toEqual({ unattended: true })
  })

  it("closes a parked run as failed when the turn throws", async () => {
    runAndCaptureAssistantReply.mockRejectedValue(new Error("sidecar exited"))
    await expect(runTurn(base)).rejects.toThrow("sidecar exited")
    expect(parkFinish).toHaveBeenCalledWith("failed", undefined)
  })

  it("reports completed when the turn never asked for a permission", async () => {
    const result = await runTurn({ characterId: "c1", prompt: "go", cwd: "/repo" })
    expect(result.status).toBe("completed")
    expect(result.needsApproval).toBeUndefined()
    const [, , , opts] = runAndCaptureAssistantReply.mock.calls[0] as unknown[]
    expect((opts as { onPermissionRequest?: unknown }).onPermissionRequest).toEqual(
      expect.any(Function)
    )
  })

  it("refuses an empty prompt or cwd before touching the database", async () => {
    await expect(runTurn({ ...base, prompt: "  " })).rejects.toBeInstanceOf(PluginAgentTurnError)
    await expect(runTurn({ ...base, cwd: "" })).rejects.toBeInstanceOf(PluginAgentTurnError)
    expect(resolveCharacterById).not.toHaveBeenCalled()
  })

  it("refuses an unknown character rather than running a default persona", async () => {
    resolveCharacterById.mockResolvedValue(null as never)
    await expect(runTurn(base)).rejects.toThrow(/character "char-1" not found/)
  })

  it("never adopts or repins the user's most recent chat when sessionId is absent", async () => {
    const interactive = { id: "user-chat", characterId: "char-1", workingDir: "/user-repo" }
    listSessions.mockResolvedValue([interactive])
    await expect(runTurn(base)).resolves.toMatchObject({ sessionId: "sess-new" })
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        characterId: "char-1",
        workingDir: "/repo",
        agentTurnOwner: owner,
      })
    )
    expect(updateSession).not.toHaveBeenCalled()
    expect(runAndCaptureAssistantReply).toHaveBeenCalledWith(
      "sess-new",
      "go",
      expect.anything(),
      expect.anything()
    )
    expect(interactive.workingDir).toBe("/user-repo")
  })

  it("rejects an unknown explicit sessionId without falling back or creating a session", async () => {
    listSessions.mockResolvedValue([
      ownedSession,
      {
        id: "user-chat",
        characterId: "char-1",
        workingDir: "/user-repo",
      },
    ])
    await expect(runTurn({ ...base, sessionId: "missing" })).rejects.toThrow(/session.*not found/)
    expect(listSessions).not.toHaveBeenCalled()
    expect(createSession).not.toHaveBeenCalled()
    expect(updateSession).not.toHaveBeenCalled()
    expect(runAndCaptureAssistantReply).not.toHaveBeenCalled()
  })

  it.each([
    ["interactive", undefined, "char-1"],
    ["another plugin", { kind: "plugin", id: "other" }, "char-1"],
    ["a bot with the same id", { kind: "bot", id: "acme" }, "char-1"],
    ["another caller key", { ...owner, key: "other" }, "char-1"],
    ["another character", owner, "char-2"],
  ])(
    "rejects an explicit session belonging to %s before writing or running",
    async (_label, agentTurnOwner, characterId) => {
      getSession.mockResolvedValue({
        ...ownedSession,
        agentTurnOwner,
        characterId,
        workingDir: "/user-repo",
      })
      await expect(runTurn({ ...base, sessionId: "sess-owned" })).rejects.toThrow(
        PluginAgentTurnError
      )
      expect(createSession).not.toHaveBeenCalled()
      expect(updateSession).not.toHaveBeenCalled()
      expect(runAndCaptureAssistantReply).not.toHaveBeenCalled()
    }
  )

  it("reuses only the caller's session for this character and cwd", async () => {
    listSessions.mockResolvedValue([
      { ...ownedSession, id: "user-chat", agentTurnOwner: undefined },
      { ...ownedSession, id: "other-plugin", agentTurnOwner: { ...owner, id: "other" } },
      { ...ownedSession, id: "other-kind", agentTurnOwner: { ...owner, kind: "bot" } },
      { ...ownedSession, id: "other-key", agentTurnOwner: { ...owner, key: "other" } },
      { ...ownedSession, id: "other-character", characterId: "char-2" },
      { ...ownedSession, id: "other-repo", workingDir: "/other" },
      ownedSession,
    ])
    await expect(runTurn(base)).resolves.toMatchObject({ sessionId: "sess-owned" })
    expect(createSession).not.toHaveBeenCalled()
    expect(updateSession).not.toHaveBeenCalled()
  })

  it("creates separate history in another cwd instead of repinning an implicit session", async () => {
    listSessions.mockResolvedValue([{ ...ownedSession, workingDir: "/other" }])
    await expect(runTurn(base)).resolves.toMatchObject({ sessionId: "sess-new" })
    expect(updateSession).not.toHaveBeenCalled()
  })

  it("allows an explicit owned session to continue in a new cwd", async () => {
    getSession.mockResolvedValue({ ...ownedSession, workingDir: "/old" })
    await expect(runTurn({ ...base, sessionId: " sess-owned " })).resolves.toMatchObject({
      sessionId: "sess-owned",
    })
    expect(updateSession).toHaveBeenCalledWith("sess-owned", { workingDir: "/repo" })
    expect(listSessions).not.toHaveBeenCalled()
    expect(createSession).not.toHaveBeenCalled()
  })

  it("does not rewrite an explicit owned session already in the requested cwd", async () => {
    getSession.mockResolvedValue(ownedSession)
    await expect(runTurn({ ...base, sessionId: "sess-owned" })).resolves.toMatchObject({
      sessionId: "sess-owned",
    })
    expect(updateSession).not.toHaveBeenCalled()
  })

  it("reuses a persisted ownership stamp on subsequent calls", async () => {
    await runTurn(base)
    const created = (createSession.mock.calls[0] as unknown[])[0] as Record<string, unknown>
    listSessions.mockResolvedValue([{ ...created, id: "sess-new" }])
    await expect(runTurn(base)).resolves.toMatchObject({ sessionId: "sess-new" })
    expect(createSession).toHaveBeenCalledTimes(1)
  })

  it("isolates bot installations under the same definition", async () => {
    const botSource = { kind: "bot" as const, id: "bot-def" }
    listSessions.mockResolvedValue([
      { ...ownedSession, agentTurnOwner: { ...botSource, key: "installation-a" } },
    ])
    await expect(
      runTurn(base, { grantSource: botSource, sessionKey: "installation-b" })
    ).resolves.toMatchObject({ sessionId: "sess-new" })
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentTurnOwner: { ...botSource, key: "installation-b" },
      })
    )
    await expect(
      runTurn(base, { grantSource: botSource, sessionKey: "installation-a" })
    ).resolves.toMatchObject({ sessionId: "sess-owned" })
    expect(createSession).toHaveBeenCalledTimes(1)
    expect(updateSession).not.toHaveBeenCalled()
  })

  it("refuses a missing caller identity even when a grant claims one", async () => {
    await expect(
      runPluginAgentTurn({
        ...base,
        capabilityGrants: [{ schemaVersion: 1, source: owner }],
      })
    ).rejects.toThrow(/caller identity/)
    await expect(runTurn(base, { grantSource: { kind: "plugin" } })).rejects.toThrow(
      /caller identity/
    )
    expect(createSession).not.toHaveBeenCalled()
    expect(runAndCaptureAssistantReply).not.toHaveBeenCalled()
  })

  it("leaves the character's permission posture alone unless asked", async () => {
    await runTurn(base)
    const [, , sendOptions] = runAndCaptureAssistantReply.mock.calls[0] as unknown[]
    expect(sendOptions).not.toHaveProperty("permissionMode")
  })

  it("applies an explicit bypass only for the call that asked for it", async () => {
    await runTurn({ ...base, permissionMode: "bypassPermissions" })
    const [, , sendOptions] = runAndCaptureAssistantReply.mock.calls[0] as unknown[]
    expect(sendOptions).toMatchObject({ permissionMode: "bypassPermissions" })
  })

  it("resolves under the caller's composition instead of the desktop default", async () => {
    await runTurn({ ...base, composition: { presetId: "minimal" } })
    expect(resolveSendOptions).toHaveBeenCalledWith(
      expect.objectContaining({ compositionSelection: { presetId: "minimal" } })
    )
  })

  it("hands validated grants to the resolver, stamped with the real caller", async () => {
    await runTurn(
      {
        ...base,
        capabilityGrants: [
          {
            schemaVersion: 1,
            source: { kind: "scheduler", id: "spoofed" },
            skills: { add: ["report"] },
            tools: { deny: ["Bash"] },
          },
        ],
      },
      { grantSource: { kind: "plugin", id: "acme" } }
    )
    expect(resolveSendOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityGrants: [
          { ...HOST_GRANT, source: { kind: "plugin", id: "acme" } },
          {
            schemaVersion: 1,
            source: { kind: "plugin", id: "acme" },
            skills: { add: ["report"] },
            tools: { deny: ["Bash"] },
          },
        ],
      })
    )
  })

  it("refuses a malformed grant rather than running without it", async () => {
    await expect(
      runTurn({
        ...base,
        capabilityGrants: [{ schemaVersion: 1, source: { kind: "plugin" }, maxTurns: 0 } as never],
      })
    ).rejects.toThrow(/capabilityGrants\[0\] is invalid: maxTurns must be an integer/)
    expect(runAndCaptureAssistantReply).not.toHaveBeenCalled()
  })

  it("sends only the host's unattended grant when the caller set none", async () => {
    await runTurn(base)
    const ctx = (resolveSendOptions.mock.calls[0] as unknown[])[0] as Record<string, unknown>
    expect(ctx).not.toHaveProperty("compositionSelection")
    expect(ctx.capabilityGrants).toEqual([HOST_GRANT])
  })

  it("survives an unreadable settings row", async () => {
    getSettings.mockRejectedValue(new Error("db closed"))
    await expect(runTurn(base)).resolves.toMatchObject({ text: "done" })
    expect(resolveSendOptions).toHaveBeenCalledWith(expect.objectContaining({ appSettings: null }))
  })
})

describe("runPluginAgentTurn usage booking", () => {
  const botCaller = { grantSource: { kind: "bot" as const, id: "acme:bot" } }
  const booking = {
    operationId: "bot:run_1:agent-turn",
    sessionId: "bot:run_1",
    runId: "run_1",
    projectId: "proj_1",
  }
  const usage = {
    inputTokens: 120,
    outputTokens: 40,
    cacheReadInputTokens: 300,
    cacheCreationInputTokens: 50,
    reasoningTokens: 10,
    totalCostUsd: 0.012,
    durationMs: 900,
  }

  it("books nothing and leaves the send untouched when the caller asked for no booking", async () => {
    await runTurn(base)
    const [, , sendOptions, opts] = runAndCaptureAssistantReply.mock.calls[0] as unknown[]
    expect(sendOptions).not.toHaveProperty("turnId")
    expect(opts).not.toHaveProperty("onEvent")
    expect(recordSurfaceUsage).not.toHaveBeenCalled()
  })

  it("claims the turn and books it as a plugin row with provider, model and run", async () => {
    resolveSendOptions.mockResolvedValue({ cwd: "/repo", provider: "anthropic", model: "sonnet" })
    runAndCaptureAssistantReply.mockResolvedValue({ text: "done", messageId: "m1", usage } as never)
    await runTurn(base, { ...botCaller, usage: booking })

    const [sessionId, , sendOptions] = runAndCaptureAssistantReply.mock.calls[0] as unknown[]
    const turnId = (sendOptions as { turnId?: string }).turnId
    expect(turnId).toEqual(expect.any(String))
    // The desktop chat runtime sees the same stream and must leave this turn alone.
    expect(isTurnUsageClaimed(sessionId as string, turnId)).toBe(true)
    expect(recordSurfaceUsage).toHaveBeenCalledTimes(1)
    expect(recordSurfaceUsage).toHaveBeenCalledWith({
      surface: "plugin",
      operationId: "bot:run_1:agent-turn",
      sessionId: "bot:run_1",
      usage: expect.objectContaining({
        inputTokens: 120,
        outputTokens: 40,
        cacheReadTokens: 300,
        cacheCreationTokens: 50,
        reasoningTokens: 10,
        costUsd: 0.012,
        durationMs: 900,
        providerId: "anthropic",
        model: "sonnet",
        runId: "run_1",
        projectId: "proj_1",
        turnId,
      }),
    })
  })

  it("keeps a turn id the resolver already minted", async () => {
    resolveSendOptions.mockResolvedValue({ cwd: "/repo", turnId: "turn-7" })
    runAndCaptureAssistantReply.mockResolvedValue({ text: "done", messageId: "m1", usage } as never)
    await runTurn(base, { ...botCaller, usage: booking })
    expect(isTurnUsageClaimed("sess-new", "turn-7")).toBe(true)
  })

  it("falls back to the streamed usage when the result carries none", async () => {
    runAndCaptureAssistantReply.mockImplementation(async (...args: unknown[]) => {
      const opts = args[3] as { onEvent: (event: unknown) => void }
      opts.onEvent({ type: "usage", usage: { inputTokens: 1 }, partial: true })
      opts.onEvent({ type: "usage", usage: { inputTokens: 7, outputTokens: 3 } })
      return { text: "done", messageId: "m1" }
    })
    await runTurn(base, { ...botCaller, usage: booking })
    expect(recordSurfaceUsage.mock.calls[0][0]).toMatchObject({
      usage: { inputTokens: 7, outputTokens: 3 },
    })
  })

  it("still books what a failed turn spent, then reports the failure", async () => {
    runAndCaptureAssistantReply.mockImplementation(async (...args: unknown[]) => {
      const opts = args[3] as { onEvent: (event: unknown) => void }
      opts.onEvent({ type: "usage", usage: { inputTokens: 50, outputTokens: 5 } })
      throw new Error("sidecar exited")
    })
    await expect(runTurn(base, { ...botCaller, usage: booking })).rejects.toThrow("sidecar exited")
    expect(recordSurfaceUsage.mock.calls[0][0]).toMatchObject({
      usage: { inputTokens: 50, outputTokens: 5 },
    })
  })

  it("books an external-agent turn without a provider bucket or a guessed price", async () => {
    resolveSendOptions.mockResolvedValue({
      cwd: "/repo",
      provider: "cognia:external-agent:codex",
      model: "gpt-5",
    })
    runAndCaptureAssistantReply.mockResolvedValue({
      text: "done",
      messageId: "m1",
      usage: { inputTokens: 10, outputTokens: 2 },
    } as never)
    await runTurn(base, { ...botCaller, usage: booking })
    const written = (recordSurfaceUsage.mock.calls[0][0] as { usage: Record<string, unknown> })
      .usage
    expect(written).not.toHaveProperty("providerId")
    expect(written).toMatchObject({
      model: "gpt-5",
      costSource: "unknown",
      costKnown: false,
      usageBasis: "provider-reported",
    })
  })

  it("never fails the turn when the booking cannot be written", async () => {
    runAndCaptureAssistantReply.mockResolvedValue({ text: "done", messageId: "m1", usage } as never)
    recordSurfaceUsage.mockRejectedValue(new Error("db closed"))
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await expect(runTurn(base, { ...botCaller, usage: booking })).resolves.toMatchObject({
        status: "completed",
      })
    } finally {
      warn.mockRestore()
    }
  })

  it("books nothing when the turn reported no usage at all", async () => {
    await runTurn(base, { ...botCaller, usage: booking })
    expect(recordSurfaceUsage).not.toHaveBeenCalled()
  })
})
