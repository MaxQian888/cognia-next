import {
  agentDispatch,
  teamRun,
  teamList,
  pluginToolInvoke,
  runOrchestrationExec,
} from "./orchestration"

const isTauriMock = jest.fn<boolean, []>(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

const dispatchSubagentMock = jest.fn()
const runTeamMock = jest.fn()
jest.mock("@/lib/plugin/agent-sdk/dispatch", () => ({
  dispatchSubagent: (...a: unknown[]) => dispatchSubagentMock(...a),
  runTeam: (...a: unknown[]) => runTeamMock(...a),
}))

const executeAgentMock = jest.fn()
jest.mock("@/lib/ai/agent/agent-executor", () => ({
  executeAgent: (...a: unknown[]) => executeAgentMock(...a),
}))

const invokePluginToolMock = jest.fn()
jest.mock("@/lib/plugin/core/invoke-plugin-tool", () => ({
  invokePluginTool: (...a: unknown[]) => invokePluginToolMock(...a),
}))

const redactTextMock = jest.fn((text: string) => ({ redacted: text, map: {} }))
jest.mock("@/lib/twin/ingest/redact", () => ({
  redactText: (...a: unknown[]) => redactTextMock(...(a as [string])),
}))

const updateTeamMock = jest.fn()
let storeTeams: Record<string, unknown> = {}
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: {
    getState: () => ({ teams: storeTeams, updateTeam: updateTeamMock }),
  },
}))

beforeEach(() => {
  isTauriMock.mockReturnValue(true)
  dispatchSubagentMock.mockReset()
  runTeamMock.mockReset()
  executeAgentMock.mockReset()
  invokePluginToolMock.mockReset()
  redactTextMock.mockReset().mockImplementation((text: string) => ({ redacted: text, map: {} }))
  updateTeamMock.mockReset()
  storeTeams = {}
})

describe("agentDispatch", () => {
  it("returns the structured fallback off the renderer (sidecar)", async () => {
    isTauriMock.mockReturnValue(false)
    const out = await agentDispatch({ subagentId: "x", prompt: "hi" })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/desktop renderer/)
  })

  it("rejects an empty prompt", async () => {
    expect((await agentDispatch({ subagentId: "x", prompt: "  " })).ok).toBe(false)
  })

  it("rejects when neither subagentId nor characterId is given", async () => {
    const out = await agentDispatch({ prompt: "hi" })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/subagentId or characterId/)
  })

  it("dispatches a subagent and returns its text", async () => {
    dispatchSubagentMock.mockResolvedValue({
      text: "done",
      channel: "sidecar",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    })
    const out = await agentDispatch({ subagentId: "reviewer", prompt: "review", cwd: "/r" })
    expect(dispatchSubagentMock).toHaveBeenCalledWith(
      "reviewer",
      "review",
      expect.objectContaining({ toolsEnabled: true, cwd: "/r" })
    )
    expect(out).toMatchObject({ ok: true, text: "done", channel: "sidecar" })
  })

  it("runs a character through executeAgent", async () => {
    executeAgentMock.mockResolvedValue({ text: "char out", channel: "sidecar" })
    const out = await agentDispatch({ characterId: "c1", prompt: "go" })
    expect(executeAgentMock).toHaveBeenCalledWith(
      "go",
      expect.objectContaining({ characterId: "c1", toolsEnabled: true })
    )
    expect(out.ok).toBe(true)
    expect(out.text).toBe("char out")
  })

  it("PII-redacts the returned text and flags it", async () => {
    dispatchSubagentMock.mockResolvedValue({ text: "mail a@b.com", channel: "text" })
    redactTextMock.mockReturnValue({
      redacted: "mail [[EMAIL_1]]",
      map: { "[[EMAIL_1]]": { placeholder: "[[EMAIL_1]]", original: "a@b.com", kind: "email" } },
    })
    const out = await agentDispatch({ subagentId: "x", prompt: "p" })
    expect(out.text).toBe("mail [[EMAIL_1]]")
    expect(out.redacted).toBe(true)
  })

  it("collapses a thrown error into ok:false", async () => {
    dispatchSubagentMock.mockRejectedValue(new Error("boom"))
    const out = await agentDispatch({ subagentId: "x", prompt: "p" })
    expect(out).toEqual({ ok: false, error: "boom" })
  })
})

describe("teamRun", () => {
  it("returns the structured fallback off the renderer", async () => {
    isTauriMock.mockReturnValue(false)
    expect((await teamRun({ teamId: "t1" })).ok).toBe(false)
  })

  it("requires a teamId", async () => {
    expect((await teamRun({ teamId: "" })).ok).toBe(false)
  })

  it("starts the team and returns its status", async () => {
    runTeamMock.mockResolvedValue({ teamId: "t1", status: "completed" })
    const out = await teamRun({ teamId: "t1", ultracode: true })
    expect(runTeamMock).toHaveBeenCalledWith("t1", { origin: "external", ultracode: true })
    expect(out).toEqual({ ok: true, teamId: "t1", status: "completed" })
  })

  it("collapses a thrown error", async () => {
    runTeamMock.mockRejectedValue(new Error("not found"))
    expect(await teamRun({ teamId: "t1" })).toEqual({ ok: false, error: "not found" })
  })

  it("stamps the external-pickup claim before dispatch (idempotently)", async () => {
    runTeamMock.mockResolvedValue({ teamId: "t1", status: "running" })
    storeTeams = {
      t1: { id: "t1", externalPickup: { requestedAt: new Date(0) } },
    }
    await teamRun({ teamId: "t1" })
    expect(updateTeamMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        externalPickup: expect.objectContaining({
          claimedBy: "external-bridge",
          claimedAt: expect.any(Date),
        }),
      })
    )

    // Already claimed → never overwritten.
    updateTeamMock.mockClear()
    storeTeams = {
      t1: {
        id: "t1",
        externalPickup: { requestedAt: new Date(0), claimedBy: "other", claimedAt: new Date(1) },
      },
    }
    await teamRun({ teamId: "t1" })
    expect(updateTeamMock).not.toHaveBeenCalled()
  })

  it("stamps a structured claimant + claim lease (ADR 0061 P4)", async () => {
    runTeamMock.mockResolvedValue({ teamId: "t1", status: "running" })
    storeTeams = { t1: { id: "t1", status: "idle", externalPickup: { requestedAt: new Date(0) } } }
    await teamRun({
      teamId: "t1",
      claimant: { kind: "device", id: "dev-9", label: "Max's phone" },
    })
    expect(updateTeamMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        externalPickup: expect.objectContaining({
          claimedBy: "dev-9",
          claimant: { kind: "device", id: "dev-9", label: "Max's phone" },
          claimLeaseExpiresAt: expect.any(Date),
        }),
      })
    )
  })

  it("re-claims an expired claim lease on a still-idle team", async () => {
    runTeamMock.mockResolvedValue({ teamId: "t1", status: "running" })
    storeTeams = {
      t1: {
        id: "t1",
        status: "idle",
        externalPickup: {
          requestedAt: new Date(0),
          claimedBy: "dead-claimant",
          claimedAt: new Date(1),
          claimLeaseExpiresAt: new Date(Date.now() - 60_000),
        },
      },
    }
    await teamRun({ teamId: "t1" })
    expect(updateTeamMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        externalPickup: expect.objectContaining({ claimedBy: "external-bridge" }),
      })
    )
  })

  it("rejects a claimant when the pickup is addressed to someone else", async () => {
    storeTeams = {
      t1: {
        id: "t1",
        status: "idle",
        externalPickup: { requestedAt: new Date(0), targetId: "dev-only" },
      },
    }
    const out = await teamRun({ teamId: "t1" })
    expect(out.ok).toBe(false)
    expect(out.error).toContain("dev-only")
    expect(runTeamMock).not.toHaveBeenCalled()
  })
})

describe("teamList", () => {
  it("returns the structured fallback off the renderer", async () => {
    isTauriMock.mockReturnValue(false)
    expect((await teamList()).ok).toBe(false)
  })

  it("projects agent-team store rows with redacted name/objective", async () => {
    redactTextMock.mockImplementation((text: string) => ({
      redacted: text.replace("secret", "<NAME_001>"),
      map: {},
    }))
    storeTeams = {
      t1: { id: "t1", name: "Team secret", status: "idle", task: "help secret org" },
    }
    const out = await teamList()
    expect(out.ok).toBe(true)
    expect(out.teams).toEqual([
      {
        id: "t1",
        name: "Team <NAME_001>",
        status: "idle",
        objective: "help <NAME_001> org",
        awaitingExternalPickup: false,
      },
    ])
  })

  it("filters to unclaimed external-pickup teams and serializes requestedAt", async () => {
    storeTeams = {
      plain: { id: "plain", name: "P", status: "idle", task: "x" },
      waiting: {
        id: "waiting",
        name: "W",
        status: "idle",
        task: "y",
        externalPickup: { requestedAt: new Date("2026-07-02T00:00:00Z") },
      },
      claimed: {
        id: "claimed",
        name: "C",
        status: "idle",
        task: "z",
        externalPickup: {
          requestedAt: new Date("2026-07-01T00:00:00Z"),
          claimedBy: "external-bridge",
          claimedAt: new Date("2026-07-01T01:00:00Z"),
        },
      },
    }
    const out = await teamList({ awaitingExternalOnly: true })
    expect(out.teams).toHaveLength(1)
    expect(out.teams?.[0]).toMatchObject({
      id: "waiting",
      awaitingExternalPickup: true,
      requestedAt: "2026-07-02T00:00:00.000Z",
    })
  })

  it("re-advertises an expired claim on a still-idle team and exposes claimant (ADR 0061 P4)", async () => {
    storeTeams = {
      stale: {
        id: "stale",
        name: "S",
        status: "idle",
        task: "x",
        externalPickup: {
          requestedAt: new Date("2026-07-02T00:00:00Z"),
          claimedBy: "dead-claimant",
          claimant: { kind: "external-agent", id: "dead-claimant" },
          claimedAt: new Date("2026-07-02T01:00:00Z"),
          claimLeaseExpiresAt: new Date(Date.now() - 1_000),
        },
      },
      dispatched: {
        id: "dispatched",
        name: "D",
        status: "executing",
        task: "y",
        externalPickup: {
          requestedAt: new Date("2026-07-02T00:00:00Z"),
          claimedBy: "live-claimant",
          claimedAt: new Date("2026-07-02T01:00:00Z"),
          claimLeaseExpiresAt: new Date(Date.now() - 1_000),
        },
      },
    }
    const out = await teamList({ awaitingExternalOnly: true })
    // Expired + idle → free again; expired + executing → the claim did its
    // job (the team is running), never re-advertised.
    expect(out.teams?.map((t) => t.id)).toEqual(["stale"])
    expect(out.teams?.[0]).toMatchObject({
      claimant: { kind: "external-agent", id: "dead-claimant" },
    })
  })
})

describe("pluginToolInvoke", () => {
  it("returns the structured fallback off the renderer", async () => {
    isTauriMock.mockReturnValue(false)
    expect((await pluginToolInvoke({ pluginId: "p", toolName: "t" })).ok).toBe(false)
  })

  it("requires pluginId and toolName", async () => {
    expect((await pluginToolInvoke({ pluginId: "", toolName: "t" })).ok).toBe(false)
  })

  it("invokes the plugin tool and returns its result", async () => {
    invokePluginToolMock.mockResolvedValue({ rows: 3 })
    const out = await pluginToolInvoke({ pluginId: "p", toolName: "query", args: { q: "x" } })
    expect(invokePluginToolMock).toHaveBeenCalledWith("p", "query", { q: "x" }, {})
    expect(out).toEqual({ ok: true, result: { rows: 3 } })
  })

  it("surfaces the typed error code on failure", async () => {
    const err = Object.assign(new Error("denied"), { code: "permission-denied" })
    invokePluginToolMock.mockRejectedValue(err)
    const out = await pluginToolInvoke({ pluginId: "p", toolName: "t" })
    expect(out).toEqual({ ok: false, error: "denied", code: "permission-denied" })
  })
})

describe("runOrchestrationExec (renderer dispatch entry for the sidecar path)", () => {
  it("routes agent_dispatch through the core and STILL applies the PII gate", async () => {
    // This is the function the renderer dispatch provider calls for a sidecar-
    // proxied request, so redaction firing here proves it fires on the sidecar
    // path too (the redacted text is what crosses back over the socket).
    dispatchSubagentMock.mockResolvedValue({ text: "mail a@b.com", channel: "text" })
    redactTextMock.mockReturnValue({
      redacted: "mail [[EMAIL_1]]",
      map: { "[[EMAIL_1]]": { placeholder: "[[EMAIL_1]]", original: "a@b.com", kind: "email" } },
    })
    const out = (await runOrchestrationExec("agent_dispatch", {
      subagentId: "x",
      prompt: "p",
    })) as { ok: boolean; text?: string; redacted?: boolean }
    expect(out.ok).toBe(true)
    expect(out.text).toBe("mail [[EMAIL_1]]")
    expect(out.redacted).toBe(true)
  })

  it("routes team_run and plugin_tool_invoke through their cores", async () => {
    runTeamMock.mockResolvedValue({ teamId: "t1", status: "completed" })
    invokePluginToolMock.mockResolvedValue({ rows: 1 })
    expect(await runOrchestrationExec("team_run", { teamId: "t1" })).toMatchObject({
      ok: true,
      teamId: "t1",
    })
    expect(
      await runOrchestrationExec("plugin_tool_invoke", { pluginId: "p", toolName: "q" })
    ).toMatchObject({ ok: true, result: { rows: 1 } })
  })

  it("routes team_list through its core", async () => {
    storeTeams = { t9: { id: "t9", name: "N", status: "idle", task: "obj" } }
    const out = (await runOrchestrationExec("team_list", {})) as {
      ok: boolean
      teams?: Array<{ id: string }>
    }
    expect(out.ok).toBe(true)
    expect(out.teams?.[0]?.id).toBe("t9")
  })

  it("returns a structured error for an unknown command", async () => {
    const out = (await runOrchestrationExec("bogus", {})) as { ok: boolean; error?: string }
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/unknown orchestration command/)
  })
})
