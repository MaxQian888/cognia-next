import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { OcrMenu, isOcrEligible } from "./ocr-menu"

describe("isOcrEligible", () => {
  it.each([
    ["image/png", true],
    ["image/jpeg", true],
    ["application/pdf", true],
    ["text/plain", false],
    ["", false],
    [undefined, false],
    [null, false],
  ])("returns %s for media type %s", (mediaType, expected) => {
    expect(isOcrEligible(mediaType as string | undefined | null)).toBe(expected)
  })
})

describe("OcrMenu", () => {
  it("renders nothing for unsupported media types", () => {
    const { container } = render(
      <OcrMenu attachmentId="att_1" mediaType="text/plain" onSelect={() => {}} />
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders a trigger for images", () => {
    render(<OcrMenu attachmentId="att_1" mediaType="image/png" onSelect={() => {}} />)
    expect(screen.getByTestId("ocr-menu-trigger")).toBeInTheDocument()
  })

  it("fires onSelect with the correct action and attachmentId", async () => {
    const user = userEvent.setup()
    const onSelect = jest.fn()
    render(<OcrMenu attachmentId="att_1" mediaType="image/png" onSelect={onSelect} />)
    await user.click(screen.getByTestId("ocr-menu-trigger"))
    const items = await screen.findAllByRole("menuitem")
    expect(items.length).toBe(2)
    await user.click(items[0]!)
    expect(onSelect).toHaveBeenCalledWith("extract-to-input", "att_1")
  })

  it("fires onSelect for the view-result item", async () => {
    const user = userEvent.setup()
    const onSelect = jest.fn()
    render(<OcrMenu attachmentId="att_1" mediaType="application/pdf" onSelect={onSelect} />)
    await user.click(screen.getByTestId("ocr-menu-trigger"))
    const items = await screen.findAllByRole("menuitem")
    await user.click(items[1]!)
    expect(onSelect).toHaveBeenCalledWith("view-result", "att_1")
  })

  it("disables the trigger when busy", () => {
    render(<OcrMenu attachmentId="att_1" mediaType="image/png" onSelect={() => {}} disabled />)
    expect(screen.getByTestId("ocr-menu-trigger")).toBeDisabled()
  })
})
