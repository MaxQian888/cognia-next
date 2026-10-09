/** @jest-environment jsdom */

// The agents console's empty centre and the "New agent" landing (ADR-0220):
// the copy for each mode, the two ways to make an agent, and the unfinished
// drafts below them.

import { fireEvent, render, screen, within } from "@testing-library/react"

jest.mock("@/components/mobile/mobile-spot-icon", () => ({
  MobileSpotIcon: (props: { name: string }) => (
    <span data-testid="spot-icon" data-name={props.name} />
  ),
}))
let draftsProps: { onResume: (id: string) => void; className?: string } | undefined
jest.mock("../builder/agent-builder-drafts", () => ({
  AgentBuilderDrafts: (props: { onResume: (id: string) => void; className?: string }) => {
    draftsProps = props
    return <div data-testid="drafts" className={props.className} />
  },
}))

import { AgentCreateChooser, type AgentCreateChooserProps } from "./agent-create-chooser"

function props(over: Partial<AgentCreateChooserProps> = {}): AgentCreateChooserProps {
  return { onBlank: jest.fn(), onBuildWithAi: jest.fn(), onResumeDraft: jest.fn(), ...over }
}

beforeEach(() => {
  draftsProps = undefined
})

describe("copy", () => {
  it("defaults to the create mode", () => {
    render(<AgentCreateChooser {...props({ agentCount: 4 })} />)
    expect(screen.getByTestId("agent-create-chooser")).toHaveAttribute("data-mode", "create")
    expect(screen.getByRole("heading", { name: "New agent" })).toBeInTheDocument()
    expect(screen.getByText(/Describe it and let the agent builder set it up/)).toBeInTheDocument()
    expect(screen.getByTestId("spot-icon")).toHaveAttribute("data-name", "characters")
  })

  it("invites picking an agent on the home view when there are some", () => {
    render(<AgentCreateChooser {...props({ mode: "home", agentCount: 3 })} />)
    expect(screen.getByTestId("agent-create-chooser")).toHaveAttribute("data-mode", "home")
    expect(
      screen.getByRole("heading", { name: "Pick an agent, or make a new one" })
    ).toBeInTheDocument()
    expect(screen.getByText(/Open any of the 3 agents in the list/)).toBeInTheDocument()
  })

  it.each([
    ["no count given", undefined],
    ["zero agents", 0],
  ])("explains what an agent is on an empty home view (%s)", (_n, agentCount) => {
    render(<AgentCreateChooser {...props({ mode: "home", agentCount })} />)
    expect(screen.getByRole("heading", { name: "No agents yet" })).toBeInTheDocument()
    expect(screen.getByText(/An agent is a reusable assistant/)).toBeInTheDocument()
  })

  it("applies the host's class", () => {
    render(<AgentCreateChooser {...props({ className: "custom-x" })} />)
    expect(screen.getByTestId("agent-create-chooser")).toHaveClass("custom-x")
  })
})

describe("choices", () => {
  it("recommends building with AI and describes both ways", () => {
    render(<AgentCreateChooser {...props()} />)
    const ai = screen.getByTestId("agent-create-ai")
    const blank = screen.getByTestId("agent-create-blank")
    expect(within(ai).getByText("Build with AI")).toBeInTheDocument()
    expect(within(ai).getByText("Recommended")).toBeInTheDocument()
    expect(
      within(ai).getByText(/the builder fills in an editable configuration/)
    ).toBeInTheDocument()
    expect(within(blank).getByText("Start blank")).toBeInTheDocument()
    expect(within(blank).queryByText("Recommended")).not.toBeInTheDocument()
    expect(within(blank).getByText(/Set the name, instructions/)).toBeInTheDocument()
  })

  it("routes each row to its handler", () => {
    const p = props()
    render(<AgentCreateChooser {...p} />)
    fireEvent.click(screen.getByTestId("agent-create-ai"))
    expect(p.onBuildWithAi).toHaveBeenCalledTimes(1)
    expect(p.onBlank).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("agent-create-blank"))
    expect(p.onBlank).toHaveBeenCalledTimes(1)
  })

  it("puts the AI row first", () => {
    render(<AgentCreateChooser {...props()} />)
    const ai = screen.getByTestId("agent-create-ai")
    const blank = screen.getByTestId("agent-create-blank")
    expect(ai.compareDocumentPosition(blank) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe("drafts", () => {
  it("lists unfinished drafts below the choices and resumes them through the host", () => {
    const p = props()
    render(<AgentCreateChooser {...p} />)
    const drafts = screen.getByTestId("drafts")
    expect(drafts).toHaveClass("mt-6")
    expect(
      screen.getByTestId("agent-create-blank").compareDocumentPosition(drafts) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    draftsProps?.onResume("s5")
    expect(p.onResumeDraft).toHaveBeenCalledWith("s5")
  })
})
