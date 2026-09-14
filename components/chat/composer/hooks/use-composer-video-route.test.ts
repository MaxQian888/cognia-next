/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"

const settingsState: { settings: Record<string, unknown> } = { settings: {} }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: typeof settingsState) => unknown) => selector(settingsState),
}))
const runtimeState: { ref: { kind: string } } = { ref: { kind: "builtin" } }
jest.mock("@/stores/agent/agent-runtime-store", () => ({
  useRuntimeRefForSession: () => runtimeState.ref,
}))
const standalone = { value: false }
jest.mock("@/lib/runtime/standalone-mode", () => ({
  isStandaloneChatMode: () => standalone.value,
}))

import { useComposerVideoRoute } from "./use-composer-video-route"

const session = (overrides: Partial<ChatSession> = {}) =>
  ({ id: "s1", title: "t", ...overrides }) as ChatSession

beforeEach(() => {
  settingsState.settings = {}
  runtimeState.ref = { kind: "builtin" }
  standalone.value = false
})

describe("useComposerVideoRoute", () => {
  it("opens for a conversation pinned to a video-capable Gemini model", () => {
    const { result } = renderHook(() =>
      useComposerVideoRoute(session({ providerOverride: "google", model: "gemini-3.6-flash" }))
    )
    expect(result.current.verdict).toEqual({ available: true })
    expect(result.current.facts).toMatchObject({ protocol: "google", runtimeAdapter: "ai-sdk" })
  })

  it("falls back to the app defaults the model picker shows", () => {
    settingsState.settings = { defaultProvider: "google", defaultModel: "gemini-3.6-flash" }
    const { result } = renderHook(() => useComposerVideoRoute(session()))
    expect(result.current.verdict).toEqual({ available: true })
  })

  it("closes on the default Claude route", () => {
    const { result } = renderHook(() => useComposerVideoRoute(null))
    expect(result.current.verdict).toEqual({ available: false, reason: "runtime" })
  })

  it.each([
    [{ platformBinding: { conversationKey: "k" } }, "platform"],
    [{ kind: "team" }, "team"],
    [{ collaboration: { sessionId: "remote" } }, "shared"],
  ])("closes for %o", (overrides, reason) => {
    const { result } = renderHook(() =>
      useComposerVideoRoute(
        session({
          providerOverride: "google",
          model: "gemini-3.6-flash",
          ...(overrides as Partial<ChatSession>),
        })
      )
    )
    expect(result.current.verdict).toEqual({ available: false, reason })
  })

  it("closes on an external agent lane, in standalone mode and under auto routing", () => {
    const gemini = session({ providerOverride: "google", model: "gemini-3.6-flash" })

    runtimeState.ref = { kind: "external" }
    expect(renderHook(() => useComposerVideoRoute(gemini)).result.current.verdict).toMatchObject({
      reason: "external-agent",
    })

    runtimeState.ref = { kind: "builtin" }
    standalone.value = true
    expect(renderHook(() => useComposerVideoRoute(gemini)).result.current.verdict).toMatchObject({
      reason: "standalone",
    })

    standalone.value = false
    settingsState.settings = { autoRouting: { enabled: true } }
    expect(renderHook(() => useComposerVideoRoute(gemini)).result.current.verdict).toMatchObject({
      reason: "auto-routing",
    })
  })
})
