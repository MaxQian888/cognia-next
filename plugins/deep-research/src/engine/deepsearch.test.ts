import type { AiBridge } from "../lib/ai"
import type { EngineDeps, SearchHit } from "../types"
import { runDeepSearch } from "./deepsearch"

function hit(url: string): SearchHit {
  return { url, title: `Title ${url}`, content: "snippet", score: 1 }
}

interface Script {
  decisions: string[]
  answer?: string
  evaluations?: string[]
}

/** AI bridge that routes by prompt role-content to the right scripted reply. */
function scriptedAi(script: Script): AiBridge {
  let decideCall = 0
  let evalCall = 0
  return {
    chat: async function* (messages) {
      const sys = messages[0]?.content ?? ""
      let text = ""
      if (sys.includes("controller of an iterative")) {
        text = script.decisions[Math.min(decideCall, script.decisions.length - 1)]
        decideCall += 1
      } else if (sys.includes("research analyst")) {
        text = script.answer ?? "Final answer grounded in [1]."
      } else if (sys.includes("answer evaluator")) {
        const evals = script.evaluations ?? ['{"pass":true,"reasons":[]}']
        text = evals[Math.min(evalCall, evals.length - 1)]
        evalCall += 1
      }
      yield { content: text, usage: { totalTokens: 5 } }
    },
    embed: async (texts) => texts.map((_, i) => [i + 1, 0]),
  }
}

function deps(script: Script, over: Partial<EngineDeps> = {}): EngineDeps {
  return {
    ai: scriptedAi(script),
    search: async () => [hit("https://a.com")],
    read: async () => "Relevant content about the topic.",
    logger: { info: () => {}, warn: () => {} },
    ...over,
  }
}

describe("runDeepSearch", () => {
  it("runs search → read → answer and returns a grounded result", async () => {
    const progress: number[] = []
    const d = deps(
      {
        decisions: [
          '{"action":"search","queries":["topic"]}',
          '{"action":"read","urls":["https://a.com"]}',
          '{"action":"answer"}',
        ],
      },
      { reportProgress: (p) => progress.push(p) }
    )
    const result = await runDeepSearch("what is the topic?", d, { maxSteps: 10 })

    expect(result.gaveUp).toBe(false)
    expect(result.answer).toContain("[1]")
    expect(result.citations).toEqual([{ url: "https://a.com", title: "Title https://a.com" }])
    expect(result.knowledge).toHaveLength(1)
    expect(result.steps.map((s) => s.action)).toEqual(["search", "read", "answer"])
    expect(progress[0]).toBe(0)
    expect(progress[progress.length - 1]).toBe(1)
  })

  it("retries after a rejected answer (budget-forcing) then accepts", async () => {
    const d = deps({
      decisions: [
        '{"action":"search","queries":["topic"]}',
        '{"action":"read","urls":["https://a.com"]}',
        '{"action":"answer"}', // rejected → allowAnswer=false
        '{"action":"search","queries":["topic angle two"]}', // forced to gather more
        '{"action":"read","urls":["https://a.com"]}',
        '{"action":"answer"}', // accepted
      ],
      evaluations: ['{"pass":false,"reasons":["thin"]}', '{"pass":true,"reasons":[]}'],
    })
    const result = await runDeepSearch("q", d, { maxSteps: 12 })
    expect(result.gaveUp).toBe(false)
    expect(result.steps.filter((s) => s.action === "answer")).toHaveLength(2)
  })

  it("reflect pushes sub-questions onto the gap queue", async () => {
    const d = deps({
      decisions: [
        '{"action":"reflect","gaps":["sub one","sub two"]}',
        '{"action":"search","queries":["topic"]}',
        '{"action":"read","urls":["https://a.com"]}',
        '{"action":"answer"}',
      ],
    })
    const result = await runDeepSearch("q", d, { maxSteps: 10 })
    const reflect = result.steps.find((s) => s.action === "reflect")
    expect(reflect?.detail).toContain("2 sub-question")
  })

  it("consumes the head gap when a search chases it and falls back to the next gap", async () => {
    const searched: string[] = []
    const d = deps(
      {
        decisions: [
          '{"action":"reflect","gaps":["chase me first","second gap"]}',
          '{"action":"search","queries":["chase me first"]}',
          // An empty-query search decision falls back to the next open gap —
          // previously it re-issued the original question forever because the
          // queue head never moved.
          '{"action":"search"}',
          '{"action":"read","urls":["https://a.com"]}',
          '{"action":"answer"}',
        ],
      },
      {
        search: async (q) => {
          searched.push(q)
          return [hit("https://a.com")]
        },
      }
    )
    const result = await runDeepSearch("q", d, { maxSteps: 10 })
    // The empty-query fallback searched the NEXT open gap, not the dead head.
    expect(searched).toEqual(["chase me first", "second gap"])
    expect(result.gaveUp).toBe(false)
  })

  it("enters beast mode and gives up when the step limit is hit", async () => {
    const d = deps({ decisions: ['{"action":"reflect","gaps":["x"]}'] })
    const result = await runDeepSearch("q", d, { maxSteps: 3 })
    expect(result.gaveUp).toBe(true)
    expect(result.steps.at(-1)?.detail).toMatch(/forced/)
  })

  it("aborts immediately when the signal is already aborted — without a farewell model call", async () => {
    const controller = new AbortController()
    controller.abort()
    const chat = jest.fn(async function* () {
      yield { content: "should not run", usage: { totalTokens: 1 } }
    })
    const d = deps(
      { decisions: ['{"action":"search","queries":["x"]}'] },
      { signal: controller.signal, ai: { chat, embed: async (t: string[]) => t.map(() => [0]) } }
    )
    const result = await runDeepSearch("q", d, { maxSteps: 5 })
    expect(result.gaveUp).toBe(true)
    expect(result.aborted).toBe(true)
    expect(result.steps.at(-1)?.detail).toMatch(/aborted/)
    // Cancellation returns the partial findings — a beast-mode draft would
    // spend one more model call on a run the caller already gave up on.
    expect(chat).not.toHaveBeenCalled()
  })

  it("propagates a fatal model error from the decider instead of looping to the step cap", async () => {
    const noProvider = Object.assign(new Error("no model"), { code: "NO_PROVIDER_AVAILABLE" })
    const d = deps(
      { decisions: [] },
      {
        ai: {
          chat: async function* () {
            throw noProvider
          },
          embed: async (t: string[]) => t.map(() => [0]),
        },
      }
    )
    await expect(runDeepSearch("q", d, { maxSteps: 5 })).rejects.toBe(noProvider)
  })
})
