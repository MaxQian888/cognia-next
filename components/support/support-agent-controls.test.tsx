/** @jest-environment jsdom */

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
const getDiagnostics = jest.fn(async () => ({ status: "ok", health: { sidecar: { status: "ok" } } }))
jest.mock("@/lib/native/local-runtime", () => ({
  getLocalRuntimeDiagnostics: () => getDiagnostics(),
}))
const trackEvent = jest.fn(async () => true)
jest.mock("@/lib/telemetry/events/track-event", () => ({
  trackEvent: (...args: unknown[]) => trackEvent(...args),
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { SupportAgentControls } from "./support-agent-controls"
import { SUPPORT_DIAGNOSTICS_STORAGE_KEY } from "@/lib/support-agent/context"

beforeEach(() => localStorage.clear())

it("requires explicit consent and previews the exact payload only after opt-in", async () => {
  render(<SupportAgentControls />)
  const toggle = screen.getByRole("switch", { name: "diagnostics" })
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
})
