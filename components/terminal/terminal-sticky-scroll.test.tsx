/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { TerminalStickyScroll } from "./terminal-sticky-scroll"

const base = {
  text: "$ npm run build",
  fontFamily: "monospace",
  fontSize: 13,
  background: "rgb(0,0,0)",
  foreground: "rgb(255,255,255)",
  onClick: jest.fn(),
}

beforeEach(() => jest.clearAllMocks())

describe("TerminalStickyScroll", () => {
  it("renders the pinned command line", () => {
    render(<TerminalStickyScroll {...base} />)
    expect(screen.getByTestId("terminal-sticky-scroll")).toHaveTextContent("$ npm run build")
  })

  it("renders nothing when the text is blank", () => {
    const { container } = render(<TerminalStickyScroll {...base} text="   " />)
    expect(container.firstChild).toBeNull()
  })

  it("scrolls back to the command on click", () => {
    const props = { ...base, onClick: jest.fn() }
    render(<TerminalStickyScroll {...props} />)
    fireEvent.mouseDown(screen.getByTestId("terminal-sticky-scroll"))
    expect(props.onClick).toHaveBeenCalledTimes(1)
  })

  it("applies the terminal theme colors", () => {
    render(<TerminalStickyScroll {...base} />)
    const el = screen.getByTestId("terminal-sticky-scroll")
    expect(el).toHaveStyle({ background: "rgb(0,0,0)", color: "rgb(255,255,255)" })
  })
})
