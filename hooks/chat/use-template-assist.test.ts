/** @jest-environment jsdom */

// The assist hook is a thin state owner over `lib/ai/generation/template-assist`:
// running/op flags, error classification, abort. The lib is mocked wholesale —
// its own tests cover prompts and merging.

import { act, renderHook, waitFor } from "@testing-library/react"

const generateDraftMock = jest.fn()
const improveBodyMock = jest.fn()
const suggestParamsMock = jest.fn()
const applySuggestionsMock = jest.fn((_b: unknown, _e: unknown, _s: unknown) => "merged")
jest.mock("@/lib/ai/generation/template-assist", () => ({
  generateTemplateDraft: (...a: unknown[]) => generateDraftMock(...a),
  improveTemplateBody: (...a: unknown[]) => improveBodyMock(...a),
  suggestTemplateParams: (...a: unknown[]) => suggestParamsMock(...a),
  applyParamSuggestions: (b: unknown, e: unknown, s: unknown) => applySuggestionsMock(b, e, s),
  TemplateAssistPiiBlockedError: class extends Error {
    readonly code = "pii_blocked"
    constructor() {
      super("blocked")
      this.name = "TemplateAssistPiiBlockedError"
    }
  },
}))
let settingsValue: { apiKey?: string } | null = null
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (sel: (s: { settings: unknown }) => unknown) =>
    sel({ settings: settingsValue }),
}))
const providerModelMock = jest.fn((..._a: unknown[]) => ({ id: "fallback-model" }))
jest.mock("@cognia/provider-core/core/client", () => ({
  getProviderModel: (...a: unknown[]) => providerModelMock(...a),
}))
jest.mock("@/lib/ai/provider-consumption", () => ({
  createFeatureProviderModel: jest.fn(() => ({ id: "feature-model" })),
}))
const resolveMock = jest.fn((): { kind: string; [key: string]: unknown } => ({
  kind: "unresolved",
}))
jest.mock("@/lib/ai/chat/resolve-standalone-provider", () => ({
  resolveStandaloneProvider: () => resolveMock(),
}))
jest.mock("@/lib/runtime/streaming-fetch", () => ({
  browserDirectHeaders: () => ({}),
  getStreamingFetch: () => undefined,
}))

import { useTemplateAssist } from "./use-template-assist"
import { TemplateAssistPiiBlockedError } from "@/lib/ai/generation/template-assist"

beforeEach(() => {
  generateDraftMock.mockReset()
  improveBodyMock.mockReset()
  suggestParamsMock.mockReset()
  applySuggestionsMock.mockClear()
  resolveMock.mockClear().mockReturnValue({ kind: "unresolved" })
  settingsValue = null
  providerModelMock.mockClear()
})

describe("useTemplateAssist", () => {
  it("generate resolves the draft and clears the run state", async () => {
    generateDraftMock.mockResolvedValue({ name: "N", body: "b" })
    const { result } = renderHook(() => useTemplateAssist())

    let draft: unknown
    await act(async () => {
      draft = await result.current.generate("a standup")
    })

    expect(draft).toEqual({ ok: true, value: { name: "N", body: "b" } })
    expect(result.current.running).toBe(false)
    expect(result.current.op).toBeNull()
    // No resolved provider -> the legacy single-key fallback model.
    expect(providerModelMock).toHaveBeenCalled()
  })

  it("improve carries the failure in the outcome and flags the error kind", async () => {
    improveBodyMock.mockRejectedValue(new Error("provider down"))
    const { result } = renderHook(() => useTemplateAssist())

    let out: unknown = "unset"
    await act(async () => {
      out = await result.current.improve("body")
    })

    expect(out).toEqual({ ok: false, kind: "failed", error: "provider down" })
    expect(result.current.running).toBe(false)
  })

  it("classifies a PII refusal distinctly from a provider failure", async () => {
    generateDraftMock.mockRejectedValue(new TemplateAssistPiiBlockedError())
    const { result } = renderHook(() => useTemplateAssist())

    let out: unknown = "unset"
    await act(async () => {
      out = await result.current.generate("x")
    })

    expect(out).toEqual({ ok: false, kind: "pii-blocked", error: "blocked" })
    expect(result.current.running).toBe(false)
  })

  it("suggest merges model output through applyParamSuggestions", async () => {
    suggestParamsMock.mockResolvedValue([{ id: "m" }])
    const { result } = renderHook(() => useTemplateAssist())

    let out: unknown
    await act(async () => {
      out = await result.current.suggest("body {{m}}", [])
    })

    expect(out).toEqual({ ok: true, value: "merged" })
    expect(suggestParamsMock).toHaveBeenCalledWith(expect.anything(), "body {{m}}", {
      abortSignal: expect.any(AbortSignal),
    })
    expect(applySuggestionsMock).toHaveBeenCalledWith("body {{m}}", [], [{ id: "m" }])
  })

  it("cancel aborts the in-flight call and returns to idle", async () => {
    let signalSeen: AbortSignal | undefined
    improveBodyMock.mockImplementation(
      (_m: unknown, _b: unknown, o?: { abortSignal?: AbortSignal }) => {
        signalSeen = o?.abortSignal
        return new Promise((resolve) => setTimeout(() => resolve("late"), 50))
      }
    )
    const { result } = renderHook(() => useTemplateAssist())

    let pending: Promise<unknown>
    act(() => {
      pending = result.current.improve("body")
    })
    expect(result.current.running).toBe(true)
    act(() => result.current.cancel())
    expect(signalSeen?.aborted).toBe(true)
    await act(async () => {
      await pending
    })
    await waitFor(() => expect(result.current.running).toBe(false))
  })

  it("uses the configured provider model when one resolves", async () => {
    resolveMock.mockReturnValue({ kind: "resolved", providerId: "p", protocol: "openai" })
    generateDraftMock.mockResolvedValue({ name: "N", body: "b" })
    const { result } = renderHook(() => useTemplateAssist())

    await act(async () => {
      await result.current.generate("x")
    })

    const { createFeatureProviderModel } = jest.requireMock("@/lib/ai/provider-consumption") as {
      createFeatureProviderModel: jest.Mock
    }
    expect(createFeatureProviderModel).toHaveBeenCalledWith(
      { kind: "resolved", providerId: "p", protocol: "openai" },
      expect.objectContaining({ headers: {} })
    )
    expect(providerModelMock).not.toHaveBeenCalled()
  })

  it("forwards an instruction to improve when one is given", async () => {
    improveBodyMock.mockResolvedValue("tighter")
    const { result } = renderHook(() => useTemplateAssist())

    await act(async () => {
      await result.current.improve("body", "be terse")
    })

    expect(improveBodyMock).toHaveBeenCalledWith(expect.anything(), "body", {
      instruction: "be terse",
      abortSignal: expect.any(AbortSignal),
    })
  })

  it("unmounting mid-run aborts the provider call", async () => {
    let signalSeen: AbortSignal | undefined
    improveBodyMock.mockImplementation(
      (_m: unknown, _b: unknown, o?: { abortSignal?: AbortSignal }) => {
        signalSeen = o?.abortSignal
        return new Promise(() => {})
      }
    )
    const { result, unmount } = renderHook(() => useTemplateAssist())

    act(() => {
      void result.current.improve("body")
    })
    expect(result.current.running).toBe(true)

    unmount()

    expect(signalSeen?.aborted).toBe(true)
  })

  it("a second run supersedes an in-flight one", async () => {
    const signals: (AbortSignal | undefined)[] = []
    improveBodyMock.mockImplementation(
      (_m: unknown, _b: unknown, o?: { abortSignal?: AbortSignal }) => {
        signals.push(o?.abortSignal)
        // Resolves AFTER being aborted — the abort check lands on the result.
        return new Promise((resolve) => setTimeout(() => resolve("stale"), 10))
      }
    )
    generateDraftMock.mockResolvedValue({ name: "N", body: "b" })
    const { result } = renderHook(() => useTemplateAssist())

    let stale: Promise<unknown>
    let fresh: Promise<unknown>
    act(() => {
      stale = result.current.improve("body")
    })
    act(() => {
      fresh = result.current.generate("x")
    })

    expect(signals[0]?.aborted).toBe(true)
    await act(async () => {
      // The superseded run reports nothing — no error, no result.
      expect(await stale).toBeNull()
      expect(await fresh).toEqual({ ok: true, value: { name: "N", body: "b" } })
    })
    expect(result.current.running).toBe(false)
    expect(result.current.op).toBeNull()
  })

  it("stringifies a non-Error rejection for the toast", async () => {
    improveBodyMock.mockRejectedValue("raw rejection")
    const { result } = renderHook(() => useTemplateAssist())

    let out: unknown = "unset"
    await act(async () => {
      out = await result.current.improve("body")
    })

    expect(out).toEqual({ ok: false, kind: "failed", error: "raw rejection" })
  })

  it("passes the legacy single key through to the fallback model", async () => {
    settingsValue = { apiKey: "sk-test" }
    generateDraftMock.mockResolvedValue({ name: "N", body: "b" })
    const { result } = renderHook(() => useTemplateAssist())

    await act(async () => {
      await result.current.generate("x")
    })

    expect(providerModelMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "anthropic", apiKey: "sk-test" })
    )
  })
})
