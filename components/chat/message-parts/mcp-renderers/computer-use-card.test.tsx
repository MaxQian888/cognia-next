import "@testing-library/jest-dom"
import { render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"

import { TooltipProvider } from "@/components/ui/tooltip"
import { ComputerUseCard } from "./computer-use-card"

// ImageBlock (used for the screenshot path) leans on shadcn's
// TooltipIconButton, which in turn requires a TooltipProvider in the
// React tree. App-level layout mounts one; we mirror that wrapper here
// so the test renders the same way production does.
function renderCard(p: ToolUIPart) {
  return render(
    <TooltipProvider>
      <ComputerUseCard part={p} />
    </TooltipProvider>
  )
}

// A tiny base64 PNG so the renderer's `data:image/png;base64,…` path
// actually decodes to something the browser/jsdom can mount without
// triggering load errors that confuse the test.
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

function part(overrides: Partial<ToolUIPart> = {}): ToolUIPart {
  return {
    type: "tool-computer_use",
    toolCallId: "tc-1",
    state: "output-available",
    input: {},
    output: undefined,
    ...overrides,
  } as ToolUIPart
}

describe("ComputerUseCard", () => {
  it("renders inline screenshot when output decodes as a base64 PNG result", () => {
    renderCard(
      part({
        input: { action: "screenshot" },
        output: JSON.stringify({
          ok: true,
          output: TINY_PNG_B64,
          display_width_px: 1,
          display_height_px: 1,
        }),
      })
    )
    const card = screen.getByTestId("computer-use-card-screenshot")
    expect(card).toBeInTheDocument()
    const img = card.querySelector("img")
    expect(img?.getAttribute("src")).toContain("data:image/png;base64,")
    expect(card).toHaveTextContent("1×1")
  })

  it("renders the cursor position payload as a coordinate", () => {
    renderCard(
      part({
        input: { action: "cursor_position" },
        output: JSON.stringify({ ok: true, cursor: { x: 100, y: 200 } }),
      })
    )
    const card = screen.getByTestId("computer-use-card-cursor")
    expect(card).toHaveTextContent("(100, 200)")
  })

  it("surfaces error payloads with a destructive badge", () => {
    renderCard(
      part({
        input: { action: "left_click", coordinate: [10, 20] },
        output: JSON.stringify({ ok: false, error: "USER_DECLINED" }),
      })
    )
    const card = screen.getByTestId("computer-use-card-error")
    expect(card).toHaveTextContent("USER_DECLINED")
  })

  it("falls back to the compact action chip for non-screenshot driving actions", () => {
    renderCard(
      part({
        input: { action: "left_click", coordinate: [10, 20] },
        output: JSON.stringify({ ok: true }),
      })
    )
    const card = screen.getByTestId("computer-use-card-action")
    expect(card).toHaveTextContent("(10, 20)")
    expect(card).toHaveTextContent("left_click")
  })
})
