import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"

jest.mock("@cognia/redact", () => ({ hasNoLeakingPii: jest.fn(() => true) }))
jest.mock("@cognia/logging", () => ({
  loggers: { a2ui: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } },
}))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@/lib/platform/web-companion", () => ({ hasWebCompanionTarget: jest.fn(() => false) }))
jest.mock("@/lib/claude/build-options", () => ({ resolveSendOptions: jest.fn(async () => ({})) }))
jest.mock("@/lib/claude/run-and-capture", () => ({ runAndCaptureAssistantReply: jest.fn() }))
jest.mock("@/lib/a2ui/app-generator", () => ({
  generateAppFromDescription: jest.fn(() => ({
    id: "tmpl-1",
    name: "Template App",
    description: "",
    components: [{ id: "root", component: "Column" }],
    dataModel: { seeded: true },
    messages: [],
  })),
}))
jest.mock("@/stores/settings", () => ({ useSettingsStore: { getState: () => ({ settings: {} }) } }))
const processMessage = jest.fn()
jest.mock("@/stores/a2ui", () => ({ useA2UIStore: { getState: () => ({ processMessage }) } }))

import {
  generateA2UIApp,
  toolCallToDispatch,
  segmentToMessages,
  canReachModel,
  A2UIAiUnavailableError,
} from "./ai-generate"
import { hasNoLeakingPii } from "@cognia/redact"
import { isTauri } from "@/lib/tauri"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import { runAndCaptureAssistantReply } from "@/lib/claude/run-and-capture"
import { generateAppFromDescription } from "@/lib/a2ui/app-generator"

const mockPii = jest.mocked(hasNoLeakingPii)
const mockTauri = jest.mocked(isTauri)
const mockCompanion = jest.mocked(hasWebCompanionTarget)
const mockRun = jest.mocked(runAndCaptureAssistantReply)
const mockGen = jest.mocked(generateAppFromDescription)

function capturedResult(overrides?: Record<string, unknown>) {
  return {
    text: "",
    messageId: "m1",
    a2uiSurfaceOrder: ["model-sid"],
    a2uiSurfaces: {
      "model-sid": {
        components: {
          root: { id: "root", component: "Column" },
          c1: { id: "c1", component: "Text" },
        },
        dataModel: { greeting: "hi" },
        rootId: "root",
        surfaceType: "inline",
        title: "My App",
      },
    },
    ...overrides,
  } as Awaited<ReturnType<typeof runAndCaptureAssistantReply>>
}

beforeEach(() => {
  jest.clearAllMocks()
  mockPii.mockReturnValue(true)
  mockTauri.mockReturnValue(true)
  mockCompanion.mockReturnValue(false)
  mockGen.mockReturnValue({
    id: "tmpl-1",
    name: "Template App",
    description: "",
    components: [{ id: "root", component: "Column" }] as never,
    dataModel: { seeded: true },
    messages: [],
  })
})

describe("toolCallToDispatch", () => {
  it("ignores non-a2ui tool calls", () => {
    expect(toolCallToDispatch("mcp__other__foo", { surfaceId: "s" })).toBeNull()
  })

  it("returns null when no surfaceId and no override", () => {
    expect(toolCallToDispatch("mcp__a2ui-bridge__a2ui_update_components", {})).toBeNull()
  })

  it("maps create_surface with normalized surfaceType", () => {
    expect(
      toolCallToDispatch("mcp__a2ui-bridge__a2ui_create_surface", {
        surfaceId: "s",
        surfaceType: "bogus",
        title: "T",
      })
    ).toEqual({
      type: "createSurface",
      surfaceId: "s",
      surfaceType: "inline",
      title: "T",
      catalogId: undefined,
      widget: undefined,
    })
    expect(
      toolCallToDispatch("mcp__a2ui-bridge__a2ui_create_surface", {
        surfaceId: "s",
        surfaceType: "dialog",
      })
    ).toMatchObject({ surfaceType: "dialog" })
    expect(
      toolCallToDispatch("mcp__a2ui-bridge__a2ui_create_surface", {
        surfaceId: "s",
        surfaceType: "fullscreen",
      })
    ).toMatchObject({ surfaceType: "fullscreen" })
  })

  it("maps update_components and defaults missing components to []", () => {
    expect(
      toolCallToDispatch("mcp__a2ui-bridge__a2ui_update_components", {
        surfaceId: "s",
        components: [{ id: "a" }],
      })
    ).toEqual({ type: "updateComponents", surfaceId: "s", components: [{ id: "a" }] })
    expect(
      toolCallToDispatch("mcp__a2ui-bridge__a2ui_update_components", { surfaceId: "s" })
    ).toEqual({ type: "updateComponents", surfaceId: "s", components: [] })
  })

  it("maps data_model_update with merge default true and explicit false", () => {
    expect(
      toolCallToDispatch("mcp__a2ui-bridge__a2ui_data_model_update", {
        surfaceId: "s",
        data: { x: 1 },
      })
    ).toEqual({ type: "dataModelUpdate", surfaceId: "s", data: { x: 1 }, merge: true })
    expect(
      toolCallToDispatch("mcp__a2ui-bridge__a2ui_data_model_update", {
        surfaceId: "s",
        data: {},
        merge: false,
      })
    ).toMatchObject({ merge: false })
  })

  it("maps delete_surface and remaps to overrideSurfaceId", () => {
    expect(
      toolCallToDispatch("mcp__a2ui-bridge__a2ui_delete_surface", { surfaceId: "model" }, "canvas")
    ).toEqual({ type: "deleteSurface", surfaceId: "canvas" })
  })
})

describe("segmentToMessages", () => {
  it("converts the component map to an array and emits create→ready with merge:false", () => {
    const messages = segmentToMessages("canvas", {
      components: { root: { id: "root" }, c1: { id: "c1" } },
      dataModel: { a: 1 },
      rootId: "root",
      surfaceType: "panel",
      title: "T",
    })
    expect(messages).toHaveLength(4)
    expect(messages[0]).toMatchObject({
      type: "createSurface",
      surfaceId: "canvas",
      surfaceType: "panel",
    })
    expect(messages[1]).toEqual({
      type: "updateComponents",
      surfaceId: "canvas",
      components: [{ id: "root" }, { id: "c1" }],
    })
    expect(messages[2]).toEqual({
      type: "dataModelUpdate",
      surfaceId: "canvas",
      data: { a: 1 },
      merge: false,
    })
    expect(messages[3]).toEqual({ type: "surfaceReady", surfaceId: "canvas" })
  })
})

describe("canReachModel", () => {
  it("is true on tauri, true with companion, false when neither", () => {
    mockTauri.mockReturnValue(true)
    expect(canReachModel()).toBe(true)
    mockTauri.mockReturnValue(false)
    mockCompanion.mockReturnValue(true)
    expect(canReachModel()).toBe(true)
    mockCompanion.mockReturnValue(false)
    expect(canReachModel()).toBe(false)
  })
})

describe("generateA2UIApp — create", () => {
  it("returns the AI surface when the turn yields one", async () => {
    mockRun.mockResolvedValue(capturedResult())
    const result = await generateA2UIApp({
      instruction: "a budget tracker",
      mode: "create",
      surfaceId: "canvas-1",
    })
    expect(result.usedFallback).toBe(false)
    expect(result.surfaceId).toBe("canvas-1")
    expect(result.rootId).toBe("root")
    expect(result.title).toBe("My App")
    expect(result.components).toHaveLength(2)
    expect(mockGen).not.toHaveBeenCalled()
  })

  it("streams tool-call events onto the caller's surfaceId", async () => {
    const streamed: unknown[] = []
    mockRun.mockImplementation(async (_sid, _prompt, _opts, cap) => {
      cap?.onEvent?.({
        type: "tool-call",
        toolName: "mcp__a2ui-bridge__a2ui_update_components",
        input: { surfaceId: "model-sid", components: [{ id: "a" }] },
      } as CaptureStreamEvent)
      return capturedResult()
    })
    await generateA2UIApp({
      instruction: "x",
      mode: "create",
      surfaceId: "canvas-1",
      onDispatch: (m) => streamed.push(m),
    })
    expect(streamed).toEqual([
      { type: "updateComponents", surfaceId: "canvas-1", components: [{ id: "a" }] },
    ])
  })

  it("falls back to the template generator when no transport is reachable", async () => {
    mockTauri.mockReturnValue(false)
    mockCompanion.mockReturnValue(false)
    const result = await generateA2UIApp({ instruction: "计算器", mode: "create" })
    expect(result.usedFallback).toBe(true)
    expect(result.title).toBe("Template App")
    expect(mockRun).not.toHaveBeenCalled()
    expect(mockGen).toHaveBeenCalled()
  })

  it("falls back when the AI turn throws", async () => {
    mockRun.mockRejectedValue(new Error("send_failed"))
    const result = await generateA2UIApp({ instruction: "x", mode: "create" })
    expect(result.usedFallback).toBe(true)
  })

  it("falls back when the AI turn produces no surface", async () => {
    mockRun.mockResolvedValue(capturedResult({ a2uiSurfaceOrder: [], a2uiSurfaces: {} }))
    const result = await generateA2UIApp({ instruction: "x", mode: "create" })
    expect(result.usedFallback).toBe(true)
  })

  it("falls back (no send) when the PII gate blocks the prompt", async () => {
    mockPii.mockReturnValue(false)
    const result = await generateA2UIApp({ instruction: "x", mode: "create" })
    expect(result.usedFallback).toBe(true)
    expect(mockRun).not.toHaveBeenCalled()
  })
})

describe("generateA2UIApp — edit", () => {
  it("applies the AI surface when the turn yields one", async () => {
    mockRun.mockResolvedValue(capturedResult())
    const result = await generateA2UIApp({
      instruction: "make it red",
      mode: "edit",
      surfaceId: "canvas-1",
    })
    expect(result.usedFallback).toBe(false)
    expect(result.components).toHaveLength(2)
  })

  it("throws (never rebuilds) when no transport is reachable", async () => {
    mockTauri.mockReturnValue(false)
    mockCompanion.mockReturnValue(false)
    await expect(
      generateA2UIApp({ instruction: "x", mode: "edit", surfaceId: "canvas-1" })
    ).rejects.toMatchObject({ name: "A2UIAiUnavailableError", reason: "no-transport" })
    expect(mockGen).not.toHaveBeenCalled()
  })

  it("throws pii-blocked when the gate blocks an edit", async () => {
    mockPii.mockReturnValue(false)
    await expect(
      generateA2UIApp({ instruction: "x", mode: "edit", surfaceId: "canvas-1" })
    ).rejects.toMatchObject({ reason: "pii-blocked" })
  })

  it("throws turn-failed when the AI turn throws", async () => {
    mockRun.mockRejectedValue(new Error("boom"))
    await expect(
      generateA2UIApp({ instruction: "x", mode: "edit", surfaceId: "canvas-1" })
    ).rejects.toBeInstanceOf(A2UIAiUnavailableError)
  })

  it("throws empty when the turn yields no surface", async () => {
    mockRun.mockResolvedValue(capturedResult({ a2uiSurfaceOrder: [], a2uiSurfaces: {} }))
    await expect(
      generateA2UIApp({ instruction: "x", mode: "edit", surfaceId: "canvas-1" })
    ).rejects.toMatchObject({ reason: "empty" })
  })
})
