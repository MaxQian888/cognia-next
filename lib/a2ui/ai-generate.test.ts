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
import { A2UI_CREATE_APP_PROMPT, A2UI_EDIT_APP_PROMPT } from "./generate-prompts"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { __resetPromptVerdictsForTests } from "@/lib/prompts/resolve"
import { hasNoLeakingPii } from "@cognia/redact"
import { isTauri } from "@/lib/tauri"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import { runAndCaptureAssistantReply } from "@/lib/claude/run-and-capture"
import { resolveSendOptions } from "@/lib/claude/build-options"
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

  it("forwards a valid computed map on create and data updates, and refuses an invalid one", () => {
    const total = { op: "add", args: [{ path: "/a" }, 1] }
    expect(
      toolCallToDispatch("mcp__a2ui-bridge__a2ui_create_surface", {
        surfaceId: "s",
        computed: { "/total": total },
      })
    ).toMatchObject({ computed: { "/total": total } })
    expect(
      toolCallToDispatch("mcp__a2ui-bridge__a2ui_data_model_update", {
        surfaceId: "s",
        data: {},
        computed: { "/total": null },
      })
    ).toMatchObject({ computed: { "/total": null } })
    expect(
      toolCallToDispatch("mcp__a2ui-bridge__a2ui_create_surface", {
        surfaceId: "s",
        computed: { "/total": { op: "eval", args: ["1"] } },
      })
    ).toBeNull()
    expect(
      toolCallToDispatch("mcp__a2ui-bridge__a2ui_create_surface", {
        surfaceId: "s",
        computed: { "/total": null },
      })
    ).toBeNull()
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
    expect(messages[0]).not.toHaveProperty("computed")
  })

  it("carries a valid computed map onto createSurface and drops an invalid one", () => {
    const base = { components: { root: { id: "root" } }, dataModel: {}, rootId: "root" }
    const total = { op: "add", args: [{ path: "/a" }, 1] }
    expect(
      segmentToMessages("canvas", { ...base, computed: { "/total": total } })[0]
    ).toMatchObject({ computed: { "/total": total } })
    expect(
      segmentToMessages("canvas", { ...base, computed: { "/total": { op: "eval" } } })[0]
    ).not.toHaveProperty("computed")
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

  it("leaves the resolver session untouched when no overrides are supplied", async () => {
    mockRun.mockResolvedValue(capturedResult())
    jest.mocked(resolveSendOptions).mockClear()
    await generateA2UIApp({ instruction: "x", mode: "create", surfaceId: "canvas-1" })

    const session = jest.mocked(resolveSendOptions).mock.calls[0][0].session as unknown as Record<
      string,
      unknown
    >
    // Absent overrides must not appear as explicit `undefined` keys — the
    // session literal stays exactly what it was before overrides existed.
    expect(Object.keys(session).sort()).toEqual(["a2uiEnabled", "id"])
  })

  it("folds the per-generation overrides onto the resolver session", async () => {
    mockRun.mockResolvedValue(capturedResult())
    jest.mocked(resolveSendOptions).mockClear()
    await generateA2UIApp({
      instruction: "x",
      mode: "create",
      surfaceId: "canvas-1",
      characterId: "char_9",
      model: "gpt-5",
      providerOverride: "openai",
    })

    // These are the exact fields `resolveSendOptions` reads off a ChatSession,
    // so the hub composer's choices resolve the same way a chat session's do.
    expect(jest.mocked(resolveSendOptions).mock.calls[0][0].session).toEqual(
      expect.objectContaining({
        a2uiEnabled: true,
        characterId: "char_9",
        model: "gpt-5",
        providerOverride: "openai",
      })
    )
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

describe("generation prompts", () => {
  afterEach(() => {
    __setPromptOverrideSnapshotForTests(null)
    __resetPromptVerdictsForTests()
  })

  const sentPrompt = () => mockRun.mock.calls[0][1]

  it("sends the shipped create instruction", async () => {
    mockRun.mockResolvedValue(capturedResult())
    await generateA2UIApp({ instruction: "a timer", mode: "create", surfaceId: "canvas-1" })
    expect(sentPrompt()).toBe(
      [
        "Build a complete, self-contained, interactive A2UI mini-app for this request: a timer",
        'Use the a2ui-bridge tools in this order: a2ui_create_surface with surfaceId "canvas-1" and surfaceType "inline"; then a2ui_update_components with the full component tree; then a2ui_data_model_update with the initial data model. Wire buttons and inputs so the app is usable.',
        "All user-facing labels, titles and copy MUST be in English.",
      ].join("\n\n")
    )
  })

  it("sends the shipped edit instruction, with and without the current tree", async () => {
    mockRun.mockResolvedValue(capturedResult())
    await generateA2UIApp({
      instruction: "make it red",
      mode: "edit",
      surfaceId: "canvas-1",
      language: "zh",
      currentComponents: [{ id: "root", component: "Column" }] as never,
    })
    const head = [
      'You are editing an existing A2UI mini-app (surfaceId "canvas-1").',
      'Apply the requested change using the a2ui-bridge tools: call a2ui_update_components (and a2ui_data_model_update if data changes) on surfaceId "canvas-1". Do NOT call a2ui_create_surface — the surface already exists. Emit only the components that change; leave the rest intact.',
    ]
    expect(sentPrompt()).toBe(
      [
        ...head,
        'Current components (JSON):\n[{"id":"root","component":"Column"}]',
        "Change request: make it red",
        "All user-facing labels, titles and copy MUST be in Chinese.",
      ].join("\n\n")
    )
    await generateA2UIApp({ instruction: "x", mode: "edit", surfaceId: "canvas-1" })
    expect(mockRun.mock.calls[1][1]).toBe(
      [
        ...head,
        "Change request: x",
        "All user-facing labels, titles and copy MUST be in English.",
      ].join("\n\n")
    )
  })

  it("sends the generating agent's published edit override", async () => {
    __setPromptOverrideSnapshotForTests(
      buildPromptOverrideSnapshot("test-db", [
        {
          bindingId: "pob",
          promptId: A2UI_EDIT_APP_PROMPT.id,
          scope: "agent",
          targetId: "char_9",
          revisionId: "por-a2ui-edit-agent",
          body: "Patch {{surfaceId}} via a2ui_update_components: {{instruction}}",
          contractVersion: A2UI_EDIT_APP_PROMPT.contractVersion,
        },
        {
          bindingId: "pob-2",
          promptId: A2UI_CREATE_APP_PROMPT.id,
          scope: "account",
          targetId: "",
          revisionId: "por-a2ui-create-account",
          body: "Make {{instruction}} on {{surfaceId}} with a2ui_create_surface then a2ui_update_components.",
          contractVersion: A2UI_CREATE_APP_PROMPT.contractVersion,
        },
      ])
    )
    mockRun.mockResolvedValue(capturedResult())
    await generateA2UIApp({
      instruction: "make it red",
      mode: "edit",
      surfaceId: "canvas-1",
      characterId: "char_9",
    })
    expect(sentPrompt()).toBe("Patch canvas-1 via a2ui_update_components: make it red")
    await generateA2UIApp({ instruction: "a clock", mode: "create", surfaceId: "canvas-2" })
    expect(mockRun.mock.calls[1][1]).toBe(
      "Make a clock on canvas-2 with a2ui_create_surface then a2ui_update_components."
    )
  })

  it("does not start the turn when cancelled while the prompt resolves", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      generateA2UIApp({
        instruction: "x",
        mode: "edit",
        surfaceId: "canvas-1",
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ reason: "turn-failed" })
    expect(mockRun).not.toHaveBeenCalled()
  })
})
