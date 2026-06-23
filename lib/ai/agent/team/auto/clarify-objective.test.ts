import { applyClarifications, clarifyObjective, DEFAULT_MAX_QUESTIONS } from "./clarify-objective"
import { AutoOrchestrationPiiError } from "./auto-orchestrate"
import type { LlmClient } from "@/lib/twin/distill/llm"

const client = (text: string): LlmClient => ({ complete: async () => text })
const throwingClient = (): LlmClient => ({
  complete: async () => {
    throw new Error("network")
  },
})

describe("clarifyObjective (model path)", () => {
  it("parses, trims, dedupes and caps the returned questions", async () => {
    const res = await clarifyObjective({
      objective: "build something",
      max: 2,
      client: client(
        '{"questions":["  What is the scope?  ","Who are the users?","What is the scope?","third"]}'
      ),
    })
    // deduped ("What is the scope?" once), capped to max=2.
    expect(res.questions).toEqual(["What is the scope?", "Who are the users?"])
  })

  it("returns no questions when the model says the objective is clear", async () => {
    const res = await clarifyObjective({
      objective: "rename foo to bar in file x",
      client: client('{"questions":[]}'),
    })
    expect(res.questions).toEqual([])
  })

  it("embeds the resolved max in the prompt and system", async () => {
    let seenPrompt = ""
    let seenSystem = ""
    const spyClient: LlmClient = {
      complete: async (prompt, opts) => {
        seenPrompt = prompt
        seenSystem = opts?.system ?? ""
        return '{"questions":[]}'
      },
    }
    await clarifyObjective({ objective: "x", max: 4, client: spyClient })
    expect(seenPrompt).toContain("max 4")
    expect(seenSystem).toContain("at most 4")
  })

  it("clamps max to the [1,5] range and defaults sensibly", async () => {
    let seenPrompt = ""
    const spy = (): LlmClient => ({
      complete: async (prompt) => {
        seenPrompt = prompt
        return '{"questions":[]}'
      },
    })
    await clarifyObjective({ objective: "x", max: 99, client: spy() })
    expect(seenPrompt).toContain("max 5")
    await clarifyObjective({ objective: "x", max: 0, client: spy() })
    expect(seenPrompt).toContain("max 1")
    await clarifyObjective({ objective: "x", client: spy() })
    expect(seenPrompt).toContain(`max ${DEFAULT_MAX_QUESTIONS}`)
  })
})

describe("clarifyObjective (fail-open)", () => {
  it("returns no questions when the model throws", async () => {
    const res = await clarifyObjective({ objective: "x", client: throwingClient() })
    expect(res.questions).toEqual([])
  })

  it("returns no questions when the response is not JSON", async () => {
    const res = await clarifyObjective({ objective: "x", client: client("not json at all") })
    expect(res.questions).toEqual([])
  })

  it("returns no questions when questions is not an array", async () => {
    const res = await clarifyObjective({ objective: "x", client: client('{"questions":"nope"}') })
    expect(res.questions).toEqual([])
  })

  it("short-circuits to empty when already aborted", async () => {
    const ac = new AbortController()
    ac.abort()
    let called = false
    const spy: LlmClient = {
      complete: async () => {
        called = true
        return '{"questions":["x"]}'
      },
    }
    const res = await clarifyObjective({ objective: "x", client: spy, signal: ac.signal })
    expect(res.questions).toEqual([])
    expect(called).toBe(false)
  })
})

describe("clarifyObjective (PII gate, fail-closed)", () => {
  it("throws AutoOrchestrationPiiError when the gate still leaks", async () => {
    let called = false
    const spy: LlmClient = {
      complete: async () => {
        called = true
        return '{"questions":[]}'
      },
    }
    await expect(
      clarifyObjective({
        objective: "secret",
        client: spy,
        piiGate: () => ({ redacted: "secret", leaked: true }),
      })
    ).rejects.toBeInstanceOf(AutoOrchestrationPiiError)
    expect(called).toBe(false)
  })

  it("plans from the redacted text the gate returns", async () => {
    let seenPrompt = ""
    const spy: LlmClient = {
      complete: async (prompt) => {
        seenPrompt = prompt
        return '{"questions":[]}'
      },
    }
    await clarifyObjective({
      objective: "raw",
      client: spy,
      piiGate: () => ({ redacted: "REDACTED", leaked: false }),
    })
    expect(seenPrompt).toContain("REDACTED")
    expect(seenPrompt).not.toContain("raw\n")
  })
})

describe("applyClarifications", () => {
  it("appends answered Q/A pairs to the objective", () => {
    const out = applyClarifications("build a tool", [
      { question: "Scope?", answer: "Just the CLI" },
      { question: "Users?", answer: "Developers" },
    ])
    expect(out).toContain("build a tool")
    expect(out).toContain("Clarifications:")
    expect(out).toContain("Q: Scope?\nA: Just the CLI")
    expect(out).toContain("Q: Users?\nA: Developers")
  })

  it("skips questions with no answer", () => {
    const out = applyClarifications("obj", [
      { question: "Scope?", answer: "  " },
      { question: "Users?", answer: "Devs" },
    ])
    expect(out).not.toContain("Scope?")
    expect(out).toContain("Q: Users?\nA: Devs")
  })

  it("returns the objective unchanged when nothing was answered", () => {
    expect(applyClarifications("obj", [])).toBe("obj")
    expect(applyClarifications("obj", [{ question: "Q?", answer: "" }])).toBe("obj")
  })
})
