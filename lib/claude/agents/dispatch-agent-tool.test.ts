import {
  COLLECT_TIMEOUT_MAX_MS,
  DISPATCH_AGENT_TOOL_NAME,
  DISPATCH_AGENT_PLUGIN_ID,
  buildDispatchAgentSchema,
  buildDispatchAgentManifestEntry,
  collectWithTimeout,
  parseDispatchAgentArgs,
  renderCollectPending,
  type DispatchAgentAvailableSubagent,
} from "./dispatch-agent-tool"

const available: DispatchAgentAvailableSubagent[] = [
  { id: "researcher", description: "Researches things" },
  { id: "coder", description: "Writes code" },
]

describe("dispatch-agent-tool — schema & manifest", () => {
  it("constrains subagentId to an enum when subagents are available", () => {
    const schema = buildDispatchAgentSchema(available) as {
      properties: {
        subagentId: { enum?: string[] }
        dispatches: { items: { properties: { subagentId: { enum?: string[] } } } }
      }
    }
    expect(schema.properties.subagentId.enum).toEqual(["researcher", "coder"])
    expect(schema.properties.dispatches.items.properties.subagentId.enum).toEqual([
      "researcher",
      "coder",
    ])
  })

  it("omits the enum when no subagents are available", () => {
    const schema = buildDispatchAgentSchema([]) as {
      properties: { subagentId: { enum?: string[] } }
    }
    expect(schema.properties.subagentId.enum).toBeUndefined()
  })

  it("builds a manifest entry with the synthetic plugin id and lists agents", () => {
    const entry = buildDispatchAgentManifestEntry(available)
    expect(entry.name).toBe(DISPATCH_AGENT_TOOL_NAME)
    expect(entry.pluginId).toBe(DISPATCH_AGENT_PLUGIN_ID)
    expect(entry.description).toContain("researcher")
    expect(entry.description).toContain("coder")
  })

  it("disables the round-trip timeout (subagents run their own bounded loop)", () => {
    expect(buildDispatchAgentManifestEntry(available).timeoutMs).toBe(0)
  })
})

describe("dispatch-agent-tool — parseDispatchAgentArgs", () => {
  it("parses the single form with defaults (toolsEnabled true, background false)", () => {
    const r = parseDispatchAgentArgs({ subagentId: "coder", prompt: "do it" })
    expect(r).toEqual({
      mode: "dispatch",
      dispatches: [{ subagentId: "coder", prompt: "do it", toolsEnabled: true, background: false }],
    })
  })

  it("accepts the Claude Code-style `subagent_type` as an alias for subagentId", () => {
    const r = parseDispatchAgentArgs({ subagent_type: "coder", prompt: "do it" })
    expect(r).toEqual({
      mode: "dispatch",
      dispatches: [{ subagentId: "coder", prompt: "do it", toolsEnabled: true, background: false }],
    })
  })

  it("honors explicit toolsEnabled=false and background=true", () => {
    const r = parseDispatchAgentArgs({
      subagentId: "coder",
      prompt: "x",
      toolsEnabled: false,
      background: true,
    })
    expect(r).toMatchObject({
      mode: "dispatch",
      dispatches: [{ toolsEnabled: false, background: true }],
    })
  })

  it("parses the parallel form, dropping malformed entries", () => {
    const r = parseDispatchAgentArgs({
      dispatches: [
        { subagentId: "a", prompt: "one" },
        { subagentId: "b" }, // missing prompt → dropped
        { prompt: "no id" }, // missing id → dropped
        { subagentId: "c", prompt: "two", background: true },
      ],
    })
    expect(r.mode).toBe("dispatch")
    if (r.mode === "dispatch") {
      expect(r.dispatches.map((d) => d.subagentId)).toEqual(["a", "c"])
      expect(r.dispatches[1].background).toBe(true)
    }
  })

  it("errors when the parallel array has no valid entries", () => {
    const r = parseDispatchAgentArgs({ dispatches: [{ subagentId: "a" }] })
    expect(r.mode).toBe("error")
  })

  it("parses the collect form and trims the runId", () => {
    const r = parseDispatchAgentArgs({ collect: "  run-123  " })
    expect(r).toEqual({ mode: "collect", runIds: ["run-123"] })
  })

  it("collect accepts a list of runIds, dropping blanks and duplicates", () => {
    const r = parseDispatchAgentArgs({ collect: ["a", " b ", "", "a", 7] })
    expect(r).toEqual({ mode: "collect", runIds: ["a", "b"] })
  })

  it("collect carries a clamped timeoutMs (negative and NaN dropped, cap applied)", () => {
    expect(parseDispatchAgentArgs({ collect: "a", timeoutMs: 1500.9 })).toEqual({
      mode: "collect",
      runIds: ["a"],
      timeoutMs: 1500,
    })
    expect(parseDispatchAgentArgs({ collect: "a", timeoutMs: "250" })).toMatchObject({
      timeoutMs: 250,
    })
    expect(parseDispatchAgentArgs({ collect: "a", timeoutMs: -1 })).toEqual({
      mode: "collect",
      runIds: ["a"],
    })
    expect(parseDispatchAgentArgs({ collect: "a", timeoutMs: Infinity })).toEqual({
      mode: "collect",
      runIds: ["a"],
    })
    expect(parseDispatchAgentArgs({ collect: "a", timeoutMs: 10 ** 12 })).toMatchObject({
      timeoutMs: COLLECT_TIMEOUT_MAX_MS,
    })
  })

  it("collect with no usable id is an error rather than a silent no-op", () => {
    expect(parseDispatchAgentArgs({ collect: "   " }).mode).toBe("error")
    expect(parseDispatchAgentArgs({ collect: [] }).mode).toBe("error")
  })

  it("parses the cancel form (single id or list) and gives it top precedence", () => {
    expect(parseDispatchAgentArgs({ cancel: " r1 " })).toEqual({ mode: "cancel", runIds: ["r1"] })
    expect(parseDispatchAgentArgs({ cancel: ["r1", "r2"] })).toEqual({
      mode: "cancel",
      runIds: ["r1", "r2"],
    })
    expect(
      parseDispatchAgentArgs({ cancel: "r1", collect: "r2", resume: "r3", prompt: "x" })
    ).toEqual({ mode: "cancel", runIds: ["r1"] })
    expect(parseDispatchAgentArgs({ cancel: [] }).mode).toBe("error")
  })

  it("threads a per-call model override through single, parallel and resume forms", () => {
    expect(parseDispatchAgentArgs({ subagentId: "a", prompt: "x", model: " haiku " })).toEqual({
      mode: "dispatch",
      dispatches: [
        { subagentId: "a", prompt: "x", toolsEnabled: true, background: false, model: "haiku" },
      ],
    })
    expect(
      parseDispatchAgentArgs({
        dispatches: [
          { subagentId: "a", prompt: "x", model: "m1" },
          { subagentId: "b", prompt: "y" },
        ],
      })
    ).toMatchObject({ dispatches: [{ model: "m1" }, { subagentId: "b" }] })
    expect(parseDispatchAgentArgs({ resume: "r", prompt: "x", model: "m2" })).toMatchObject({
      mode: "resume",
      model: "m2",
    })
    // A blank model is the same as none.
    expect(parseDispatchAgentArgs({ subagentId: "a", prompt: "x", model: "  " })).toEqual({
      mode: "dispatch",
      dispatches: [{ subagentId: "a", prompt: "x", toolsEnabled: true, background: false }],
    })
  })

  it("collect wins over a dispatch payload", () => {
    const r = parseDispatchAgentArgs({ collect: "run-1", subagentId: "a", prompt: "x" })
    expect(r.mode).toBe("collect")
  })

  it("errors on empty / unusable args", () => {
    expect(parseDispatchAgentArgs({}).mode).toBe("error")
    expect(parseDispatchAgentArgs({ subagentId: "  ", prompt: "x" }).mode).toBe("error")
    expect(parseDispatchAgentArgs({ subagentId: "a", prompt: "   " }).mode).toBe("error")
  })

  it("parses the resume form (trimmed runId, follow-up prompt, background flag)", () => {
    const r = parseDispatchAgentArgs({
      resume: "  run-9  ",
      prompt: "fix issue 2",
      background: true,
    })
    expect(r).toEqual({ mode: "resume", runId: "run-9", prompt: "fix issue 2", background: true })
  })

  it("threads an explicit toolsEnabled through resume", () => {
    const r = parseDispatchAgentArgs({ resume: "run-9", prompt: "go", toolsEnabled: false })
    expect(r).toMatchObject({ mode: "resume", toolsEnabled: false, background: false })
  })

  it("resume without a prompt is an error", () => {
    const r = parseDispatchAgentArgs({ resume: "run-9" })
    expect(r.mode).toBe("error")
    expect((r as { message: string }).message).toMatch(/requires a non-empty `prompt`/)
  })

  it("precedence: collect > resume > dispatches > single", () => {
    expect(parseDispatchAgentArgs({ collect: "c1", resume: "r1", prompt: "x" }).mode).toBe(
      "collect"
    )
    expect(
      parseDispatchAgentArgs({
        resume: "r1",
        prompt: "x",
        dispatches: [{ subagentId: "a", prompt: "y" }],
      }).mode
    ).toBe("resume")
    expect(parseDispatchAgentArgs({ resume: "r1", prompt: "x", subagentId: "a" }).mode).toBe(
      "resume"
    )
  })

  it("advertises resume in the schema and description", () => {
    const entry = buildDispatchAgentManifestEntry([{ id: "explore", description: "d" }])
    expect(JSON.stringify(entry.jsonSchema)).toContain('"resume"')
    expect(entry.description).toContain('{resume:"<runId>"')
  })
})

describe("dispatch-agent-tool, collect helpers", () => {
  it("advertises cancel, list-collect, timeoutMs and model in the schema and description", () => {
    const entry = buildDispatchAgentManifestEntry([{ id: "explore", description: "d" }])
    const schema = JSON.stringify(entry.jsonSchema)
    expect(schema).toContain('"cancel"')
    expect(schema).toContain('"timeoutMs"')
    expect(schema).toContain('"model"')
    expect(entry.description).toContain("cancel")
    expect(entry.description).toContain("model")
    const collect = (entry.jsonSchema as { properties: { collect: { type: unknown } } }).properties
      .collect
    expect(collect.type).toEqual(["string", "array"])
  })

  it("collectWithTimeout awaits outright when no window is given", async () => {
    await expect(collectWithTimeout(async () => "v", undefined)).resolves.toEqual({
      settled: true,
      value: "v",
    })
  })

  it("collectWithTimeout reports pending when the window closes first", async () => {
    let release!: (v: string) => void
    const slow = new Promise<string>((resolve) => {
      release = resolve
    })
    await expect(collectWithTimeout(() => slow, 5)).resolves.toEqual({ settled: false })
    release("late")
    // The losing collect settles on its own without surfacing anywhere.
    await expect(slow).resolves.toBe("late")
  })

  it("collectWithTimeout settles when the collect wins the race", async () => {
    await expect(collectWithTimeout(async () => 42, 1000)).resolves.toEqual({
      settled: true,
      value: 42,
    })
  })

  it("collectWithTimeout swallows a late rejection from the losing collect", async () => {
    let reject!: (e: Error) => void
    const failing = new Promise<string>((_resolve, rej) => {
      reject = rej
    })
    await expect(collectWithTimeout(() => failing, 5)).resolves.toEqual({ settled: false })
    reject(new Error("late failure"))
    await Promise.resolve()
    // Reaching here without an unhandled-rejection crash is the assertion.
  })

  it("renderCollectPending names both the retry and the cancel verb", () => {
    const text = renderCollectPending("r-1", 12_400)
    expect(text).toContain('"r-1"')
    expect(text).toContain("12s")
    expect(text).toContain('collect:"r-1"')
    expect(text).toContain('cancel:"r-1"')
  })
})
