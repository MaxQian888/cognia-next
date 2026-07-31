/**
 * @jest-environment node
 */
import { councilRun, type CouncilDeps } from "./council-controller"
import type { TuiAction } from "../state/types"
import type { CouncilResult } from "@/lib/ai/council/run-council"

jest.mock("@/lib/db/settings", () => ({
  getSettings: jest.fn(async () => ({
    modelMappings: [
      { alias: "fast", enabled: true },
      { alias: "off", enabled: false },
      { alias: "smart" },
    ],
  })),
}))

function harness(over: Partial<CouncilDeps> = {}) {
  const actions: TuiAction[] = []
  const runPrompt = jest.fn(async () => ({ completion: "ok" }))
  const deps: CouncilDeps = {
    dispatch: (a: TuiAction) => actions.push(a),
    signal: new AbortController().signal,
    ensureDb: async () => undefined,
    loadAliases: async () => ["fast", "smart", "cheap"],
    runPrompt,
    ...over,
  }
  return { actions, deps, runPrompt }
}

const RESULT: CouncilResult = {
  markdown: "## Council Response\nfinal",
  confidence: "majority",
  councillors: [{ name: "fast", model: "m", status: "completed", text: "a" }],
  respondedCount: 1,
  totalCount: 1,
}

describe("councilRun", () => {
  it("prints usage when the question is empty", async () => {
    const h = harness()
    await councilRun("   ", h.deps)
    expect(h.actions).toEqual([
      { type: "NOTICE", message: expect.stringContaining("Usage: /council") },
    ])
    expect(h.runPrompt).not.toHaveBeenCalled()
  })

  it("notices the roster error when no aliases are configured", async () => {
    const h = harness({ loadAliases: async () => [] })
    await councilRun("why is the sky blue", h.deps)
    expect(h.actions).toHaveLength(1)
    expect(h.actions[0]).toMatchObject({ type: "NOTICE" })
    expect((h.actions[0] as { message: string }).message).toContain("No models to convene")
  })

  it("runs the council and opens the report document on success", async () => {
    const run = jest.fn(
      async (
        _input: { prompt: string; councillors: unknown[]; synthesizerAlias: string },
        _deps: unknown
      ) => RESULT
    )
    const h = harness({ run: run as unknown as CouncilDeps["run"] })
    await councilRun("why is the sky blue --models fast,smart --synth cheap", h.deps)

    expect(run).toHaveBeenCalledTimes(1)
    const [input] = run.mock.calls[0]
    expect(input).toMatchObject({
      prompt: "why is the sky blue",
      councillors: [
        { name: "fast", modelAlias: "fast" },
        { name: "smart", modelAlias: "smart" },
      ],
      synthesizerAlias: "cheap",
    })

    const kinds = h.actions.map((a) => a.type)
    expect(kinds).toContain("ACTIVITY_START")
    expect(kinds).toContain("OVERLAY_OPEN")
    expect(h.actions.at(-1)).toEqual({ type: "ACTIVITY_END", status: "done" })
    const overlay = h.actions.find((a) => a.type === "OVERLAY_OPEN") as {
      overlay: { kind: string; title: string; body: string }
    }
    expect(overlay.overlay).toMatchObject({ kind: "document", title: "Council" })
    expect(overlay.overlay.body).toContain("Council Response")
  })

  it("forwards council progress logs to the activity pill", async () => {
    const run = jest.fn(async (_input, deps: { log?: (l: string, m: string) => void }) => {
      deps.log?.("info", "council: 2 councillors")
      return RESULT
    })
    const h = harness({ run: run as unknown as CouncilDeps["run"] })
    await councilRun("q", h.deps)
    expect(h.actions).toContainEqual({ type: "ACTIVITY_PROGRESS", note: "council: 2 councillors" })
  })

  it("reports a failure notice and ends the activity in error", async () => {
    const run = jest.fn(async () => {
      throw new Error("boom")
    })
    const h = harness({ run })
    await councilRun("q", h.deps)
    expect(h.actions).toContainEqual({ type: "NOTICE", message: "Council failed: boom" })
    expect(h.actions.at(-1)).toEqual({ type: "ACTIVITY_END", status: "error" })
  })

  it("defaults to the first configured aliases when --models is absent", async () => {
    const run = jest.fn(
      async (_input: { councillors: { modelAlias: string }[] }, _deps: unknown) => RESULT
    )
    const h = harness({ run: run as unknown as CouncilDeps["run"] })
    await councilRun("q", h.deps)
    const [input] = run.mock.calls[0]
    expect(input.councillors.map((c) => c.modelAlias)).toEqual(["fast", "smart", "cheap"])
  })

  it("loads enabled aliases from settings when loadAliases is not injected", async () => {
    const actions: TuiAction[] = []
    const run = jest.fn(
      async (_i: { councillors: { modelAlias: string }[] }, _d: unknown) => RESULT
    )
    const deps: CouncilDeps = {
      dispatch: (a) => actions.push(a),
      signal: new AbortController().signal,
      ensureDb: async () => undefined,
      runPrompt: jest.fn(async () => ({ completion: "ok" })),
      run: run as unknown as CouncilDeps["run"],
    }
    await councilRun("q", deps)
    const [input] = run.mock.calls[0]
    // `off` is disabled → filtered out; `fast` + `smart` remain.
    expect(input.councillors.map((c) => c.modelAlias)).toEqual(["fast", "smart"])
  })
})
