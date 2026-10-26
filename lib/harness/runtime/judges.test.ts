import type { AppSettings } from "@cognia/agent-config-types"
import type { LlmClient } from "@/lib/twin/distill/llm"
import { makeEvidence, makeExperience, makeRun, makeRunConfig } from "../test-fixtures"
import { createSelectionJudge, runReflector } from "./judges"
import type { HarnessModelDeps } from "./model-call"

function deps(
  answer: string,
  seen: { prompt?: string; system?: string; op?: string; model?: unknown }
) {
  const client: LlmClient = {
    reportsCallUsage: true,
    model: "judge-1",
    complete: async (prompt, options) => {
      seen.prompt = prompt
      seen.system = options?.system
      options?.onUsage?.({
        inputTokens: 40,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      })
      return answer
    },
  }
  const d: HarnessModelDeps = {
    getSettings: async () => ({}) as AppSettings,
    buildClient: (args) => {
      seen.model = args
      return client
    },
    bookUsage: async (input) => {
      seen.op = input.operationId
      return { costUsd: 0.001, costKnown: true }
    },
  }
  return d
}

const ctx = (onUsage = jest.fn()) => ({
  run: makeRun({ config: makeRunConfig({ models: { selector: { model: "sel" } } }) }),
  attempt: 2,
  agent: { providerId: "anthropic", model: "sonnet" },
  signal: new AbortController().signal,
  onUsage,
})

describe("createSelectionJudge", () => {
  it("shows anonymous runs and reads the verdict", async () => {
    const seen: Parameters<typeof deps>[1] = {}
    const onUsage = jest.fn()
    const judge = createSelectionJudge(
      ctx(onUsage),
      deps(
        '{"ranking":["R2","R1"],"best":"R2","confidence":"high","evidence":{"R2":"complete"}}',
        seen
      )
    )
    const verdict = await judge([
      { id: "R1", evidence: makeEvidence() },
      { id: "R2", evidence: makeEvidence({ output: "Better report" }) },
    ])
    expect(verdict).toEqual({
      best: "R2",
      ranking: ["R2", "R1"],
      confidence: "high",
      evidence: { R2: "complete" },
    })
    expect(seen.prompt).toContain("===== RUN R1 =====")
    expect(seen.prompt).toContain("# Rollout R2")
    expect(seen.prompt).not.toContain("snap-base")
    expect(seen.system).toMatch(/one of them may be the unchanged original/)
    expect(seen.model).toMatchObject({ modelOverride: "sel" })
    expect(seen.op).toBe("harness:run-1:select:2:1")
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 40 }))
  })

  it("returns null for an answer naming no run", async () => {
    const judge = createSelectionJudge(ctx(), deps('{"best":"R9"}', {}))
    expect(await judge([{ id: "R1", evidence: makeEvidence() }])).toBeNull()
  })
})

describe("runReflector", () => {
  it("parses the reflection against the run's labels and given lessons", async () => {
    const seen: Parameters<typeof deps>[1] = {}
    const out = await runReflector(
      {
        ...ctx(),
        labels: ["dom1"],
        reflection: {
          task: makeRun().task,
          base: [{ label: "base1", evidence: makeEvidence() }],
          candidates: [{ label: "dom1", notes: "", diff: "+x", evidence: makeEvidence() }],
          decision: { outcome: "keep-base", reason: "tie", requiresApproval: false },
          retrieved: [makeExperience()],
        },
      },
      deps(
        JSON.stringify({
          edits: [
            {
              component: "memory.md",
              candidates: ["dom1"],
              change: "c",
              observed: "o",
              verdict: "helped",
            },
          ],
          retrieved: [{ id: "exp-1", verdict: "no observed effect" }],
          experience: null,
        }),
        seen
      )
    )
    expect(out.parsed?.edits).toHaveLength(1)
    expect(out.parsed?.retrieved).toEqual([{ id: "exp-1", verdict: "no observed effect" }])
    expect(out.model).toBe("judge-1")
    expect(seen.op).toBe("harness:run-1:reflect:2:1")
    expect(seen.model).toMatchObject({ providerOverride: "anthropic", modelOverride: "sonnet" })
  })
})
