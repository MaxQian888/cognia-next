/**
 * Tests for the Computer Use plugin's thin adapter over the canonical
 * app-session automation client.
 */

import definition from "./index"
import type { ActionRequest } from "@cognia/plugin-sdk"
import type { PluginTool } from "@cognia/plugin-sdk"
const mockedAutomation = {
  getAppState: jest.fn(),
  listApps: jest.fn(),
  queryElements: jest.fn(),
  expandElement: jest.fn(),
  performAction: jest.fn(),
  zoom: jest.fn(),
  findText: jest.fn(),
  clickText: jest.fn(),
}

interface MockAgentContext {
  pluginId: string
  logger?: { info: jest.Mock; warn: jest.Mock }
  automation: typeof mockedAutomation
  agent?: {
    registerTool: jest.Mock<void, [PluginTool]>
    unregisterTool: jest.Mock<void, [string]>
    context: { registerProvider: jest.Mock }
  }
}

function buildContext(options: { withAgent?: boolean } = {}): MockAgentContext {
  const context: MockAgentContext = {
    pluginId: "cognia-computer-use",
    logger: { info: jest.fn(), warn: jest.fn() },
    automation: mockedAutomation,
  }
  if (options.withAgent !== false) {
    context.agent = {
      registerTool: jest.fn(),
      unregisterTool: jest.fn(),
      context: { registerProvider: jest.fn() },
    }
  }
  return context
}

async function getTool(name: string): Promise<PluginTool> {
  const context = buildContext()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await definition.activate(context as any)
  const tool = context
    .agent!.registerTool.mock.calls.map((call) => call[0])
    .find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`tool not registered: ${name}`)
  return tool
}

afterEach(() => {
  jest.clearAllMocks()
})

/**
 * A revision shaped like the real `UiStateRevision`. The screenshot bytes are a
 * stand-in — what matters is that they travel as an image block rather than
 * being stringified into the JSON half.
 */
function buildRevision(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    sessionId: "automation-session",
    lineageId: "lineage",
    revision: 7,
    turnToken: "turn-token",
    app: { bundleId: "com.apple.TextEdit", path: null, displayName: "TextEdit", processId: 1 },
    surface: {
      window_id: null,
      logical_bounds: { x: 0, y: 0, width: 800, height: 600 },
      pixel_width: 1600,
      pixel_height: 1200,
      scale_factor: 2,
      coordinate_space: "screenshotPixels",
    },
    screenshot: {
      bytes: "QUJD",
      width: 1600,
      height: 1200,
      capturedAt: 1,
      format: "png",
    },
    projection: "model",
    tree: { nodes: [] },
    diff: null,
    truncation: [],
    instructionPack: null,
    capturedAt: 1,
    ...overrides,
  }
}

describe("computer-use plugin activate()", () => {
  it("declares i18n and leaves manifest commands to the host manager", async () => {
    const context = buildContext()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await definition.activate(context as any)

    const manifest = definition.manifest as {
      i18n?: { locales?: Record<string, Record<string, string>> }
    }
    expect(manifest.i18n?.locales?.en?.["slash.cu.description"]).toBeDefined()
    expect(manifest.i18n?.locales?.["zh-CN"]?.["slash.cu.body"]).toBeDefined()
  })

  it("registers only the canonical app-session tools", async () => {
    const context = buildContext()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await definition.activate(context as any)

    const tools = context.agent!.registerTool.mock.calls.map((call) => call[0])
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "click_text",
      "expand_element",
      "find_text",
      "get_app_state",
      "list_apps",
      "perform_action",
      "query_elements",
      "wait",
      "zoom",
    ])
    for (const tool of tools) {
      expect(tool.pluginId).toBe("cognia-computer-use")
      expect(tool.definition.parametersSchema).toBeDefined()
      // `wait` drives nothing and reveals nothing; prompting for a sleep would
      // train the operator to click through prompts.
      expect(tool.definition.requiresApproval).toBe(tool.name !== "wait")
    }
  })

  it("registers guidance for the app-session state/action loop", async () => {
    const context = buildContext()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await definition.activate(context as any)

    const providers = context.agent!.context.registerProvider.mock.calls.map((call) => call[0])
    expect(providers).toHaveLength(1)
    const text = providers[0].provide()
    expect(text).toMatch(/get_app_state/)
    expect(text).toMatch(/perform_action/)
    expect(text).toMatch(/browser_\*/)
  })

  it("warns when the host cannot register tools", async () => {
    const context = buildContext({ withAgent: false })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await definition.activate(context as any)
    expect(context.logger!.warn).toHaveBeenCalled()
  })

  it("routes all tool calls directly to the canonical client", async () => {
    const state = { sessionId: "automation-session", lineageId: "lineage", revision: 7 }
    mockedAutomation.getAppState.mockResolvedValue(buildRevision())
    const locator = { kind: "bundleId" as const, bundleId: "com.apple.TextEdit" }
    const elementLocator = { nameContains: "Document" }
    const handle = { ...state, index: 4, fingerprint: "fingerprint" }
    const request: ActionRequest = {
      turnToken: "turn-token",
      target: { kind: "element", handle },
      action: { kind: "click" },
      strategy: "semantic",
    }

    const toolContext = {
      config: {},
      sessionId: "chat-session",
      messageId: "message-1",
      sandboxRuntimeRef: "sandbox-runtime:one",
    }
    await (await getTool("list_apps")).execute({}, toolContext)
    await (
      await getTool("get_app_state")
    ).execute({ sessionId: state.sessionId, locator, options: {} }, toolContext)
    await (
      await getTool("query_elements")
    ).execute({ ...state, locator: elementLocator, limit: 40 }, toolContext)
    await (
      await getTool("expand_element")
    ).execute({ handle, continuationToken: "next", limit: 25 }, toolContext)
    await (await getTool("perform_action")).execute({ request }, toolContext)

    const origin = {
      sessionId: "chat-session",
      messageId: "message-1",
      sandboxRuntimeRef: "sandbox-runtime:one",
    }
    expect(mockedAutomation.listApps).toHaveBeenCalledWith(origin)
    expect(mockedAutomation.getAppState).toHaveBeenCalledWith(state.sessionId, locator, {}, origin)
    expect(mockedAutomation.queryElements).toHaveBeenCalledWith(state, elementLocator, 40, origin)
    expect(mockedAutomation.expandElement).toHaveBeenCalledWith(handle, "next", 25, origin)
    expect(mockedAutomation.performAction).toHaveBeenCalledWith(request, origin)
  })
})

describe("get_app_state result shape", () => {
  it("returns the screenshot as an image block, not stringified base64", async () => {
    // The regression this guards: returning the revision object directly made
    // the sidecar fall through to `toolText`, which JSON.stringify-ed the whole
    // thing — so a vision model received the PNG as a wall of base64 text and
    // could not see the screen at all.
    mockedAutomation.getAppState.mockResolvedValue(buildRevision())
    const tool = await getTool("get_app_state")
    const result = (await tool.execute(
      { sessionId: "s", locator: { kind: "bundleId", bundleId: "com.apple.TextEdit" } },
      { config: {} } as never
    )) as { content: { type: string; data?: string; mimeType?: string; text?: string }[] }

    const image = result.content.find((block) => block.type === "image")
    expect(image).toEqual({ type: "image", data: "QUJD", mimeType: "image/png" })
  })

  it("keeps the screenshot dimensions in the JSON but drops the bytes", async () => {
    // A pixel target has to restate the frame it was measured against — that
    // restatement is the stale-frame guard — so the dimensions must survive
    // even though the bytes move into the image block.
    mockedAutomation.getAppState.mockResolvedValue(buildRevision())
    const tool = await getTool("get_app_state")
    const result = (await tool.execute(
      { sessionId: "s", locator: { kind: "bundleId", bundleId: "x" } },
      { config: {} } as never
    )) as { content: { type: string; text?: string }[] }

    const text = result.content.find((block) => block.type === "text")!.text!
    const parsed = JSON.parse(text) as {
      screenshot: { width: number; height: number; bytes?: string }
      turnToken: string
    }
    expect(parsed.screenshot.width).toBe(1600)
    expect(parsed.screenshot.height).toBe(1200)
    expect(parsed.screenshot.bytes).toBeUndefined()
    expect(text).not.toContain("QUJD")
    expect(parsed.turnToken).toBe("turn-token")
  })

  it("emits jpeg mime when the backend captured jpeg", async () => {
    mockedAutomation.getAppState.mockResolvedValue(
      buildRevision({
        screenshot: { bytes: "QQ==", width: 10, height: 10, capturedAt: 1, format: "jpeg" },
      })
    )
    const tool = await getTool("get_app_state")
    const result = (await tool.execute(
      { sessionId: "s", locator: { kind: "bundleId", bundleId: "x" } },
      { config: {} } as never
    )) as { content: { type: string; mimeType?: string }[] }
    expect(result.content.find((b) => b.type === "image")?.mimeType).toBe("image/jpeg")
  })

  it("omits the image block entirely when no frame was captured", async () => {
    mockedAutomation.getAppState.mockResolvedValue(buildRevision({ screenshot: null }))
    const tool = await getTool("get_app_state")
    const result = (await tool.execute(
      { sessionId: "s", locator: { kind: "bundleId", bundleId: "x" } },
      { config: {} } as never
    )) as { content: { type: string }[] }
    expect(result.content.every((block) => block.type === "text")).toBe(true)
    expect(result.content).toHaveLength(1)
  })
})

describe("zoom / wait / OCR fallbacks", () => {
  it("returns the zoom crop as an image and reports where it sits", async () => {
    mockedAutomation.zoom.mockResolvedValue({
      sessionId: "s",
      lineageId: "l",
      revision: 3,
      region: { x: 400, y: 300, width: 320, height: 240 },
      screenshot: {
        bytes: "WlpaWg==",
        width: 320,
        height: 240,
        capturedAt: 1,
        format: "png",
      },
    })
    const tool = await getTool("zoom")
    const result = (await tool.execute(
      {
        sessionId: "s",
        lineageId: "l",
        revision: 3,
        region: { x: 400, y: 300, width: 320, height: 240 },
      },
      { config: {} } as never
    )) as { content: { type: string; data?: string; text?: string }[] }

    expect(result.content.find((b) => b.type === "image")?.data).toBe("WlpaWg==")
    // Without the origin the model would report coordinates in crop space and
    // the click would land somewhere else entirely.
    const parsed = JSON.parse(result.content.find((b) => b.type === "text")!.text!) as {
      region: { x: number; y: number }
    }
    expect(parsed.region).toEqual({ x: 400, y: 300, width: 320, height: 240 })
  })

  // Fake timers: the point is the clamp arithmetic, and a real 10s sleep would
  // make the suite pay for it.
  async function runWait(durationMs: unknown): Promise<{ waitedMs: number }> {
    jest.useFakeTimers()
    try {
      const tool = await getTool("wait")
      const pending = tool.execute({ durationMs }, { config: {} } as never) as Promise<{
        waitedMs: number
      }>
      await jest.runAllTimersAsync()
      return await pending
    } finally {
      jest.useRealTimers()
    }
  }

  it("clamps wait to its bounds and reports what it actually waited", async () => {
    await expect(runWait(1)).resolves.toEqual({ waitedMs: 50 })
    await expect(runWait(999_999)).resolves.toEqual({ waitedMs: 10_000 })
  })

  it("treats a non-numeric wait as the minimum rather than throwing", async () => {
    await expect(runWait("soon")).resolves.toEqual({ waitedMs: 50 })
  })

  it("routes the OCR fallbacks to the guarded client", async () => {
    mockedAutomation.findText.mockResolvedValue({ ok: true, matches: [] })
    mockedAutomation.clickText.mockResolvedValue({ ok: true, clicked: {} })
    const toolContext = { config: {}, sessionId: "chat", messageId: "m1" }

    await (await getTool("find_text")).execute({ query: "Save" }, toolContext as never)
    await (
      await getTool("click_text")
    ).execute({ query: "Save", occurrence: 2, button: "right" }, toolContext as never)

    const origin = { sessionId: "chat", messageId: "m1" }
    expect(mockedAutomation.findText).toHaveBeenCalledWith({ query: "Save" }, origin)
    expect(mockedAutomation.clickText).toHaveBeenCalledWith(
      { query: "Save", occurrence: 2, button: "right" },
      origin
    )
  })
})

describe("published tool schemas", () => {
  it("publishes the action vocabulary instead of an opaque object", async () => {
    // `perform_action` used to declare `request: {type:"object"}`, which the
    // sidecar erases to `z.unknown()` — the model was never told that element
    // handles, the pixel fallback or the eight action kinds existed.
    const tool = await getTool("perform_action")
    const schema = tool.definition.parametersSchema as {
      properties: { request: { properties: { action: { oneOf?: unknown[] } } } }
    }
    expect(Array.isArray(schema.properties.request.properties.action.oneOf)).toBe(true)
    expect(schema.properties.request.properties.action.oneOf!.length).toBeGreaterThanOrEqual(8)
  })

  it("describes the element/pixel target union on perform_action", async () => {
    const tool = await getTool("perform_action")
    const schema = JSON.stringify(tool.definition.parametersSchema)
    expect(schema).toContain("element")
    expect(schema).toContain("pixel")
    expect(schema).toContain("screenshotWidth")
  })

  it("gives query_elements a real locator schema", async () => {
    const tool = await getTool("query_elements")
    const schema = tool.definition.parametersSchema as {
      properties: { locator: { properties?: Record<string, unknown> } }
    }
    expect(Object.keys(schema.properties.locator.properties ?? {})).toEqual(
      expect.arrayContaining(["name", "nameContains", "automationId", "controlType"])
    )
  })
})

describe("computer-use plugin deactivate()", () => {
  it("unregisters all canonical tools", async () => {
    const context = buildContext()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await definition.deactivate!(context as any)

    expect(context.agent!.unregisterTool.mock.calls.map((call) => call[0]).sort()).toEqual([
      "click_text",
      "expand_element",
      "find_text",
      "get_app_state",
      "list_apps",
      "perform_action",
      "query_elements",
      "wait",
      "zoom",
    ])
  })

  it("survives missing context or agent", async () => {
    await expect(definition.deactivate!()).resolves.toBeUndefined()
    const context = buildContext({ withAgent: false })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(definition.deactivate!(context as any)).resolves.toBeUndefined()
  })
})
