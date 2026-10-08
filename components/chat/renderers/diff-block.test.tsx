/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, within } from "@testing-library/react"
import { DiffBlock } from "./diff-block"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

// TooltipIconButton needs a TooltipProvider; stub to a plain button.
jest.mock("@/components/chat/ui/tooltip-icon-button", () => ({
  TooltipIconButton: ({
    children,
    onClick,
    "aria-label": ariaLabel,
  }: {
    children: React.ReactNode
    onClick?: () => void
    "aria-label"?: string
  }) => (
    <button type="button" onClick={onClick} aria-label={ariaLabel}>
      {children}
    </button>
  ),
}))

// jsdom has no layout: render every virtual row.
const virtualCounts: number[] = []
jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => {
    virtualCounts.push(count)
    return {
      getVirtualItems: () =>
        Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 20 })),
      getTotalSize: () => count * 20,
      measureElement: jest.fn(),
      scrollToIndex: jest.fn(),
    }
  },
}))

const copy = jest.fn()
jest.mock("@/hooks/ui/use-copy", () => ({
  useCopy: () => ({ copied: false, copy }),
}))
jest.mock("@cognia/logging", () => ({ loggers: { chat: {} } }))

const SAMPLE = ["@@ -1,2 +1,2 @@", " context", "-const a = 1", "+const a = 2"].join("\n")

const MULTI = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-a",
  "+b",
  "diff --git a/src/new.ts b/src/new.ts",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,2 @@",
  "+one",
  "+two",
].join("\n")

beforeEach(() => {
  virtualCounts.length = 0
})

describe("DiffBlock", () => {
  it("renders add/remove counts from the parsed diff", () => {
    render(<DiffBlock content={SAMPLE} />)
    // Status tokens, not raw Tailwind hues (ADR-0218).
    expect(screen.getByText("1", { selector: ".text-success" })).toBeInTheDocument()
    expect(screen.getByText("1", { selector: ".text-destructive" })).toBeInTheDocument()
  })

  it("draws through the virtualized line view, hunk header and numbers included", () => {
    render(<DiffBlock content={SAMPLE} />)
    expect(screen.getByTestId("diff-block-lines")).toBeInTheDocument()
    expect(screen.getByTestId("line-diff-header")).toHaveTextContent("@@ -1,2 +1,2 @@")
    const lines = screen.getAllByTestId("line-diff-line")
    expect(lines.map((l) => l.getAttribute("data-type"))).toEqual(["unchanged", "removed", "added"])
    // One virtualizer for header + 3 lines.
    expect(virtualCounts.at(-1)).toBe(4)
  })

  it("highlights the intraline changed run on a remove→add pair", () => {
    render(<DiffBlock content={SAMPLE} />)
    const intraline = screen.getAllByTestId("line-diff-intraline")
    expect(intraline.map((n) => n.textContent).sort()).toEqual(["1", "2"])
  })

  it("switches to the side-by-side layout and keeps the emphasis", () => {
    render(<DiffBlock content={SAMPLE} />)
    fireEvent.click(screen.getByLabelText("splitView"))
    expect(screen.getByTestId("diff-block-lines")).toHaveAttribute("data-layout", "split")
    expect(screen.getAllByTestId("line-diff-pair")).toHaveLength(2)
    expect(screen.getAllByTestId("line-diff-intraline").length).toBeGreaterThanOrEqual(2)
  })

  it("copies the raw diff content", () => {
    render(<DiffBlock content={SAMPLE} />)
    fireEvent.click(screen.getByLabelText("copy"))
    expect(copy).toHaveBeenCalledWith(SAMPLE)
  })

  it("does not emphasize a context-only diff", () => {
    render(<DiffBlock content={[" just context", " more context"].join("\n")} />)
    expect(screen.queryAllByTestId("line-diff-intraline")).toHaveLength(0)
  })

  it("shows one section per file of a multi-file patch", () => {
    render(<DiffBlock content={MULTI} />)
    const sections = screen.getAllByTestId("diff-block-file")
    expect(sections).toHaveLength(2)
    expect(within(sections[0]).getByText("src/a.ts")).toBeInTheDocument()
    expect(sections[1]).toHaveAttribute("data-change", "added")
    expect(screen.getByText('fileCount:{"count":2}')).toBeInTheDocument()
  })

  it("names a single-file patch after its path", () => {
    render(<DiffBlock content={MULTI.split("\n").slice(0, 6).join("\n")} />)
    expect(screen.getByText("src/a.ts")).toBeInTheDocument()
    expect(screen.queryByRole("banner")).toBeNull()
  })

  it("falls back to the raw text when nothing parses as a diff", () => {
    render(<DiffBlock content="no diff here" />)
    expect(screen.getByTestId("diff-block-raw")).toHaveTextContent("no diff here")
  })

  it("draws in the shared frame whose toolbar follows the rich-controls setting", () => {
    const { container } = render(<DiffBlock content={SAMPLE} />)
    const frame = container.querySelector('[data-rich-block="diff"]')!
    expect(frame).toBeInTheDocument()
    const toolbar = frame.querySelector("[data-message-rich-control]")!
    expect(toolbar).toContainElement(screen.getByRole("button", { name: "copy" }))
    fireEvent.click(screen.getByRole("button", { name: "splitView" }))
    expect(container.querySelector(".bg-success\\/10, .bg-destructive\\/10")).toBeTruthy()
  })
})
