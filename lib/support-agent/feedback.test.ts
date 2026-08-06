jest.mock("@/lib/app-version", () => ({ APP_VERSION: "2.4.0" }))

import { buildSupportFeedbackDraft } from "./feedback"

it("creates a bounded, versioned feedback export", () => {
  const draft = buildSupportFeedbackDraft({
    summary: "The chat stopped",
    diagnostics: { status: "error", code: "SESSION_ENDED" },
    generatedAt: "2026-08-06T10:00:00.000Z",
  })
  expect(draft.filename).toBe("cognia-support-feedback-2026-08-06.md")
  expect(draft.markdown).toContain("App version: 2.4.0")
  expect(draft.markdown).toContain("SESSION_ENDED")
  expect(draft.markdown.length).toBeLessThan(15_000)
})
