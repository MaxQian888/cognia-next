/**
 * Tests for the 12 desktop UI-automation node executors. The `desktop`
 * client is mocked at the module boundary so we assert against the
 * Tauri-bound surface (`desktop.screenshot`, `desktop.click`, …) without
 * needing an actual Tauri runtime.
 */

jest.mock("@/lib/automation/client", () => {
  const mocks = {
    capabilities: jest.fn(),
    getFocus: jest.fn(),
    readTree: jest.fn(),
    find: jest.fn(),
    screenshot: jest.fn(),
    click: jest.fn(),
    type: jest.fn(),
    paste: jest.fn(),
    keys: jest.fn(),
    invokePattern: jest.fn(),
    windowOp: jest.fn(),
    launchApp: jest.fn(),
    auditSnapshot: jest.fn(),
    settingsGet: jest.fn(),
    settingsSet: jest.fn(),
    killSwitch: jest.fn(),
  }
  return {
    desktop: mocks,
    defaultAutomationSettings: () => ({
      enabled: false,
      defaultTier: "off",
      whitelist: { processNames: [], windowTitlePatterns: [] },
      perSurface: {
        workflow: { tier: "off" },
        computerUse: { tier: "off" },
        mcp: { tier: "off" },
        plugin: { tier: "off", perPluginOverrides: {} },
      },
      audit: { retentionDays: 30, exportEnabled: true },
      redactScreenshots: false,
    }),
  }
})

import { desktop } from "@/lib/automation/client"
import "./desktop"
import { getExecutor } from "./registry"
import type { StepExecutionContext, TriggerEvent } from "@/types/workflow/visual"

const mocks = desktop as unknown as Record<string, jest.Mock>

function makeCtx(params: Record<string, unknown> = {}): StepExecutionContext {
  const controller = new AbortController()
  return {
    runId: "r1",
    workflowId: "w1",
    stepId: "s1",
    params,
    upstream: {},
    trigger: {
      kind: "trigger.manual",
      runId: "r1",
      workflowId: "w1",
      originAt: 0,
      payload: null,
    } as unknown as TriggerEvent,
    signal: controller.signal,
    log: () => {},
    resolveSecret: async () => undefined,
  }
}

beforeEach(() => {
  for (const m of Object.values(mocks)) {
    m.mockReset()
  }
})

describe("action.desktop.screenshot", () => {
  it("calls desktop.screenshot with default png format", async () => {
    mocks.screenshot.mockResolvedValueOnce({
      bytes: "AA==",
      width: 1,
      height: 1,
      capturedAt: 0,
      format: "png",
    })
    const exec = getExecutor("action.desktop.screenshot", 1)
    expect(exec).toBeDefined()
    const result = await exec!.execute(makeCtx({}))
    expect(mocks.screenshot).toHaveBeenCalledWith(
      { format: "png" },
      expect.objectContaining({ surface: "workflow" })
    )
    expect((result.output as Record<string, unknown>).format).toBe("png")
  })

  it("passes region through when supplied", async () => {
    mocks.screenshot.mockResolvedValueOnce({
      bytes: "",
      width: 10,
      height: 20,
      capturedAt: 0,
      format: "png",
    })
    const exec = getExecutor("action.desktop.screenshot", 1)!
    await exec.execute(makeCtx({ region: { x: 5, y: 6, width: 7, height: 8 } }))
    expect(mocks.screenshot.mock.calls[0][0]).toMatchObject({
      region: { x: 5, y: 6, width: 7, height: 8 },
    })
  })

  it("threads a per-node sandbox target into ctx.sandboxConnectionId", async () => {
    mocks.screenshot.mockResolvedValueOnce({
      bytes: "AA==",
      width: 1,
      height: 1,
      capturedAt: 0,
      format: "png",
    })
    const exec = getExecutor("action.desktop.screenshot", 1)!
    await exec.execute(makeCtx({ target: { connectionId: "conn-1" } }))
    expect(mocks.screenshot).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ surface: "workflow", sandboxConnectionId: "conn-1" })
    )
  })
})

describe("action.desktop.findElement", () => {
  it("forwards the locator and returns the ref", async () => {
    mocks.find.mockResolvedValueOnce(["abc"])
    const exec = getExecutor("action.desktop.findElement", 1)!
    const result = await exec.execute(makeCtx({ locator: { name: "OK", controlType: "button" } }))
    expect(mocks.find).toHaveBeenCalledWith(
      expect.objectContaining({ name: "OK", controlType: "button" }),
      expect.any(Object)
    )
    expect((result.output as Record<string, unknown>).elementRef).toEqual(["abc"])
  })
})

describe("action.desktop.readTree", () => {
  it("reads the desktop root when no element ref is provided", async () => {
    mocks.readTree.mockResolvedValueOnce([])
    const exec = getExecutor("action.desktop.readTree", 1)!
    await exec.execute(makeCtx({ maxDepth: 3 }))
    expect(mocks.readTree).toHaveBeenCalledWith(null, { maxDepth: 3 }, expect.any(Object))
  })

  it("forwards an element ref when supplied as string", async () => {
    mocks.readTree.mockResolvedValueOnce([])
    const exec = getExecutor("action.desktop.readTree", 1)!
    await exec.execute(makeCtx({ root: "xyz", maxDepth: 1 }))
    expect(mocks.readTree.mock.calls[0][0]).toEqual(["xyz"])
  })
})

describe("action.desktop.click", () => {
  it("clicks an element ref when supplied", async () => {
    mocks.click.mockResolvedValueOnce(undefined)
    const exec = getExecutor("action.desktop.click", 1)!
    await exec.execute(makeCtx({ elementRef: "abc" }))
    expect(mocks.click.mock.calls[0][0]).toEqual({ kind: "element", elementRef: ["abc"] })
  })

  it("falls back to x/y point when no element ref is given", async () => {
    mocks.click.mockResolvedValueOnce(undefined)
    const exec = getExecutor("action.desktop.click", 1)!
    await exec.execute(makeCtx({ x: 100, y: 200 }))
    expect(mocks.click.mock.calls[0][0]).toEqual({ kind: "point", x: 100, y: 200 })
  })

  it("propagates button + double options", async () => {
    mocks.click.mockResolvedValueOnce(undefined)
    const exec = getExecutor("action.desktop.click", 1)!
    await exec.execute(makeCtx({ x: 0, y: 0, button: "right", double: true }))
    expect(mocks.click.mock.calls[0][1]).toMatchObject({ button: "right", double: true })
  })
})

describe("action.desktop.type", () => {
  it("types text with optional delay + target", async () => {
    mocks.type.mockResolvedValueOnce(undefined)
    const exec = getExecutor("action.desktop.type", 1)!
    await exec.execute(makeCtx({ text: "hello", delayMs: 10, target: "abc" }))
    expect(mocks.type).toHaveBeenCalledWith(
      "hello",
      { delayMs: 10, target: ["abc"] },
      expect.any(Object)
    )
  })

  it("defaults to empty text + no target", async () => {
    mocks.type.mockResolvedValueOnce(undefined)
    const exec = getExecutor("action.desktop.type", 1)!
    await exec.execute(makeCtx({}))
    expect(mocks.type).toHaveBeenCalledWith(
      "",
      { delayMs: undefined, target: undefined },
      expect.any(Object)
    )
  })
})

describe("action.desktop.keys", () => {
  it("throws when chord is empty", async () => {
    const exec = getExecutor("action.desktop.keys", 1)!
    await expect(exec.execute(makeCtx({}))).rejects.toThrow(/chord/)
  })

  it("wraps the chord in KeyChord", async () => {
    mocks.keys.mockResolvedValueOnce(undefined)
    const exec = getExecutor("action.desktop.keys", 1)!
    await exec.execute(makeCtx({ chord: "ctrl+shift+t" }))
    expect(mocks.keys).toHaveBeenCalledWith(["ctrl+shift+t"], expect.any(Object))
  })
})

describe("action.desktop.paste", () => {
  it("throws when text is empty", async () => {
    const exec = getExecutor("action.desktop.paste", 1)!
    await expect(exec.execute(makeCtx({}))).rejects.toThrow(/text/)
  })

  it("forwards text with the workflow surface", async () => {
    mocks.paste.mockResolvedValueOnce(undefined)
    const exec = getExecutor("action.desktop.paste", 1)!
    const out = await exec.execute(makeCtx({ text: "hello world" }))
    expect(mocks.paste).toHaveBeenCalledWith(
      "hello world",
      expect.objectContaining({ surface: "workflow" })
    )
    expect(out).toEqual({ output: { pasted: true, chars: 11 } })
  })
})

describe("action.desktop.launchApp", () => {
  it("throws when app is empty", async () => {
    const exec = getExecutor("action.desktop.launchApp", 1)!
    await expect(exec.execute(makeCtx({}))).rejects.toThrow(/app/)
  })

  it("launches by default", async () => {
    mocks.launchApp.mockResolvedValueOnce(undefined)
    const exec = getExecutor("action.desktop.launchApp", 1)!
    const out = await exec.execute(makeCtx({ app: "notepad.exe" }))
    expect(mocks.launchApp).toHaveBeenCalledWith(
      "notepad.exe",
      "launch",
      expect.objectContaining({ surface: "workflow" })
    )
    expect(out).toEqual({ output: { app: "notepad.exe", action: "launch" } })
  })

  it("focus variant routes through", async () => {
    mocks.launchApp.mockResolvedValueOnce(undefined)
    const exec = getExecutor("action.desktop.launchApp", 1)!
    await exec.execute(makeCtx({ app: "notepad.exe", action: "focus" }))
    expect(mocks.launchApp).toHaveBeenCalledWith(
      "notepad.exe",
      "focus",
      expect.objectContaining({ surface: "workflow" })
    )
  })
})

describe("action.desktop.invokePattern", () => {
  it("throws when target is missing", async () => {
    const exec = getExecutor("action.desktop.invokePattern", 1)!
    await expect(exec.execute(makeCtx({}))).rejects.toThrow(/target/)
  })

  it("dispatches pattern + args", async () => {
    mocks.invokePattern.mockResolvedValueOnce({})
    const exec = getExecutor("action.desktop.invokePattern", 1)!
    await exec.execute(makeCtx({ target: "abc", pattern: "toggle", args: { state: "on" } }))
    expect(mocks.invokePattern).toHaveBeenCalledWith(
      ["abc"],
      "toggle",
      { state: "on" },
      expect.any(Object)
    )
  })
})

describe("action.desktop.windowFocus / windowClose / windowResize", () => {
  it("focus dispatches via desktop.windowOp", async () => {
    mocks.windowOp.mockResolvedValueOnce(undefined)
    const exec = getExecutor("action.desktop.windowFocus", 1)!
    await exec.execute(makeCtx({ target: "abc" }))
    expect(mocks.windowOp).toHaveBeenCalledWith(["abc"], { kind: "focus" }, expect.any(Object))
  })

  it("close dispatches via desktop.windowOp", async () => {
    mocks.windowOp.mockResolvedValueOnce(undefined)
    const exec = getExecutor("action.desktop.windowClose", 1)!
    await exec.execute(makeCtx({ target: "abc" }))
    expect(mocks.windowOp).toHaveBeenCalledWith(["abc"], { kind: "close" }, expect.any(Object))
  })

  it("resize requires a rect", async () => {
    const exec = getExecutor("action.desktop.windowResize", 1)!
    await expect(exec.execute(makeCtx({ target: "abc" }))).rejects.toThrow(/rect/)
  })

  it("resize dispatches windowOp with the rect", async () => {
    mocks.windowOp.mockResolvedValueOnce(undefined)
    const exec = getExecutor("action.desktop.windowResize", 1)!
    await exec.execute(makeCtx({ target: "abc", rect: { x: 0, y: 0, width: 800, height: 600 } }))
    expect(mocks.windowOp).toHaveBeenCalledWith(
      ["abc"],
      { kind: "resize", rect: { x: 0, y: 0, width: 800, height: 600 } },
      expect.any(Object)
    )
  })
})

describe("action.desktop.wait", () => {
  it("returns immediately when the element appears", async () => {
    mocks.find.mockResolvedValueOnce(["abc"])
    const exec = getExecutor("action.desktop.wait", 1)!
    const result = await exec.execute(
      makeCtx({ locator: { name: "OK" }, mode: "appear", timeoutMs: 1000, pollMs: 10 })
    )
    expect((result.output as Record<string, unknown>).present).toBe(true)
  })

  it("throws on timeout when no match", async () => {
    mocks.find.mockResolvedValue(null)
    const exec = getExecutor("action.desktop.wait", 1)!
    await expect(
      exec.execute(makeCtx({ locator: { name: "Missing" }, timeoutMs: 60, pollMs: 20 }))
    ).rejects.toThrow(/timed out/)
  })
})

describe("trigger.desktop.event", () => {
  it("echoes kinds + trigger payload", async () => {
    const exec = getExecutor("trigger.desktop.event", 1)!
    const result = await exec.execute(makeCtx({ kinds: ["focus-changed"] }))
    const out = result.output as Record<string, unknown>
    expect(out.kinds).toEqual(["focus-changed"])
    expect(out.firedAt).toBe(0)
  })
})
