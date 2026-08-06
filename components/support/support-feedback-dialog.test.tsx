/** @jest-environment jsdom */

const getDiagnostics = jest.fn(async () => ({ status: "ok" }))
const buildDraft = jest.fn(() => ({ filename: "feedback.md", markdown: "safe" }))
const downloadBlob = jest.fn()

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

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { SupportFeedbackDialog } from "./support-feedback-dialog"

it("does not generate or export feedback until the user confirms", async () => {
  render(<SupportFeedbackDialog />)
  fireEvent.click(screen.getByRole("button", { name: "trigger" }))
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
})
