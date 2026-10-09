/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

import { useSettingsStore } from "@/stores/settings"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { resolveModelMeta } from "@/lib/ai/model-options"
import type { ChatSession } from "@cognia/agent-config-types"
import type { ActiveAgentModel } from "@/lib/ai/agent/external/session/session-models"

let mockAgent: { agentId: string | null; agentName: string | null } = {
  agentId: null,
  agentName: null,
}
jest.mock("@/hooks/agent/use-external-agent-models", () => ({
  useExternalAgentModels: () => ({ ...mockAgent, surface: null }),
}))
let mockActive: ActiveAgentModel = { modelId: undefined, model: undefined }
jest.mock("@/hooks/agent/use-external-agent-active-model", () => ({
  useExternalAgentActiveModel: () => mockActive,
}))
let mockRuntimeRef: { kind: string } = { kind: "builtin" }
jest.mock("@/stores/agent/agent-runtime-store", () => ({
  useRuntimeRefForSession: () => mockRuntimeRef,
}))
let mockProfileImages: string | undefined
jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: () => ({
    getAgentCapabilityProfile: () =>
      mockProfileImages ? { effective: { images: { level: mockProfileImages } } } : undefined,
  }),
}))
let mockHostTakesImages = true
jest.mock("@/lib/ai/agent/external/runtimes/remote/remote-host-configs", () => ({
  hostSupportsAttachmentTurns: () => mockHostTakesImages,
}))

import { externalImageInputVerdict, useComposerImageInput } from "./use-composer-image-input"

const session = (model: string, providerOverride: string) =>
  ({ id: "s", model, providerOverride }) as unknown as ChatSession

beforeEach(() => {
  mockAgent = { agentId: null, agentName: null }
  mockActive = { modelId: undefined, model: undefined }
  mockRuntimeRef = { kind: "builtin" }
  mockProfileImages = undefined
  mockHostTakesImages = true
  useSettingsStore.setState({ settings: {} } as never)
})

describe("externalImageInputVerdict", () => {
  const base = {
    agentName: "Pi",
    hostLane: false,
    hostTakesImages: true,
    agentImages: "native" as const,
    modelVision: true,
    modelName: "Flash",
  }

  it("accepts when the agent and its model can see images, or nothing says otherwise", () => {
    expect(externalImageInputVerdict(base)).toEqual({ accepted: true })
    expect(
      externalImageInputVerdict({ ...base, agentImages: "unknown", modelVision: undefined })
    ).toEqual({ accepted: true })
  })

  it("names an older Host first, then an agent with no image input, then the model", () => {
    expect(
      externalImageInputVerdict({
        ...base,
        hostLane: true,
        hostTakesImages: false,
        agentImages: "unsupported",
      })
    ).toEqual({ accepted: false, reason: "host-outdated", agentName: "Pi" })
    expect(
      externalImageInputVerdict({ ...base, agentImages: "unsupported", modelVision: false })
    ).toEqual({ accepted: false, reason: "agent-no-images", agentName: "Pi" })
    expect(externalImageInputVerdict({ ...base, modelVision: false })).toEqual({
      accepted: false,
      reason: "model-no-vision",
      modelName: "Flash",
      agentName: "Pi",
    })
  })

  it("does not blame a model it cannot name", () => {
    expect(
      externalImageInputVerdict({ ...base, modelVision: false, modelName: undefined })
    ).toEqual({ accepted: true })
  })
})

describe("useComposerImageInput", () => {
  it("accepts on an agent lane whose agent and model can see images", () => {
    mockAgent = { agentId: "pi", agentName: "Pi (native RPC)" }
    mockProfileImages = "native"
    mockActive = {
      modelId: "flash",
      model: { modelId: "flash", name: "Flash", capabilities: { vision: true } },
    }
    const { result } = renderHook(() => useComposerImageInput(null))
    expect(result.current).toEqual({ accepted: true })
  })

  it("says when the agent negotiated no image input", () => {
    mockAgent = { agentId: "acp", agentName: "Cline" }
    mockProfileImages = "unsupported"
    const { result } = renderHook(() => useComposerImageInput(null))
    expect(result.current).toEqual({
      accepted: false,
      reason: "agent-no-images",
      agentName: "Cline",
    })
  })

  it("falls back to the protocol's declared row before the agent connects", () => {
    mockAgent = { agentId: "aider", agentName: "Aider" }
    useExternalAgentStore.setState({
      agents: { aider: { id: "aider", name: "Aider", protocol: "aider-cli" } },
    } as never)
    const { result } = renderHook(() => useComposerImageInput(null))
    // Aider's adapter carries images (`images: native`), so nothing is predicted.
    expect(result.current).toEqual({ accepted: true })
  })

  it("names the agent's model when its catalog reports no vision", () => {
    mockAgent = { agentId: "pi", agentName: "Pi" }
    mockActive = {
      modelId: "deepseek/pro",
      model: { modelId: "deepseek/pro", name: "DeepSeek V4 Pro", capabilities: { vision: false } },
    }
    const { result } = renderHook(() => useComposerImageInput(null))
    expect(result.current).toEqual({
      accepted: false,
      reason: "model-no-vision",
      modelName: "DeepSeek V4 Pro",
      agentName: "Pi",
    })
  })

  it("reads a Cognia model's vision from the app's model metadata", () => {
    expect(resolveModelMeta("deepseek", "deepseek-v4-pro").supportsVision).toBe(false)
    mockAgent = { agentId: "pi", agentName: "Pi" }
    mockActive = {
      modelId: undefined,
      model: undefined,
      cognia: { providerId: "deepseek", modelId: "deepseek-v4-pro" },
    }
    const { result } = renderHook(() => useComposerImageInput(null))
    expect(result.current).toEqual({
      accepted: false,
      reason: "model-no-vision",
      modelName: "DeepSeek V4 Pro",
      agentName: "Pi",
    })
  })

  it("says a paired Host is too old to take images", () => {
    mockAgent = { agentId: "host-config", agentName: "Codex on Studio" }
    mockRuntimeRef = { kind: "host" }
    mockHostTakesImages = false
    const { result } = renderHook(() => useComposerImageInput(null))
    expect(result.current).toEqual({
      accepted: false,
      reason: "host-outdated",
      agentName: "Codex on Studio",
    })
    mockHostTakesImages = true
    const current = renderHook(() => useComposerImageInput(null))
    expect(current.result.current).toEqual({ accepted: true })
  })

  it("flags a built-in model whose catalog says it has no vision", () => {
    expect(resolveModelMeta("deepseek", "deepseek-v4-pro").supportsVision).toBe(false)
    const { result } = renderHook(() =>
      useComposerImageInput(session("deepseek-v4-pro", "deepseek"))
    )
    expect(result.current).toEqual({
      accepted: false,
      reason: "model-no-vision",
      modelName: "DeepSeek V4 Pro",
      agentName: null,
    })
  })

  it("accepts a model the catalog says reads images, or says nothing about", () => {
    const vision = renderHook(() => useComposerImageInput(session("claude-sonnet-5", "anthropic")))
    expect(vision.result.current).toEqual({ accepted: true })
    const unknown = renderHook(() => useComposerImageInput(session("mystery-model", "custom-x")))
    expect(unknown.result.current).toEqual({ accepted: true })
  })

  it("follows the app default when the conversation has no model of its own", () => {
    const { result } = renderHook(() => useComposerImageInput(null))
    expect(result.current.accepted).toBe(true)
    act(() => {
      useSettingsStore.setState({
        settings: { defaultModel: "deepseek-v4-pro", defaultProvider: "deepseek" },
      } as never)
    })
    expect(result.current.accepted).toBe(false)
  })
})
