/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { DiffBlock } from "./diff-block"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
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

const copy = jest.fn()
jest.mock("@/hooks/ui/use-copy", () => ({
  useCopy: () => ({ copied: false, copy }),
}))
jest.mock("@cognia/logging", () => ({ loggers: { chat: {} } }))

const SAMPLE = ["@@ -1,2 +1,2 @@", " context", "-const a = 1", "+const a = 2"].join("\n")

describe("DiffBlock", () => {
  it("renders add/remove counts from the parsed diff", () => {
    render(<DiffBlock content={SAMPLE} />)
    // one addition + one deletion
    expect(screen.getByText("1", { selector: ".text-green-600" })).toBeInTheDocument()
    expect(screen.getByText("1", { selector: ".text-red-600" })).toBeInTheDocument()
  })

  it("highlights the intraline changed run on a remove→add pair (unified view)", () => {
    render(<DiffBlock content={SAMPLE} />)
    const intraline = screen.getAllByTestId("diff-intraline")
    // "1" removed, "2" added
    expect(intraline.map((n) => n.textContent).sort()).toEqual(["1", "2"])
  })

  it("keeps the intraline highlight after switching to split view", () => {
    render(<DiffBlock content={SAMPLE} />)
    fireEvent.click(screen.getByLabelText("splitView"))
    expect(screen.getAllByTestId("diff-intraline").length).toBeGreaterThanOrEqual(2)
  })

  it("copies the raw diff content", () => {
    render(<DiffBlock content={SAMPLE} />)
    fireEvent.click(screen.getByLabelText("copy"))
    expect(copy).toHaveBeenCalledWith(SAMPLE)
  })

  it("does not emphasize a context-only diff", () => {
    render(<DiffBlock content={[" just context", " more context"].join("\n")} />)
    expect(screen.queryAllByTestId("diff-intraline")).toHaveLength(0)
  })
})
