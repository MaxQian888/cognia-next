/**
 * @jest-environment jsdom
 *
 * Coverage for AgentTeamMembers: empty state, lead + worker rendering,
 * add-teammate dialog, and status badge rendering.
 */

import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("motion/react", () => ({
  motion: {
    div: ({ children, className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div className={className} {...props}>
        {children}
      </div>
    ),
    span: ({ children, className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
      <span className={className} {...props}>
        {children}
      </span>
    ),
  },
  useReducedMotion: () => true,
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

const addTeammateMock = jest.fn()
const removeTeammateMock = jest.fn()
const updateTeammateMock = jest.fn()

jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (selector: (s: unknown) => unknown) =>
    selector({
      addTeammate: addTeammateMock,
      removeTeammate: removeTeammateMock,
      updateTeammate: updateTeammateMock,
    }),
}))

import { AgentTeamMembers } from "./members"
import type { AgentTeammate } from "@/types/agent/agent-team"

const teammate = (overrides: Partial<AgentTeammate>): AgentTeammate => ({
  id: "tm_x",
  teamId: "team_x",
  name: "Member",
  description: "",
  role: "teammate",
  status: "idle",
  config: { runtime: "claude" },
  completedTaskIds: [],
  tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  progress: 0,
  createdAt: new Date(),
  ...overrides,
})

beforeEach(() => {
  addTeammateMock.mockClear()
  removeTeammateMock.mockClear()
  updateTeammateMock.mockClear()
})

describe("AgentTeamMembers", () => {
  it("renders the empty state when there are no teammates", () => {
    render(<AgentTeamMembers teamId="team_x" teammates={[]} leadId="" />)
    // Empty state uses the agentTeamsWorkspace.members.empty key.
    expect(document.body.textContent ?? "").toMatch(/No members yet/i)
  })

  it("renders lead and worker rows with status badges", () => {
    const lead = teammate({ id: "lead_1", name: "Lead Bot", role: "lead" })
    const worker = teammate({
      id: "tm_1",
      name: "Worker One",
      role: "teammate",
      status: "executing",
    })
    render(<AgentTeamMembers teamId="team_x" teammates={[lead, worker]} leadId="lead_1" />)
    expect(screen.getByTestId("member-lead_1")).toBeInTheDocument()
    expect(screen.getByTestId("member-tm_1")).toBeInTheDocument()
    expect(screen.getByText("Lead Bot")).toBeInTheDocument()
    expect(screen.getByText("Worker One")).toBeInTheDocument()
    const status = screen.getByTestId("member-tm_1-status")
    expect(status.textContent ?? "").toMatch(/Executing/i)
  })

  it("opens the add-teammate dialog when Add teammate is clicked", async () => {
    render(<AgentTeamMembers teamId="team_x" teammates={[]} leadId="" />)
    const addBtn = screen.getByRole("button", { name: /Add teammate/i })
    await userEvent.click(addBtn)
    expect(screen.getByText(/Add new teammate/i)).toBeInTheDocument()
  })

  it("calls addTeammate with the form data when Save is clicked", async () => {
    render(<AgentTeamMembers teamId="team_x" teammates={[]} leadId="" />)
    await userEvent.click(screen.getByRole("button", { name: /Add teammate/i }))
    const nameInput = screen.getByPlaceholderText(/Security Reviewer/i) as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: "Eve" } })
    // Submit
    const saveButton = screen.getAllByRole("button", { name: /Add/ }).at(-1)!
    await userEvent.click(saveButton)
    expect(addTeammateMock).toHaveBeenCalledTimes(1)
    const call = addTeammateMock.mock.calls[0][0]
    expect(call.name).toBe("Eve")
    expect(call.teamId).toBe("team_x")
  })

  it("removes a teammate after the destructive confirmation", async () => {
    const lead = teammate({ id: "lead_1", name: "Lead Bot", role: "lead" })
    const worker = teammate({ id: "tm_1", name: "Worker One", role: "teammate" })
    render(<AgentTeamMembers teamId="team_x" teammates={[lead, worker]} leadId="lead_1" />)
    // Open the worker's dropdown menu
    const triggers = screen.getAllByRole("button", { name: "" }) // Icon-only buttons have empty accessible names
    // Find the worker's MoreHorizontal dropdown trigger
    const trigger = triggers.find(
      (b) => b.closest('[data-testid="member-tm_1"]') !== null && b.querySelector("svg")
    )
    expect(trigger).toBeTruthy()
    await userEvent.click(trigger!)
    const removeItem = await screen.findByText(/^Remove$/i)
    await userEvent.click(removeItem)
    // The AlertDialog Remove action should call removeTeammate.
    const finalRemove = screen.getAllByRole("button", { name: /Remove/i }).at(-1)
    await userEvent.click(finalRemove!)
    expect(removeTeammateMock).toHaveBeenCalledWith("tm_1")
  })
})
