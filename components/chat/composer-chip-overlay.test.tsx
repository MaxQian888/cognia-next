import { render } from "@testing-library/react"
import { createRef } from "react"
import { ComposerChipOverlay } from "./composer-chip-overlay"
import { parseSegments } from "@/lib/slash-commands/parse-segments"

const known = (n: string) => ["help", "model", "review"].includes(n)
const segs = (v: string) => parseSegments(v, known, { mentions: true })

describe("ComposerChipOverlay", () => {
  it("is aria-hidden and does not capture pointer events", () => {
    const { getByTestId } = render(<ComposerChipOverlay value="hi" segments={segs("hi")} />)
    const overlay = getByTestId("composer-chip-overlay")
    expect(overlay).toHaveAttribute("aria-hidden", "true")
    expect(overlay.className).toContain("pointer-events-none")
  })

  it("pills only the /command token, leaving args as plain text", () => {
    const value = "/model opus\n/review auth"
    const { container } = render(<ComposerChipOverlay value={value} segments={segs(value)} />)
    const pills = container.querySelectorAll('[data-chip="command"]')
    expect(pills).toHaveLength(2)
    // The chip wraps only "/model" / "/review" — args stay outside the pill.
    expect(pills[0].textContent).toBe("/model")
    expect(pills[1].textContent).toBe("/review")
    // No character is dropped — args still rendered (transparently) for height.
    expect(container.textContent).toBe("/model opus\n/review auth")
  })

  it("does not pill the args even when they contain slashes (/reset //// case)", () => {
    const value = "/review ////////"
    const { container } = render(<ComposerChipOverlay value={value} segments={segs(value)} />)
    const pills = container.querySelectorAll('[data-chip="command"]')
    expect(pills).toHaveLength(1)
    expect(pills[0].textContent).toBe("/review") // slashes are NOT in the chip
    expect(container.textContent).toBe("/review ////////")
  })

  it("renders no pills for plain prose", () => {
    const value = "just a normal message"
    const { container } = render(<ComposerChipOverlay value={value} segments={segs(value)} />)
    expect(container.querySelectorAll('[data-chip="command"]')).toHaveLength(0)
    // Still paints the text so the box height matches the textarea.
    expect(container.textContent).toContain("just a normal message")
  })

  it("pins the inner layer to the textarea's iOS-guard font size so pills don't drift", () => {
    // globals.css forces `textarea { font-size: max(16px,1rem) }` (unlayered),
    // overriding text-sm on the real textarea. The overlay must match exactly or
    // the pills drift further from the glyphs the more you type.
    const { getByTestId } = render(<ComposerChipOverlay value="/help" segments={segs("/help")} />)
    const layer = getByTestId("composer-chip-overlay").firstElementChild as HTMLElement
    expect(layer.style.fontSize).toBe("max(16px, 1rem)")
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

  it("keeps overlay text transparent so it never double-renders behind the textarea", () => {
    const value = "/model opus\nping @alice"
    const { container, getByTestId } = render(
      <ComposerChipOverlay value={value} segments={segs(value)} />
    )
    // The text layer is transparent; only pill backgrounds are visible.
    const layer = getByTestId("composer-chip-overlay").firstElementChild!
    expect(layer.className).toContain("text-transparent")
    // No pill span sets a visible text color (that would ghost over the textarea).
    for (const pill of container.querySelectorAll("[data-chip]")) {
      expect(pill.className).not.toMatch(/(?:^|\s)text-(primary|foreground|muted-foreground)/)
    }
    // The command pill carries the command token; full text is preserved overall.
    expect(container.querySelector('[data-chip="command"]')?.textContent).toBe("/model")
    expect(container.textContent).toBe("/model opus\nping @alice")
  })

  it("renders a pill for each @mention and keeps full coverage", () => {
    const value = "ping @alice on @lib/db"
    const { container } = render(<ComposerChipOverlay value={value} segments={segs(value)} />)
    const mentions = container.querySelectorAll('[data-chip="mention"]')
    expect(Array.from(mentions).map((m) => m.textContent)).toEqual(["@alice", "@lib/db"])
    expect(container.textContent).toBe("ping @alice on @lib/db")
  })

  it("does not paint a pill for an email address", () => {
    const value = "mail me at user@host.com"
    const { container } = render(<ComposerChipOverlay value={value} segments={segs(value)} />)
    expect(container.querySelectorAll('[data-chip="mention"]')).toHaveLength(0)
    expect(container.textContent).toContain("user@host.com")
  })
})
