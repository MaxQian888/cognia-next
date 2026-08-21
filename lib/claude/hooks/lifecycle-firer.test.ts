import {
  defaultLifecycleFirer,
  noopLifecycleFirer,
  firePreCallHooks,
  firePostCallHooks,
  type AgentHookContext,
  type LifecycleHookFirer,
} from "./lifecycle-firer"

jest.mock("@/lib/ai/agent/external/agent-hooks", () => ({
  fireAgentHook: jest.fn(async () => ({
    block: null,
    additionalContext: "from-bridge",
    warnings: [],
  })),
}))

import { fireAgentHook } from "@/lib/ai/agent/external/agent-hooks"

const ctx: AgentHookContext = {
  agentId: "goal-judge",
  agentKind: "goal-judge",
  sessionId: "s1",
  cwd: "/repo",
}

afterEach(() => jest.clearAllMocks())

describe("defaultLifecycleFirer", () => {
  it("delegates to fireAgentHook with the same args", async () => {
    const out = await defaultLifecycleFirer("SessionStart", ctx, { payload: { a: 1 } })
    expect(fireAgentHook).toHaveBeenCalledWith("SessionStart", ctx, { payload: { a: 1 } })
    expect(out).toEqual({ block: null, additionalContext: "from-bridge", warnings: [] })
  })
})

describe("noopLifecycleFirer", () => {
  it("always resolves null without side effects", async () => {
    expect(await noopLifecycleFirer("UserPromptSubmit", ctx)).toBeNull()
    expect(fireAgentHook).not.toHaveBeenCalled()
  })
})

describe("firePreCallHooks", () => {
  it("fires SessionStart then UserPromptSubmit and merges additionalContext", async () => {
    const calls: string[] = []
    const firer: LifecycleHookFirer = async (event) => {
      calls.push(event)
      if (event === "SessionStart") return { block: null, additionalContext: "ctxA", warnings: [] }
      if (event === "UserPromptSubmit")
        return { block: null, additionalContext: "ctxB", warnings: [] }
      return null
    }
    const res = await firePreCallHooks(firer, ctx, "grade this")
    expect(calls).toEqual(["SessionStart", "UserPromptSubmit"])
    expect(res).toEqual({ block: null, additionalContext: "ctxA\n\nctxB" })
  })

  it("threads the prompt + extra payload into UserPromptSubmit", async () => {
    const firer = jest.fn<ReturnType<LifecycleHookFirer>, Parameters<LifecycleHookFirer>>(
      async () => null
    )
    await firePreCallHooks(firer, ctx, "P", { goalId: "g1" })
    expect(firer).toHaveBeenCalledWith("UserPromptSubmit", ctx, {
      payload: { prompt: "P", goalId: "g1" },
    })
  })

  it("returns the block reason when UserPromptSubmit denies", async () => {
    const firer: LifecycleHookFirer = async (event) =>
      event === "UserPromptSubmit"
        ? { block: "over budget", additionalContext: null, warnings: [] }
        : null
    const res = await firePreCallHooks(firer, ctx, "P")
    expect(res.block).toBe("over budget")
  })

  it("never throws when the firer rejects", async () => {
    const firer: LifecycleHookFirer = async () => {
      throw new Error("bridge down")
    }
    await expect(firePreCallHooks(firer, ctx, "P")).resolves.toEqual({
      block: null,
      additionalContext: null,
    })
  })
})

describe("firePostCallHooks", () => {
  it("fires Stop then SessionEnd on success", async () => {
    const calls: string[] = []
    const firer: LifecycleHookFirer = async (event) => {
      calls.push(event)
      return null
    }
    await firePostCallHooks(firer, ctx, { success: true })
    expect(calls).toEqual(["Stop", "SessionEnd"])
  })

  it("fires StopFailure then SessionEnd on failure", async () => {
    const calls: string[] = []
    const firer: LifecycleHookFirer = async (event) => {
      calls.push(event)
      return null
    }
    await firePostCallHooks(firer, ctx, { success: false, error: "boom" })
    expect(calls).toEqual(["StopFailure", "SessionEnd"])
  })

  it("never throws when the firer rejects", async () => {
    const firer: LifecycleHookFirer = async () => {
      throw new Error("down")
    }
    await expect(firePostCallHooks(firer, ctx, { success: true })).resolves.toBeUndefined()
  })
})
