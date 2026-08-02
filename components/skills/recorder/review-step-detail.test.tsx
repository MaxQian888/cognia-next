/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars && Object.keys(vars).length > 0 ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { RecordedStepView } from "@/lib/skills/recording/step-model"

import { ReviewStepDetail } from "./review-step-detail"

function view(patch: Partial<RecordedStepView> = {}): RecordedStepView {
  return {
    seq: 1,
    captured: { seq: 1, tsMs: 0, kind: "click", element: { name: "Export" } },
    manual: false,
    excluded: false,
    intent: null,
    verify: null,
    screenshotSelected: false,
    needsIntent: false,
    ...patch,
  }
}

function renderDetail(
  step: RecordedStepView | null,
  loadScreenshot: (assetId: string) => Promise<string | null> = jest.fn(async () => null)
) {
  const handlers = {
    onIntentChange: jest.fn(),
    onVerifyChange: jest.fn(),
    onScreenshotToggle: jest.fn(),
    onMove: jest.fn(),
    onRemoveManual: jest.fn(),
  }
  const utils = render(
    <ReviewStepDetail step={step} loadScreenshot={loadScreenshot} {...handlers} />
  )
  return { ...handlers, ...utils, loadScreenshot }
}

describe("empty state", () => {
  it("asks the user to pick a step", () => {
    renderDetail(null)
    expect(screen.getByText("review.selectStep")).toBeInTheDocument()
  })
})

describe("intent", () => {
  it("shows the intent the user wrote", () => {
    renderDetail(view({ intent: "Open the export dialog" }))
    expect(screen.getByLabelText("review.intent")).toHaveValue("Open the export dialog")
  })

  it("offers the derived description as the placeholder, not as a value", () => {
    // Pre-filling it would make every derived guess look like the user's words.
    renderDetail(view())
    const input = screen.getByLabelText("review.intent")
    expect(input).toHaveValue("")
    expect(input).toHaveAttribute("placeholder", "Export")
  })

  it("reports edits to the caller", async () => {
    const { onIntentChange } = renderDetail(view({ seq: 5 }))
    await userEvent.type(screen.getByLabelText("review.intent"), "G")
    expect(onIntentChange).toHaveBeenCalledWith(5, "G")
  })

  it("explains, and points at, a step the model cannot be told about", () => {
    renderDetail(view({ needsIntent: true }))
    const hint = screen.getByText("review.needsIntentHint")
    expect(hint).toBeInTheDocument()
    expect(screen.getByLabelText("review.intent")).toHaveAttribute("aria-describedby", hint.id)
  })

  it("has no hint when the step describes itself", () => {
    renderDetail(view())
    expect(screen.queryByText("review.needsIntentHint")).not.toBeInTheDocument()
    expect(screen.getByLabelText("review.intent")).not.toHaveAttribute("aria-describedby")
  })
})

describe("secret input", () => {
  it("says explicitly that the content was secret", () => {
    // Leaving the field blank would read as "nothing was typed" — a different
    // and wrong claim.
    renderDetail(view({ captured: { seq: 1, tsMs: 0, kind: "type", text: { kind: "sensitive" } } }))
    expect(screen.getByText("review.sensitive")).toBeInTheDocument()
  })

  it("says nothing of the sort for ordinary typed text", () => {
    renderDetail(
      view({ captured: { seq: 1, tsMs: 0, kind: "type", text: { kind: "text", value: "hi" } } })
    )
    expect(screen.queryByText("review.sensitive")).not.toBeInTheDocument()
  })
})

describe("verification note", () => {
  it("round-trips through the caller", async () => {
    const { onVerifyChange } = renderDetail(view({ seq: 2, verify: "" }))
    await userEvent.type(screen.getByLabelText("review.verify"), "O")
    expect(onVerifyChange).toHaveBeenCalledWith(2, "O")
  })
})

describe("screenshot", () => {
  it("loads the frame on demand and renders it inline", async () => {
    const loadScreenshot = jest.fn(async () => "QUJD")
    renderDetail(
      view({ captured: { seq: 1, tsMs: 0, kind: "click", assetId: "asset-1" } }),
      loadScreenshot
    )
    expect(loadScreenshot).toHaveBeenCalledWith("asset-1")
    await waitFor(() =>
      expect(screen.getByRole("presentation", { hidden: true })).toHaveAttribute(
        "src",
        "data:image/png;base64,QUJD"
      )
    )
  })

  it("does not try to read a frame for a step that has none", () => {
    const loadScreenshot = jest.fn(async () => null)
    renderDetail(view(), loadScreenshot)
    expect(loadScreenshot).not.toHaveBeenCalled()
    expect(screen.getByText("review.screenshotNone")).toBeInTheDocument()
  })

  it("reports the include/exclude choice", async () => {
    const { onScreenshotToggle } = renderDetail(
      view({ seq: 3, captured: { seq: 3, tsMs: 0, kind: "click", assetId: "asset-1" } })
    )
    await userEvent.click(screen.getByRole("checkbox"))
    expect(onScreenshotToggle).toHaveBeenCalledWith(3, true)
  })

  it("survives a frame it could not read", async () => {
    renderDetail(
      view({ captured: { seq: 1, tsMs: 0, kind: "click", assetId: "asset-1" } }),
      jest.fn(async () => null)
    )
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeInTheDocument())
    expect(screen.queryByRole("presentation", { hidden: true })).not.toBeInTheDocument()
  })
})

describe("ordering and manual steps", () => {
  it("moves a step up or down", async () => {
    const { onMove } = renderDetail(view({ seq: 4 }))
    await userEvent.click(screen.getByRole("button", { name: "review.moveUp" }))
    await userEvent.click(screen.getByRole("button", { name: "review.moveDown" }))
    expect(onMove).toHaveBeenNthCalledWith(1, 4, -1)
    expect(onMove).toHaveBeenNthCalledWith(2, 4, 1)
  })

  it("offers removal only for a manual step", async () => {
    renderDetail(view())
    expect(screen.queryByRole("button", { name: "review.manualRemove" })).not.toBeInTheDocument()

    const { onRemoveManual } = renderDetail(view({ seq: -1, manual: true, captured: null }))
    await userEvent.click(screen.getByRole("button", { name: "review.manualRemove" }))
    expect(onRemoveManual).toHaveBeenCalledWith(-1)
  })
})
