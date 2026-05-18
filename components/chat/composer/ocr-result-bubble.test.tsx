import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { OcrResultBubble } from "./ocr-result-bubble"
import type { OcrResult } from "@/lib/ocr/types"

const sample: OcrResult = {
  providerId: "mistral-ocr",
  pages: [
    { pageNumber: 1, markdown: "# Page 1", text: "Page 1" },
    { pageNumber: 2, markdown: "# Page 2", text: "Page 2" },
  ],
  combinedMarkdown: "# Page 1\n\n---\n\n# Page 2",
  combinedText: "Page 1\n\nPage 2",
  languages: ["en"],
  durationMs: 12,
  cached: false,
}

describe("OcrResultBubble", () => {
  it("does not render content when closed", () => {
    render(<OcrResultBubble open={false} onOpenChange={() => {}} result={sample} />)
    expect(screen.queryByTestId("ocr-page-1")).not.toBeInTheDocument()
  })

  it("renders per-page Markdown when open", () => {
    render(<OcrResultBubble open={true} onOpenChange={() => {}} result={sample} />)
    expect(screen.getByTestId("ocr-page-1")).toHaveTextContent("Page 1")
    expect(screen.getByTestId("ocr-page-2")).toHaveTextContent("Page 2")
  })

  it("shows the empty-state message when result has no pages", () => {
    render(
      <OcrResultBubble
        open={true}
        onOpenChange={() => {}}
        result={{ ...sample, pages: [], combinedMarkdown: "", combinedText: "" }}
      />
    )
    expect(screen.getByText(/no text/i)).toBeInTheDocument()
  })

  it("invokes onCopy with the combined markdown when the copy button is clicked", async () => {
    const user = userEvent.setup()
    const onCopy = jest.fn()
    render(<OcrResultBubble open={true} onOpenChange={() => {}} result={sample} onCopy={onCopy} />)
    await user.click(screen.getByRole("button", { name: /copy all/i }))
    expect(onCopy).toHaveBeenCalledWith(sample.combinedMarkdown)
  })

  it("invokes onCopyPage with the page number and text", async () => {
    const user = userEvent.setup()
    const onCopyPage = jest.fn()
    render(
      <OcrResultBubble
        open={true}
        onOpenChange={() => {}}
        result={sample}
        onCopyPage={onCopyPage}
      />
    )
    const buttons = screen.getAllByRole("button", { name: /copy page/i })
    await user.click(buttons[0]!)
    expect(onCopyPage).toHaveBeenCalledWith(1, "Page 1")
  })

  it("renders null result without crashing", () => {
    render(<OcrResultBubble open={true} onOpenChange={() => {}} result={null} />)
    expect(screen.getByText(/no text/i)).toBeInTheDocument()
  })
})
