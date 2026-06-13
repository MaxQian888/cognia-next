/**
 * @jest-environment node
 */
import { agentsDispatch, agentsList } from "./agents-controller"
import type { AgentSummary } from "../../agent/discover-agents"
import type { TuiAction } from "../state/types"

function recorder() {
  const actions: TuiAction[] = []
  return { dispatch: (a: TuiAction) => actions.push(a), actions }
}

const agent = (id: string, description = ""): AgentSummary => ({
  id,
  name: id,
  description,
  def: { id, name: id, description, prompt: "p" },
})

describe("agentsList", () => {
  it("notices the discovered subagents with a usage hint", async () => {
    const { dispatch, actions } = recorder()
    await agentsList({
      dispatch,
      cwd: "/w",
      list: async () => [agent("reviewer", "reviews code"), agent("planner")],
    })
    const msg = (actions[0] as { message: string }).message
    expect(msg).toContain("reviewer")
    expect(msg).toContain("reviews code")
    expect(msg).toContain("/agents run")
  })

  it("notices when none are found", async () => {
    const { dispatch, actions } = recorder()
    await agentsList({ dispatch, cwd: "/w", list: async () => [] })
    expect((actions[0] as { message: string }).message).toContain("No subagents")
  })
})

describe("agentsDispatch", () => {
  it("dispatches the named subagent and surfaces its reply", async () => {
    const { dispatch, actions } = recorder()
    let received: { id: string; prompt: string } | null = null
    await agentsDispatch("reviewer check the diff", {
      dispatch,
      cwd: "/w",
      list: async () => [agent("reviewer")],
      dispatchAgent: async (def, prompt) => {
        received = { id: def.id, prompt }
        return { text: "looks good" }
      },
    })
    expect(received).toEqual({ id: "reviewer", prompt: "check the diff" })
    expect(actions[0]).toMatchObject({ type: "ACTIVITY_START", kind: "agent" })
    expect((actions.at(-1) as { summary: string }).summary).toContain("looks good")
  })

  it("enriches the summary with token spend and a non-default finish reason", async () => {
    const { dispatch, actions } = recorder()
    await agentsDispatch("reviewer go", {
      dispatch,
      cwd: "/w",
      list: async () => [agent("reviewer")],
      dispatchAgent: async () => ({
        text: "done",
        usage: { totalTokens: 1234 },
        finishReason: "max_tokens",
      }),
    })
    const summary = (actions.at(-1) as { summary: string }).summary
    expect(summary).toContain("1234 tok")
    expect(summary).toContain("max_tokens")
    expect(summary).toContain("done")
  })

  it("ends with an error when a nesting guard refuses the dispatch", async () => {
    const { dispatch, actions } = recorder()
    await agentsDispatch("reviewer go", {
      dispatch,
      cwd: "/w",
      list: async () => [agent("reviewer")],
      dispatchAgent: async () => ({
        text: "",
        rejection: { reason: "max-depth", message: "depth cap reached" },
      }),
    })
    expect(actions.at(-1)).toMatchObject({ type: "ACTIVITY_END", status: "error" })
    expect((actions.at(-1) as { summary: string }).summary).toContain("max-depth")
    expect((actions.at(-1) as { summary: string }).summary).toContain("depth cap reached")
  })

  it("notices usage when no prompt is supplied", async () => {
    const { dispatch, actions } = recorder()
    await agentsDispatch("reviewer", {
      dispatch,
      cwd: "/w",
      list: async () => [agent("reviewer")],
    })
    expect((actions[0] as { message: string }).message).toContain("/agents run")
  })

  it("notices an unknown subagent id", async () => {
    const { dispatch, actions } = recorder()
    await agentsDispatch("ghost do something", {
      dispatch,
      cwd: "/w",
      list: async () => [agent("reviewer")],
    })
    expect((actions[0] as { message: string }).message).toContain("ghost")
  })

  it("ends with an error when dispatch throws", async () => {
    const { dispatch, actions } = recorder()
    await agentsDispatch("reviewer go", {
      dispatch,
      cwd: "/w",
      list: async () => [agent("reviewer")],
      dispatchAgent: async () => {
        throw new Error("nope")
      },
    })
    expect(actions.at(-1)).toMatchObject({ type: "ACTIVITY_END", status: "error" })
  })
})
