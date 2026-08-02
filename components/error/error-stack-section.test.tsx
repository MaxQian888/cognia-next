import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ErrorStackSection, stripStackHeadline, type ErrorStackCopy } from "./error-stack-section"

const copy: ErrorStackCopy = {
  title: "Error details",
  showStack: "Show stack trace",
  hideStack: "Hide stack trace",
}

const STACK =
  "TypeError: GROUP_HEADING_CLASS is not defined\n" +
  "    at ArtifactList (artifact-list.tsx:206:31)\n" +
  "    at renderWithHooks (react-dom.js:15012:18)"

function renderSection(error: { message?: string; stack?: string }) {
  return render(<ErrorStackSection error={error} copy={copy} />)
}

describe("stripStackHeadline", () => {
  it("drops the leading `Name: message` line the section already renders", () => {
    expect(stripStackHeadline(STACK, "GROUP_HEADING_CLASS is not defined")).toBe(
      "    at ArtifactList (artifact-list.tsx:206:31)\n" +
        "    at renderWithHooks (react-dom.js:15012:18)"
    )
  })

  it("keeps the stack intact when the first line is already a frame", () => {
    const frames = "at foo (a.ts:1:1)\nat bar (b.ts:2:2)"
    expect(stripStackHeadline(frames, "boom")).toBe(frames)
  })

  it("keeps the stack intact when the headline does not repeat the message", () => {
    const stack = "Something else entirely\n    at foo (a.ts:1:1)"
    expect(stripStackHeadline(stack, "boom")).toBe(stack)
  })
})

describe("ErrorStackSection", () => {
  it("renders the section label and the error message", () => {
    renderSection({ message: "GROUP_HEADING_CLASS is not defined" })
    expect(screen.getByText("Error details")).toBeInTheDocument()
    expect(screen.getByTestId("error-stack-message")).toHaveTextContent(
      "GROUP_HEADING_CLASS is not defined"
    )
  })

  it("falls back to an em-dash when the error carries no message", () => {
    renderSection({})
    expect(screen.getByTestId("error-stack-message")).toHaveTextContent("—")
  })

  it("hides the disclosure entirely when there is no stack", () => {
    renderSection({ message: "boom" })
    expect(screen.queryByTestId("error-stack-toggle")).toBeNull()
    expect(screen.queryByTestId("error-stack-trace")).toBeNull()
  })

  it("expands and collapses the trace, flipping the toggle label", async () => {
    renderSection({ message: "GROUP_HEADING_CLASS is not defined", stack: STACK })
    const toggle = screen.getByTestId("error-stack-toggle")
    expect(toggle).toHaveTextContent("Show stack trace")
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByTestId("error-stack-trace")).toBeNull()

    await userEvent.click(toggle)
    const trace = screen.getByTestId("error-stack-trace")
    expect(trace).toHaveTextContent("at ArtifactList (artifact-list.tsx:206:31)")
    // The headline line is not echoed inside the trace block.
    expect(trace.textContent?.startsWith("    at ArtifactList")).toBe(true)
    expect(toggle).toHaveTextContent("Hide stack trace")
    expect(toggle).toHaveAttribute("aria-expanded", "true")

    await userEvent.click(toggle)
    expect(screen.queryByTestId("error-stack-trace")).toBeNull()
    expect(toggle).toHaveTextContent("Show stack trace")
  })

  it("scrolls the freshly expanded trace into view", async () => {
    const scrollIntoView = jest.fn()
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    })
    try {
      renderSection({ message: "boom", stack: STACK })
      await userEvent.click(screen.getByTestId("error-stack-toggle"))
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" }))

      // Collapsing must not re-scroll.
      scrollIntoView.mockClear()
      await userEvent.click(screen.getByTestId("error-stack-toggle"))
      expect(scrollIntoView).not.toHaveBeenCalled()
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })

  it("still expands when requestAnimationFrame is unavailable", async () => {
    const raf = window.requestAnimationFrame
    // @ts-expect-error — deliberately removing the API for the fallback path.
    delete window.requestAnimationFrame
    try {
      renderSection({ message: "boom", stack: STACK })
      await userEvent.click(screen.getByTestId("error-stack-toggle"))
      expect(screen.getByTestId("error-stack-trace")).toBeInTheDocument()
    } finally {
      window.requestAnimationFrame = raf
    }
  })
})
