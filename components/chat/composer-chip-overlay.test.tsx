import { render } from "@testing-library/react"
import { createRef } from "react"
import { ComposerChipOverlay } from "./composer-chip-overlay"
import { parseSegments } from "@/lib/slash-commands/parse-segments"

const known = (n: string) => ["help", "model", "review"].includes(n)
const segs = (v: string) => parseSegments(v, known)

describe("ComposerChipOverlay", () => {
  it("is aria-hidden and does not capture pointer events", () => {
    const { getByTestId } = render(<ComposerChipOverlay value="hi" segments={segs("hi")} />)
    const overlay = getByTestId("composer-chip-overlay")
    expect(overlay).toHaveAttribute("aria-hidden", "true")
    expect(overlay.className).toContain("pointer-events-none")
  })

  it("renders a command pill for each command segment", () => {
    const value = "/model opus\n/review auth"
    const { container } = render(<ComposerChipOverlay value={value} segments={segs(value)} />)
    const pills = container.querySelectorAll('[data-chip="command"]')
    expect(pills).toHaveLength(2)
    expect(pills[0].textContent).toBe("/model opus")
    expect(pills[1].textContent).toBe("/review auth")
  })

  it("renders no pills for plain prose", () => {
    const value = "just a normal message"
    const { container } = render(<ComposerChipOverlay value={value} segments={segs(value)} />)
    expect(container.querySelectorAll('[data-chip="command"]')).toHaveLength(0)
    // Still paints the text so the box height matches the textarea.
    expect(container.textContent).toContain("just a normal message")
  })

  it("forwards a ref to the scroll-transform inner element", () => {
    const ref = createRef<HTMLDivElement>()
    render(<ComposerChipOverlay ref={ref} value="/help" segments={segs("/help")} />)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it("keeps prose between commands as transparent text (full coverage)", () => {
    const value = "/help\nplease explain"
    const { container } = render(<ComposerChipOverlay value={value} segments={segs(value)} />)
    expect(container.textContent).toContain("please explain")
    expect(container.querySelectorAll('[data-chip="command"]')).toHaveLength(1)
  })
})
