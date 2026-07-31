/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { RedactReviewSheet } from "./redact-review-sheet"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const PII_TEXT = "Reach me at john.doe@example.com or call 555-867-5309."

describe("<RedactReviewSheet />", () => {
  it("renders a redacted preview that strips the raw PII", () => {
    render(
      <RedactReviewSheet open onOpenChange={jest.fn()} text={PII_TEXT} onConfirm={jest.fn()} />
    )
    const preview = screen.getByTestId("twin-redact-preview")
    expect(preview.textContent).not.toContain("john.doe@example.com")
    // At least one redaction was detected.
    expect(Number(screen.getByTestId("twin-redact-count").textContent)).toBeGreaterThan(0)
  })

  it("sends the redacted text when 'send redacted' is tapped", async () => {
    const onConfirm = jest.fn()
    const onOpenChange = jest.fn()
    const user = userEvent.setup()
    render(
      <RedactReviewSheet
        open
        onOpenChange={onOpenChange}
        text={PII_TEXT}
        onConfirm={onConfirm}
      />
    )
    await user.click(screen.getByTestId("twin-redact-send-redacted"))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    const sent = onConfirm.mock.calls[0][0] as string
    expect(sent).not.toContain("john.doe@example.com")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("sends the original text verbatim when 'send original' is tapped", async () => {
    const onConfirm = jest.fn()
    const user = userEvent.setup()
    render(
      <RedactReviewSheet open onOpenChange={jest.fn()} text={PII_TEXT} onConfirm={onConfirm} />
    )
    await user.click(screen.getByTestId("twin-redact-send-original"))
    expect(onConfirm).toHaveBeenCalledWith(PII_TEXT)
  })

  it("dismisses on Android hardware back (popstate)", () => {
    const onOpenChange = jest.fn()
    render(
      <RedactReviewSheet open onOpenChange={onOpenChange} text={PII_TEXT} onConfirm={jest.fn()} />
    )
    window.dispatchEvent(new PopStateEvent("popstate"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("closes without confirming on cancel", async () => {
    const onConfirm = jest.fn()
    const onOpenChange = jest.fn()
    const user = userEvent.setup()
    render(
      <RedactReviewSheet open onOpenChange={onOpenChange} text={PII_TEXT} onConfirm={onConfirm} />
    )
    await user.click(screen.getByTestId("twin-redact-cancel"))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
