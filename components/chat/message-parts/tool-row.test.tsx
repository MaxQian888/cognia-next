/**
 * @jest-environment jsdom
 */

import * as ReactForMocks from "react"
import { fireEvent, render, screen } from "@testing-library/react"

import {
  HOVER_REVEAL_FORBIDDEN_CLASSES,
  HOVER_REVEAL_REQUIRED_VARIANTS,
} from "@/lib/ui/hover-reveal"

import {
  InlineCopyButton,
  TOOL_ROW_SCROLL_TEXT_CLASS,
  ToolRowBlock,
  ToolRowShell,
  ToolStatusDot,
} from "./tool-row"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const copyMock = jest.fn(async () => true)
jest.mock("@/hooks/ui", () => ({
  useCopy: () => ({ copied: false, copy: copyMock }),
}))

describe("ToolStatusDot", () => {
  it("maps each tool state to a status colour", () => {
    const { container, rerender } = render(<ToolStatusDot status="output-available" />)
    expect(container.firstChild).toHaveClass("bg-green-600")

    rerender(<ToolStatusDot status="output-error" />)
    expect(container.firstChild).toHaveClass("bg-red-600")

    rerender(<ToolStatusDot status="output-denied" />)
    expect(container.firstChild).toHaveClass("bg-orange-600")
  })

  it("breathes while running — and for the group's aggregate running state", () => {
    const { container, rerender } = render(<ToolStatusDot status="input-available" />)
    expect(container.firstChild).toHaveClass("animate-pulse")

    rerender(<ToolStatusDot status="running" />)
    expect(container.firstChild).toHaveClass("animate-pulse")

    rerender(<ToolStatusDot status="output-available" />)
    expect(container.firstChild).not.toHaveClass("animate-pulse")
  })
})

describe("InlineCopyButton", () => {
  it("copies the value without letting the click reach the row toggle", () => {
    const onRowClick = jest.fn()
    render(
      ReactForMocks.createElement(
        "div",
        { onClick: onRowClick },
        ReactForMocks.createElement(InlineCopyButton, {
          value: "pnpm test",
          label: "copy",
          testId: "copy-btn",
        })
      )
    )
    fireEvent.click(screen.getByTestId("copy-btn"))
    expect(copyMock).toHaveBeenCalledWith("pnpm test")
    expect(onRowClick).not.toHaveBeenCalled()
  })
})

describe("ToolRowShell", () => {
  it("keeps the row actions reachable without a hover", () => {
    copyMock.mockClear()
    render(
      <ToolRowShell
        status="output-available"
        ariaLabel="row"
        testId="row"
        lead={<span>$</span>}
        actions={<InlineCopyButton value="ls -la" label="copy command" testId="row-copy" />}
      />
    )
    const button = screen.getByTestId("row-copy")
    const wrapper = button.parentElement
    for (const variant of HOVER_REVEAL_REQUIRED_VARIANTS.groupBase) {
      expect(wrapper).toHaveClass(variant)
    }
    expect(wrapper).toHaveClass("group-hover/trow:opacity-100")
    for (const forbidden of HOVER_REVEAL_FORBIDDEN_CLASSES) {
      expect(wrapper).not.toHaveClass(forbidden)
    }
    button.focus()
    expect(button).toHaveFocus()
    fireEvent.click(button)
    expect(copyMock).toHaveBeenCalledWith("ls -la")
  })

  it("leads with the status dot and the verb label by default", () => {
    render(
      <ToolRowShell
        status="output-available"
        ariaLabel="row"
        testId="row"
        lead={<span>READ</span>}
        target={<span>file.ts</span>}
      />
    )
    const inner = screen.getByTestId("row-toggle")
    expect(inner.firstElementChild).toHaveClass("rounded-full")
    expect(inner).toHaveTextContent("READfile.ts")
  })

  it("can drop the dot and the lead for rows whose target names them", () => {
    render(
      <ToolRowShell
        status="output-available"
        ariaLabel="row"
        testId="row"
        showDot={false}
        target={<span>Thought for 3 seconds</span>}
      />
    )
    const inner = screen.getByTestId("row-toggle")
    expect(inner.querySelector(".rounded-full")).toBeNull()
    expect(inner.textContent).toBe("Thought for 3 seconds")
  })
})

describe("ToolRowBlock", () => {
  it("renders the header label and the payload", () => {
    render(
      <ToolRowBlock label="stdout" testId="blk">
        <div>payload</div>
      </ToolRowBlock>
    )
    expect(screen.getByTestId("blk").textContent).toContain("stdout")
    expect(screen.getByTestId("blk").textContent).toContain("payload")
  })

  it("offers a copy button in the header when copyValue is set", () => {
    render(
      <ToolRowBlock label="stdout" copyValue="full output" testId="blk">
        <div>out</div>
      </ToolRowBlock>
    )
    fireEvent.click(screen.getByTestId("blk-copy"))
    expect(copyMock).toHaveBeenCalledWith("full output")
  })

  it("tints the block destructive in error mode", () => {
    render(
      <ToolRowBlock label="error" error testId="blk">
        <div>boom</div>
      </ToolRowBlock>
    )
    const block = screen.getByTestId("blk")
    expect(block.className).toContain("border-destructive/40")
    expect(block.querySelector(".border-b")?.className).toContain("text-destructive")
  })
})

describe("TOOL_ROW_SCROLL_TEXT_CLASS", () => {
  const classes = TOOL_ROW_SCROLL_TEXT_CLASS.split(" ")

  it("lets the text box shrink inside the flex row", () => {
    expect(classes).toContain("min-w-0")
  })

  it("keeps the ellipsis for fine pointers", () => {
    expect(classes).toContain("truncate")
  })

  it("scrolls sideways on touch, with no visible scrollbar in any engine", () => {
    expect(classes).toEqual(
      expect.arrayContaining([
        "pointer-coarse:overflow-x-auto",
        "pointer-coarse:text-clip",
        "[scrollbar-width:none]",
        "[&::-webkit-scrollbar]:hidden",
      ])
    )
  })
})
