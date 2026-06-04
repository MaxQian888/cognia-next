/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const mockClassify = jest.fn((cmd: string) => ({
  verdict: cmd.includes("danger") ? ("ask" as const) : ("allow" as const),
  reason: "test",
  segments: [],
}))
jest.mock("@/lib/claude/permissions/command-safety", () => ({
  classifyCommand: (cmd: string) => mockClassify(cmd),
}))

import { TerminalCompletionPopup } from "./terminal-completion-popup"
import type { TerminalCompletionSuggestion } from "@/lib/terminal/completion/types"

function sug(
  text: string,
  over: Partial<TerminalCompletionSuggestion> = {}
): TerminalCompletionSuggestion {
  return { text, source: "history", providerId: "builtin:history", ...over }
}

const baseProps = {
  selectedIndex: 0,
  left: 40,
  top: 120,
  fontFamily: "monospace",
  fontSize: 13,
}

beforeEach(() => mockClassify.mockClear())

describe("TerminalCompletionPopup", () => {
  it("renders nothing for an empty candidate list", () => {
    const { container } = render(<TerminalCompletionPopup {...baseProps} candidates={[]} />)
    expect(container.querySelector('[data-testid="terminal-completion-popup"]')).toBeNull()
  })

  it("renders a listbox with one option per candidate", () => {
    render(
      <TerminalCompletionPopup
        {...baseProps}
        candidates={[sug("git status"), sug("git stash", { source: "spec" })]}
      />
    )
    const listbox = screen.getByRole("listbox")
    expect(listbox).toBeInTheDocument()
    expect(screen.getAllByRole("option")).toHaveLength(2)
  })

  it("marks the highlighted candidate as selected", () => {
    render(
      <TerminalCompletionPopup
        {...baseProps}
        selectedIndex={1}
        candidates={[sug("a1"), sug("a2")]}
      />
    )
    const options = screen.getAllByRole("option")
    expect(options[0]).toHaveAttribute("aria-selected", "false")
    expect(options[1]).toHaveAttribute("aria-selected", "true")
  })

  it("shows the replace insert (token) when present, full text otherwise", () => {
    render(
      <TerminalCompletionPopup
        {...baseProps}
        candidates={[
          sug("cd src/", { source: "path", replace: { from: 3, insert: "src/" } }),
          sug("git status"),
        ]}
      />
    )
    expect(screen.getByText("src/")).toBeInTheDocument()
    expect(screen.getByText("git status")).toBeInTheDocument()
  })

  it("shows the safety badge only for ask-verdict candidates", () => {
    render(
      <TerminalCompletionPopup
        {...baseProps}
        candidates={[sug("dangerous thing"), sug("ls -la")]}
      />
    )
    expect(screen.getByTestId("terminal-completion-ask-badge-0")).toBeInTheDocument()
    expect(screen.queryByTestId("terminal-completion-ask-badge-1")).toBeNull()
  })

  it("shows the description when present, source label otherwise", () => {
    render(
      <TerminalCompletionPopup
        {...baseProps}
        candidates={[sug("git commit", { description: "Record changes" }), sug("git push")]}
      />
    )
    expect(screen.getByText("Record changes")).toBeInTheDocument()
    expect(screen.getByText("popup.source.history")).toBeInTheDocument()
  })

  it("fires onPick with the row index on mousedown without stealing focus", () => {
    const onPick = jest.fn()
    render(
      <TerminalCompletionPopup {...baseProps} onPick={onPick} candidates={[sug("a1"), sug("a2")]} />
    )
    const second = screen.getByTestId("terminal-completion-candidate-1")
    const down = fireEvent.mouseDown(second)
    expect(onPick).toHaveBeenCalledWith(1)
    expect(down).toBe(false) // preventDefault — focus stays on the terminal
  })

  it("has no tabbable container (terminal keeps focus)", () => {
    render(<TerminalCompletionPopup {...baseProps} candidates={[sug("a")]} />)
    expect(screen.getByTestId("terminal-completion-popup")).not.toHaveAttribute("tabindex")
  })

  it("renders the footer key hint", () => {
    render(<TerminalCompletionPopup {...baseProps} candidates={[sug("a")]} />)
    expect(screen.getByText("popup.hint")).toBeInTheDocument()
  })
})
