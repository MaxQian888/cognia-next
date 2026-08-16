/** @jest-environment jsdom */

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
const getDiagnostics = jest.fn(async (): Promise<unknown> => ({
  status: "ok",
  health: { sidecar: { status: "ok" } },
}))
jest.mock("@/lib/native/local-runtime", () => ({
  getLocalRuntimeDiagnostics: () => getDiagnostics(),
}))
const trackEvent = jest.fn(async (..._args: unknown[]) => true)
jest.mock("@/lib/telemetry/events/track-event", () => ({
  trackEvent: (...args: unknown[]) => trackEvent(...args),
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { SUPPORT_DIAGNOSTICS_STORAGE_KEY } from "@/lib/support-agent/context"

import { SupportDiagnosticsConsent } from "./support-diagnostics-consent"

beforeEach(() => {
  localStorage.clear()
  getDiagnostics.mockClear()
  trackEvent.mockClear()
})

it("requires explicit consent and previews the exact payload only after opt-in", async () => {
  render(<SupportDiagnosticsConsent surface="settings" />)
  const toggle = screen.getByRole("switch", { name: "label" })
  expect(toggle).not.toBeChecked()
  expect(screen.getByRole("button", { name: "preview" })).toBeDisabled()

  fireEvent.click(toggle)

  expect(toggle).toBeChecked()
  expect(localStorage.getItem(SUPPORT_DIAGNOSTICS_STORAGE_KEY)).toBe("true")
  expect(trackEvent).toHaveBeenCalledWith("support.diagnostics.consent.changed", {
    enabled: true,
    surface: "settings",
  })

  fireEvent.click(screen.getByRole("button", { name: "preview" }))
  expect(await screen.findByText(/"sidecar"/)).toBeInTheDocument()
  expect(getDiagnostics).toHaveBeenCalledTimes(1)

  fireEvent.click(screen.getByRole("button", { name: "hidePreview" }))
  expect(screen.queryByText(/"sidecar"/)).not.toBeInTheDocument()
})

it("hides an open preview as soon as consent is withdrawn", async () => {
  localStorage.setItem(SUPPORT_DIAGNOSTICS_STORAGE_KEY, "true")
  render(<SupportDiagnosticsConsent surface="chat" />)
  fireEvent.click(screen.getByRole("button", { name: "preview" }))
  expect(await screen.findByText(/"sidecar"/)).toBeInTheDocument()

  fireEvent.click(screen.getByRole("switch", { name: "label" }))
  expect(screen.queryByText(/"sidecar"/)).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "preview" })).toBeDisabled()
})

it("falls back to the unavailable copy when the snapshot is empty or throws", async () => {
  localStorage.setItem(SUPPORT_DIAGNOSTICS_STORAGE_KEY, "true")
  getDiagnostics.mockResolvedValueOnce(null)
  const { unmount } = render(<SupportDiagnosticsConsent surface="chat" />)
  fireEvent.click(screen.getByRole("button", { name: "preview" }))
  expect(await screen.findByText("previewUnavailable")).toBeInTheDocument()
  unmount()

  getDiagnostics.mockRejectedValueOnce(new Error("ipc down"))
  render(<SupportDiagnosticsConsent surface="chat" />)
  fireEvent.click(screen.getByRole("button", { name: "preview" }))
  await waitFor(() => expect(screen.getByText("previewUnavailable")).toBeInTheDocument())
})
