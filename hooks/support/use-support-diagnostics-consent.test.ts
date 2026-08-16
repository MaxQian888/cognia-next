/** @jest-environment jsdom */

const trackEvent = jest.fn(async (..._args: unknown[]) => true)
jest.mock("@/lib/telemetry/events/track-event", () => ({
  trackEvent: (...args: unknown[]) => trackEvent(...args),
}))

import { act, renderHook } from "@testing-library/react"

import { SUPPORT_DIAGNOSTICS_STORAGE_KEY } from "@/lib/support-agent/context"

import { useSupportDiagnosticsConsent } from "./use-support-diagnostics-consent"

beforeEach(() => {
  localStorage.clear()
  trackEvent.mockClear()
})

it("defaults off, persists the flip, and reports which surface flipped it", () => {
  const { result } = renderHook(() => useSupportDiagnosticsConsent("settings"))
  expect(result.current.enabled).toBe(false)

  act(() => result.current.setEnabled(true))

  expect(result.current.enabled).toBe(true)
  expect(localStorage.getItem(SUPPORT_DIAGNOSTICS_STORAGE_KEY)).toBe("true")
  expect(trackEvent).toHaveBeenCalledWith("support.diagnostics.consent.changed", {
    enabled: true,
    surface: "settings",
  })
})

it("keeps two mounts in lock-step and follows other-window storage events", () => {
  const settings = renderHook(() => useSupportDiagnosticsConsent("settings"))
  const chat = renderHook(() => useSupportDiagnosticsConsent("chat"))

  act(() => settings.result.current.setEnabled(true))
  expect(chat.result.current.enabled).toBe(true)

  act(() => {
    localStorage.setItem(SUPPORT_DIAGNOSTICS_STORAGE_KEY, "false")
    window.dispatchEvent(new StorageEvent("storage", { key: SUPPORT_DIAGNOSTICS_STORAGE_KEY }))
  })
  expect(chat.result.current.enabled).toBe(false)
  expect(settings.result.current.enabled).toBe(false)

  act(() => {
    localStorage.setItem(SUPPORT_DIAGNOSTICS_STORAGE_KEY, "true")
    window.dispatchEvent(new StorageEvent("storage", { key: null }))
  })
  expect(chat.result.current.enabled).toBe(true)

  act(() => {
    localStorage.setItem(SUPPORT_DIAGNOSTICS_STORAGE_KEY, "false")
    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" }))
  })
  expect(chat.result.current.enabled).toBe(true)
})
