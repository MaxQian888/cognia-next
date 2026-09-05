import { render, screen } from "@testing-library/react"
import type { DiffLine } from "@web/content/demo-task"
import { DiffView } from "./diff-view"

const LINES: DiffLine[] = [
  { kind: "context", text: "const a = 1" },
  { kind: "remove", text: "return round(x)" },
  { kind: "add", text: "return roundToMinorUnits(x, currency)" },
]

function renderDiff(props: Partial<React.ComponentProps<typeof DiffView>> = {}) {
  return render(
    <DiffView
      path="src/checkout/total.ts"
      hunk="@@ -18,9 +18,11 @@"
      lines={LINES}
      label="Change under review"
      {...props}
    />
  )
}

describe("DiffView", () => {
  it("names the file and the hunk", () => {
    renderDiff()
    expect(screen.getByText("src/checkout/total.ts")).toBeInTheDocument()
    expect(screen.getByText("@@ -18,9 +18,11 @@")).toBeInTheDocument()
  })

  it("renders every line", () => {
    renderDiff()
    for (const line of LINES) {
      expect(screen.getByText(line.text)).toBeInTheDocument()
    }
  })

  it("labels the line list for assistive technology", () => {
    renderDiff()
    expect(screen.getByRole("list", { name: "Change under review" })).toBeInTheDocument()
  })

  it("marks added and removed lines with a glyph, not only a tint", () => {
    const { container } = renderDiff()
    const marks = Array.from(container.querySelectorAll("[aria-hidden]")).map((n) => n.textContent)
    expect(marks).toContain("+")
    expect(marks).toContain("−")
  })

  it("hides the gutter marks from assistive technology, since the words carry the state", () => {
    const { container } = renderDiff()
    for (const mark of container.querySelectorAll("li > span:first-child")) {
      expect(mark).toHaveAttribute("aria-hidden")
    }
  })

  it("strikes removed lines so the distinction survives without colour", () => {
    const { container } = renderDiff()
    expect(container.querySelector(".line-through")).toBeInTheDocument()
  })

  it("truncates to the limit for the compact dock rendering", () => {
    renderDiff({ limit: 2 })
    expect(screen.getByText("const a = 1")).toBeInTheDocument()
    expect(screen.queryByText("return roundToMinorUnits(x, currency)")).toBeNull()
  })

  it("renders every line when no limit is given", () => {
    const { container } = renderDiff()
    expect(container.querySelectorAll("li")).toHaveLength(3)
  })

  it("sits on the graphite execution substrate in both themes", () => {
    const { container } = renderDiff()
    expect(container.querySelector(".bg-graphite")).toBeInTheDocument()
  })

  it("passes a layout class through", () => {
    const { container } = renderDiff({ className: "my-class" })
    expect(container.querySelector(".my-class")).toBeInTheDocument()
  })

  it("staggers the lines' arrival only when asked, in document order", () => {
    const { container } = renderDiff({ reveal: true })
    const delays = [...container.querySelectorAll("[data-reveal-line]")].map(
      (line) => (line as HTMLElement).style.animationDelay
    )
    expect(delays).toEqual(["0ms", "90ms", "180ms"])
  })

  it("arrives all at once by default", () => {
    const { container } = renderDiff()
    expect(container.querySelector("[data-reveal-line]")).toBeNull()
  })
})
