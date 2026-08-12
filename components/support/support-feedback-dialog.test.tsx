/** @jest-environment jsdom */

const getDiagnostics = jest.fn(async () => ({ status: "ok" }))
const buildDraft = jest.fn((..._args: unknown[]) => ({ filename: "feedback.md", markdown: "safe" }))
const downloadBlob = jest.fn((..._args: unknown[]) => undefined)
const trackEvent = jest.fn(async (..._args: unknown[]) => true)

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/lib/native/local-runtime", () => ({
  getLocalRuntimeDiagnostics: () => getDiagnostics(),
}))
jest.mock("@/lib/support-agent/feedback", () => ({
  buildSupportFeedbackDraft: (...args: unknown[]) => buildDraft(...args),
}))
jest.mock("@/lib/files/download", () => ({
  downloadBlob: (...args: unknown[]) => downloadBlob(...args),
}))
jest.mock("@/lib/telemetry/events/track-event", () => ({
  trackEvent: (...args: unknown[]) => trackEvent(...args),
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { SupportFeedbackDialog } from "./support-feedback-dialog"

it("does not generate or export feedback until the user confirms", async () => {
  render(<SupportFeedbackDialog initialSummary="Prefilled from Support chat" />)
  fireEvent.click(screen.getByRole("button", { name: "trigger" }))
  expect(trackEvent).toHaveBeenCalledWith("support.feedback.draft.opened", {
    surface: "mobile",
  })
  expect(screen.getByRole("textbox", { name: "summary" })).toHaveValue(
    "Prefilled from Support chat"
  )
  fireEvent.change(screen.getByRole("textbox", { name: "summary" }), {
    target: { value: "Chat stopped" },
  })

  expect(getDiagnostics).not.toHaveBeenCalled()
  expect(buildDraft).not.toHaveBeenCalled()
  expect(downloadBlob).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole("button", { name: "confirmExport" }))
  await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), "feedback.md"))
  expect(buildDraft).toHaveBeenCalledWith(
    expect.objectContaining({ summary: "Chat stopped", diagnostics: { status: "ok" } })
  )
  expect(trackEvent).toHaveBeenCalledWith("support.feedback.draft.exported", {
    surface: "mobile",
  })
})
