import type { PluginToolContext } from "@cognia/plugin-sdk"
import { FIXTURE_END, FIXTURE_START, FIXTURE_TRACE_ID } from "./fixtures"
import { clearSrePanelRuntime, recentSreToolActivity, setSrePanelRuntime } from "./panel-runtime"
import { createSreRuntime } from "./runtime"
import { createSreTools, SRE_TOOL_NAMES } from "./tools"

const context = (overrides: Partial<PluginToolContext> = {}): PluginToolContext => ({
  config: {},
  ...overrides,
})

describe("createSreTools", () => {
  afterEach(() => clearSrePanelRuntime())

  it("registers the SRE tool contract with JSON schemas", () => {
    const tools = createSreTools()

    expect(tools.map((tool) => tool.name)).toEqual([...SRE_TOOL_NAMES])
    expect(tools.map((tool) => tool.definition.name)).toEqual([...SRE_TOOL_NAMES])
    // Ownership is the host's to assign from the activated context.
    expect(tools.every((tool) => tool.pluginId === undefined)).toBe(true)
    expect(tools.every((tool) => tool.definition.parametersSchema.type === "object")).toBe(true)
  })

  it("executes evidence tools and validates the agent-drafted table", async () => {
    const tools = createSreTools()
    const logs = await tools[0].execute(
      {
        environment: "prod",
        startTime: FIXTURE_START,
        endTime: FIXTURE_END,
        traceId: FIXTURE_TRACE_ID,
        keywords: ["fallback"],
      },
      context()
    )
    await tools[1].execute({ environment: "prod", traceId: FIXTURE_TRACE_ID }, context())
    await expect(
      tools[2].execute(
        { environment: "prod", startTime: FIXTURE_START, endTime: FIXTURE_END },
        context()
      )
    ).resolves.toMatchObject({ ok: true })

    expect(logs).toMatchObject({ ok: true, evidenceIds: ["log_004"] })
    // Demo data is labelled in the result itself, not only in the docs.
    expect(logs).toMatchObject({
      dataSource: "demo-corpus",
      notice: expect.stringMatching(/^DEMO CORPUS/),
    })

    const validation = await tools[3].execute(
      {
        rows: [
          {
            time: "12:02:54.312",
            component: "gateway",
            event: "fallback qwen-vllm-a to qwen-vllm-b",
            signals: ["fallback"],
            evidenceIds: ["log_004", "span_002"],
            sources: ["logs", "trace"],
            confidence: 0.93,
            flags: ["fallback"],
          },
        ],
      },
      context()
    )

    expect(validation).toMatchObject({ ok: true })
  })

  it("publishes a validated timeline for explicit adoption by the panel", async () => {
    const runtime = createSreRuntime()
    setSrePanelRuntime({
      runtime,
      dexie: null,
      contextPanels: { setBadge: () => true },
      confirm: async () => true,
    })
    const tools = createSreTools(runtime)
    const draft = {
      rows: [
        {
          time: "12:02:54.312",
          component: "gateway",
          event: "fallback",
          signals: ["fallback"],
          evidenceIds: [],
          sources: ["logs"],
          confidence: 0.93,
          flags: ["fallback"],
        },
      ],
    }

    const validation = await tools[3].execute(draft, context())

    expect(recentSreToolActivity()).toEqual([
      expect.objectContaining({
        tool: "sre_validate_timeline",
        timelineDraft: draft,
        validation,
      }),
    ])
  })

  it("describes every query tool as answering from the demo corpus", () => {
    for (const tool of createSreTools()) {
      if (tool.name === "sre_validate_timeline") continue
      expect(tool.definition.description).toMatch(/^DEMO CORPUS ONLY/)
    }
  })

  it("rejects missing required runtime boundaries", async () => {
    const tools = createSreTools()

    await expect(
      tools[0].execute(
        { environment: "", startTime: FIXTURE_START, endTime: FIXTURE_END },
        context()
      )
    ).rejects.toThrow("environment must be a non-empty string")
  })

  it("honors lifecycle and turn abort signals", async () => {
    const lifecycle = new AbortController()
    const tools = createSreTools(undefined, lifecycle.signal)
    lifecycle.abort()

    await expect(
      tools[0].execute(
        { environment: "prod", startTime: FIXTURE_START, endTime: FIXTURE_END },
        context()
      )
    ).rejects.toThrow("sre tool execution aborted")

    const turn = new AbortController()
    turn.abort()
    const activeTools = createSreTools()
    await expect(
      activeTools[2].execute(
        { environment: "prod", startTime: FIXTURE_START, endTime: FIXTURE_END },
        context({ signal: turn.signal })
      )
    ).rejects.toThrow("sre tool execution aborted")
  })
})
