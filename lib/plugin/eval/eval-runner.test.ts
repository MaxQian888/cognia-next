import {
  matchField,
  parseEvalSuite,
  runEvalOffline,
  runEvalOnline,
  runEvalSuite,
  type EvalCase,
  type ModelTurn,
} from "./eval-runner"

describe("matchField", () => {
  it("treats a bare primitive as deep-equality", () => {
    expect(matchField("x", "a", "a")).toBeNull()
    expect(matchField("x", "a", "b")).toContain("expected")
  })

  it("matches includes / equals / regex matchers", () => {
    expect(matchField("o", "hello world", { includes: "world" })).toBeNull()
    expect(matchField("o", "hello", { includes: "world" })).toContain("include")
    expect(matchField("o", { a: 1 }, { equals: { a: 1 } })).toBeNull()
    expect(matchField("o", "v1.2.3", { regex: "^v\\d+\\.\\d+" })).toBeNull()
    expect(matchField("o", "x", { regex: "^\\d+$" })).toContain("match")
  })

  it("stringifies non-strings for includes", () => {
    expect(matchField("o", { url: "https://github.com/x" }, { includes: "github.com" })).toBeNull()
  })
})

describe("parseEvalSuite", () => {
  it("parses a valid suite", () => {
    const suite = parseEvalSuite({
      evals: [{ name: "c1", prompt: "do x", expect: { callsTool: "t" } }],
    })
    expect(suite.evals).toHaveLength(1)
    expect(suite.evals[0].name).toBe("c1")
  })

  it("rejects a doc without an evals array", () => {
    expect(() => parseEvalSuite({})).toThrow(/evals/)
    expect(() => parseEvalSuite(null)).toThrow()
  })

  it("rejects cases missing required fields", () => {
    expect(() => parseEvalSuite({ evals: [{ prompt: "x", expect: {} }] })).toThrow(/name/)
    expect(() => parseEvalSuite({ evals: [{ name: "n", expect: {} }] })).toThrow(/prompt/)
    expect(() => parseEvalSuite({ evals: [{ name: "n", prompt: "p" }] })).toThrow(/expect/)
    expect(() => parseEvalSuite({ evals: ["nope"] })).toThrow(/object/)
  })
})

describe("runEvalOffline", () => {
  const baseCase = (overrides: Partial<EvalCase> = {}): EvalCase => ({
    name: "offline case",
    prompt: "summarize",
    expect: { callsTool: "web_fetch", output: { includes: "summary" } },
    ...overrides,
  })

  it("invokes the tool with concrete args and asserts the output", async () => {
    const invokeTool = jest.fn().mockResolvedValue("a tidy summary")
    const result = await runEvalOffline(baseCase({ args: { url: "https://x.com" } }), {
      invokeTool,
    })
    expect(invokeTool).toHaveBeenCalledWith("web_fetch", { url: "https://x.com" })
    expect(result.passed).toBe(true)
    expect(result.failures).toEqual([])
  })

  it("derives concrete args from primitive withArgs entries", async () => {
    const invokeTool = jest.fn().mockResolvedValue("summary")
    await runEvalOffline(
      baseCase({ expect: { callsTool: "web_fetch", withArgs: { url: "https://x.com", n: 3 } } }),
      { invokeTool }
    )
    expect(invokeTool).toHaveBeenCalledWith("web_fetch", { url: "https://x.com", n: 3 })
  })

  it("fails when the output does not match", async () => {
    const invokeTool = jest.fn().mockResolvedValue("nope")
    const result = await runEvalOffline(baseCase(), { invokeTool })
    expect(result.passed).toBe(false)
    expect(result.failures[0]).toContain("output")
  })

  it("fails closed when the tool throws", async () => {
    const invokeTool = jest.fn().mockRejectedValue(new Error("boom"))
    const result = await runEvalOffline(baseCase(), { invokeTool })
    expect(result.passed).toBe(false)
    expect(result.failures[0]).toContain("boom")
  })

  it("requires callsTool in offline mode", async () => {
    const result = await runEvalOffline(baseCase({ expect: { output: { includes: "x" } } }), {
      invokeTool: jest.fn(),
    })
    expect(result.passed).toBe(false)
    expect(result.failures[0]).toContain("callsTool")
  })
})

describe("runEvalOnline", () => {
  const turn = (overrides: Partial<ModelTurn> = {}): ModelTurn => ({
    toolCalls: [{ name: "web_fetch", args: { url: "https://github.com/x/y" } }],
    outputText: "here is the summary",
    ...overrides,
  })

  const onlineCase = (expect: EvalCase["expect"]): EvalCase => ({
    name: "online case",
    prompt: "summarize the PR",
    expect,
  })

  it("passes when the model calls the expected tool with matching args", async () => {
    const result = await runEvalOnline(
      onlineCase({ callsTool: "web_fetch", withArgs: { url: { includes: "github.com" } } }),
      { sendToModel: async () => turn() }
    )
    expect(result.passed).toBe(true)
  })

  it("fails when the expected tool was not called", async () => {
    const result = await runEvalOnline(onlineCase({ callsTool: "web_fetch" }), {
      sendToModel: async () => turn({ toolCalls: [] }),
    })
    expect(result.passed).toBe(false)
    expect(result.failures[0]).toContain("web_fetch")
  })

  it("fails when a forbidden tool was called", async () => {
    const result = await runEvalOnline(onlineCase({ notCallsTool: "shell_exec" }), {
      sendToModel: async () => turn({ toolCalls: [{ name: "shell_exec", args: {} }] }),
    })
    expect(result.passed).toBe(false)
    expect(result.failures[0]).toContain("shell_exec")
  })

  it("fails when withArgs do not match the actual call", async () => {
    const result = await runEvalOnline(
      onlineCase({ callsTool: "web_fetch", withArgs: { url: { includes: "gitlab.com" } } }),
      { sendToModel: async () => turn() }
    )
    expect(result.passed).toBe(false)
    expect(result.failures[0]).toContain("args.url")
  })

  it("asserts the final output text", async () => {
    const result = await runEvalOnline(onlineCase({ output: { includes: "summary" } }), {
      sendToModel: async () => turn(),
    })
    expect(result.passed).toBe(true)
  })

  it("fails closed when the model call throws", async () => {
    const result = await runEvalOnline(onlineCase({ callsTool: "x" }), {
      sendToModel: async () => {
        throw new Error("rate limited")
      },
    })
    expect(result.passed).toBe(false)
    expect(result.failures[0]).toContain("rate limited")
  })
})

describe("runEvalSuite", () => {
  it("runs every case in offline mode", async () => {
    const suite = parseEvalSuite({
      evals: [
        { name: "a", prompt: "p", expect: { callsTool: "t", output: "ok" } },
        { name: "b", prompt: "p", expect: { callsTool: "t", output: "no" } },
      ],
    })
    const results = await runEvalSuite(suite, "offline", { invokeTool: async () => "ok" })
    expect(results.map((r) => r.passed)).toEqual([true, false])
  })

  it("runs every case in online mode", async () => {
    const suite = parseEvalSuite({
      evals: [{ name: "a", prompt: "p", expect: { callsTool: "t" } }],
    })
    const results = await runEvalSuite(suite, "online", {
      sendToModel: async () => ({ toolCalls: [{ name: "t", args: {} }], outputText: "" }),
    })
    expect(results[0].passed).toBe(true)
  })
})
