import "fake-indexeddb/auto"
import type { SDKMessage } from "@/lib/claude/types"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { __resetPlanRuntimeForTesting, getPlanRuntime } from "./runtime"
import {
  captureExitPlanMode,
  findExitPlanModeInput,
  parsePlanText,
  planInputFromExitPlanMode,
} from "./exit-plan-capture"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  __resetPlanRuntimeForTesting()
})

describe("parsePlanText", () => {
  it("splits dash and asterisk bullets", () => {
    expect(parsePlanText("- first\n- second")).toEqual(["first", "second"])
    expect(parsePlanText("* a\n* b")).toEqual(["a", "b"])
  })

  it("splits ordered 1. and 1) items", () => {
    expect(parsePlanText("1. alpha\n2) beta")).toEqual(["alpha", "beta"])
  })

  it("strips bold emphasis and skips blanks", () => {
    expect(parsePlanText("- **Bold step**\n\n- plain")).toEqual(["Bold step", "plain"])
  })

  it("falls back to the first non-empty line (stripped of heading) when no markers", () => {
    expect(parsePlanText("## Do the thing\nmore detail")).toEqual(["Do the thing"])
  })

  it("returns [] for empty text", () => {
    expect(parsePlanText("   \n  ")).toEqual([])
  })
})

describe("planInputFromExitPlanMode", () => {
  const ctx = { sessionId: "ses_a", characterId: "c1" }

  it("builds a linear agent_turn plan from a markdown plan string", () => {
    const input = planInputFromExitPlanMode({ plan: "- step one\n- step two\n- step three" }, ctx)
    expect(input).not.toBeNull()
    expect(input!.source).toBe("exit_plan_mode")
    expect(input!.characterId).toBe("c1")
    expect(input!.steps).toHaveLength(3)
    expect(input!.steps.every((s) => s.kind === "agent_turn")).toBe(true)
    // Linear chaining: each step depends on the previous index.
    expect(input!.steps[0].dependsOn).toBeUndefined()
    expect(input!.steps[1].dependsOn).toEqual([0])
    expect(input!.steps[2].dependsOn).toEqual([1])
  })

  it("accepts a pre-structured steps array ({ content })", () => {
    const input = planInputFromExitPlanMode(
      { steps: [{ content: "a", status: "pending" }, { title: "b" }] },
      ctx
    )
    expect(input!.steps.map((s) => s.title)).toEqual(["a", "b"])
  })

  it("accepts a plan array of strings", () => {
    const input = planInputFromExitPlanMode({ plan: ["x", "y"] }, ctx)
    expect(input!.steps.map((s) => s.title)).toEqual(["x", "y"])
  })

  it("derives a title from the first step, override wins", () => {
    expect(planInputFromExitPlanMode({ plan: "- only" }, ctx)!.title).toBe("only")
    expect(planInputFromExitPlanMode({ plan: "- only" }, { ...ctx, title: "Custom" })!.title).toBe(
      "Custom"
    )
  })

  it("returns null for non-object / empty / step-less input", () => {
    expect(planInputFromExitPlanMode(null, ctx)).toBeNull()
    expect(planInputFromExitPlanMode("nope", ctx)).toBeNull()
    expect(planInputFromExitPlanMode({ plan: "" }, ctx)).toBeNull()
    expect(planInputFromExitPlanMode({ other: 1 }, ctx)).toBeNull()
  })
})

function assistantEvt(toolName: string, input: unknown): SDKMessage {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", name: toolName, input }] },
  } as unknown as SDKMessage
}

describe("findExitPlanModeInput", () => {
  it("returns the ExitPlanMode tool input", () => {
    expect(findExitPlanModeInput(assistantEvt("ExitPlanMode", { plan: "- x" }))).toEqual({
      plan: "- x",
    })
  })

  it("returns null for other tools / non-assistant events", () => {
    expect(findExitPlanModeInput(assistantEvt("TodoWrite", {}))).toBeNull()
    expect(findExitPlanModeInput({ type: "result" } as unknown as SDKMessage)).toBeNull()
  })
})

describe("captureExitPlanMode", () => {
  it("creates a draft plan from an ExitPlanMode event", async () => {
    const plan = await captureExitPlanMode(
      assistantEvt("ExitPlanMode", { plan: "- build\n- test\n- ship" }),
      "ses_a",
      "c1"
    )
    expect(plan).not.toBeNull()
    expect(plan!.status).toBe("awaiting_approval")
    expect(plan!.source).toBe("exit_plan_mode")
    expect(plan!.totalSteps).toBe(3)
    // Persisted + retrievable as the session's open plan.
    const open = await getPlanRuntime().getOpenPlanForSession("ses_a")
    expect(open?.id).toBe(plan!.id)
  })

  it("returns null when there is no ExitPlanMode block", async () => {
    expect(await captureExitPlanMode(assistantEvt("TodoWrite", {}), "ses_a")).toBeNull()
  })

  it("returns null when the plan has no extractable steps", async () => {
    expect(
      await captureExitPlanMode(assistantEvt("ExitPlanMode", { plan: "" }), "ses_a")
    ).toBeNull()
  })
})
