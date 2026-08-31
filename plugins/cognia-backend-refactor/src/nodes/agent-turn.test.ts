/**
 * The node's own contract: role → character resolution, param validation, the
 * desktop gate, the permission posture it asks for, and the output shape.
 *
 * The session-reuse ladder and the settings/send-options plumbing moved to
 * `runPluginAgentTurn` (`lib/plugin/api/agent-turn.ts`) and are pinned by that
 * module's own suite. Doubling the SDK subpath here rather than the five host
 * modules behind it is the point: this plugin sees only the published surface.
 */

import type { StepExecutionContext } from "@cognia/plugin-sdk"
import { createAgentTurnNode, executeAgentTurn as executeAgentTurnWithRuntime } from "./agent-turn"
import { roleCharacterId } from "../characters/pack"

const mRun = jest.fn()
const runtime = { tauri: true, runCharacterTurn: mRun }
const AGENT_TURN_NODE = createAgentTurnNode(runtime)

function executeAgentTurn(ctx: StepExecutionContext) {
  return executeAgentTurnWithRuntime(ctx, runtime)
}

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
  runtime.tauri = true
  mRun.mockResolvedValue({ sessionId: "sess-new", text: "done", messageId: "m1" })
})

describe("AGENT_TURN_NODE shape", () => {
  it("is a desktop-only, non-retryable plugin node requiring prompt + cwd", () => {
    expect(AGENT_TURN_NODE.kind).toBe("agent.turn")
    expect(AGENT_TURN_NODE.category).toBe("plugin")
    expect(AGENT_TURN_NODE.desktopOnly).toBe(true)
    expect(AGENT_TURN_NODE.retryable).toBe(false)
    expect(AGENT_TURN_NODE.paramsSchema).toMatchObject({
      required: ["prompt", "cwd"],
      additionalProperties: false,
    })
  })
})

describe("executeAgentTurn", () => {
  it("rejects a missing prompt", async () => {
    await expect(executeAgentTurn(makeCtx({ cwd: "/repo" }))).rejects.toThrow(/prompt/)
    expect(mRun).not.toHaveBeenCalled()
  })

  it("rejects a missing cwd", async () => {
    await expect(executeAgentTurn(makeCtx({ prompt: "go" }))).rejects.toThrow(/cwd/)
    expect(mRun).not.toHaveBeenCalled()
  })

  it("rejects when neither characterId nor a known role is given", async () => {
    await expect(
      executeAgentTurn(makeCtx({ prompt: "go", cwd: "/repo", role: "not-a-role" }))
    ).rejects.toThrow(/role/)
    expect(mRun).not.toHaveBeenCalled()
  })

  it("rejects outside the desktop runtime, before starting a turn", async () => {
    runtime.tauri = false
    await expect(
      executeAgentTurn(makeCtx({ prompt: "go", cwd: "/repo", role: "refactorer" }))
    ).rejects.toThrow(/desktop runtime/)
    expect(mRun).not.toHaveBeenCalled()
  })

  it("resolves role → character and runs a cwd-scoped headless turn", async () => {
    const res = await executeAgentTurn(
      makeCtx({ prompt: "Refactor the auth module", cwd: "/repo", role: "refactorer" })
    )
    expect(mRun).toHaveBeenCalledWith(
      expect.objectContaining({
        characterId: roleCharacterId("refactorer"),
        prompt: "Refactor the auth module",
        cwd: "/repo",
        timeoutMs: 600_000,
      })
    )
    expect(res.output).toMatchObject({
      text: "done",
      messageId: "m1",
      characterId: roleCharacterId("refactorer"),
      role: "refactorer",
      sessionId: "sess-new",
    })
  })

  it("honours an explicit characterId over role", async () => {
    await executeAgentTurn(
      makeCtx({ prompt: "go", cwd: "/repo", role: "refactorer", characterId: "char_custom" })
    )
    expect(mRun).toHaveBeenCalledWith(expect.objectContaining({ characterId: "char_custom" }))
  })

  it("passes an explicit sessionId through, and omits it when absent", async () => {
    await executeAgentTurn(
      makeCtx({ prompt: "go", cwd: "/repo", role: "refactorer", sessionId: "sess-pinned" })
    )
    expect(mRun).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "sess-pinned" }))

    mRun.mockClear()
    await executeAgentTurn(makeCtx({ prompt: "go", cwd: "/repo", role: "refactorer" }))
    expect(mRun.mock.calls[0][0]).not.toHaveProperty("sessionId")
  })

  it("passes a custom timeoutSec through as milliseconds", async () => {
    await executeAgentTurn(
      makeCtx({ prompt: "go", cwd: "/repo", role: "refactorer", timeoutSec: 30 })
    )
    expect(mRun).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 30_000 }))
  })

  it("asks for bypassPermissions at the call site, not on the character", async () => {
    // The headless runner has no UI to answer a permission prompt, so the
    // bypass must be applied — but ONLY here. Pinning it at the call site is
    // what keeps it off the character definitions, where it would also cover
    // ordinary interactive chat (see characters/pack.test.ts).
    await executeAgentTurn(makeCtx({ prompt: "go", cwd: "/repo", role: "refactorer" }))
    expect(mRun).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "bypassPermissions" })
    )
  })
})

describe("executeAgentTurn fallbacks", () => {
  it("treats a missing params object as empty (rejects on prompt)", async () => {
    await expect(
      executeAgentTurn({ runId: "r", stepId: "s", signal: new AbortController().signal } as never)
    ).rejects.toThrow(/prompt/)
  })

  it("emits role=null in the output when only a characterId is given", async () => {
    const res = await executeAgentTurn(
      makeCtx({ prompt: "go", cwd: "/repo", characterId: "char_custom" })
    )
    expect((res.output as { role: string | null }).role).toBeNull()
  })
})
