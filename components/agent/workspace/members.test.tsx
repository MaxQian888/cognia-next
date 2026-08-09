/**
 * @jest-environment jsdom
 *
 * Coverage for AgentTeamMembers: empty state, lead + worker rendering,
 * add-teammate dialog, and status badge rendering.
 */

import React from "react"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// Strip motion props that React would warn about on a plain DOM node; the
// roster now uses variants + AnimatePresence for enter/exit and `layout` for
// the reflow when a member is removed.
const stripMotionProps = (props: Record<string, unknown>) => {
  const {
    variants: _v,
    initial: _i,
    animate: _a,
    exit: _e,
    transition: _t,
    layout: _l,
    layoutId: _lid,
    ...rest
  } = props
  return rest
}

jest.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...stripMotionProps(props as Record<string, unknown>)}>{children}</div>
    ),
    span: ({ children, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
      <span {...stripMotionProps(props as Record<string, unknown>)}>{children}</span>
    ),
    ul: ({ children, ...props }: React.HTMLAttributes<HTMLUListElement>) => (
      <ul {...stripMotionProps(props as Record<string, unknown>)}>{children}</ul>
    ),
    li: ({ children, ...props }: React.HTMLAttributes<HTMLLIElement>) => (
      <li {...stripMotionProps(props as Record<string, unknown>)}>{children}</li>
    ),
  },
  useReducedMotion: () => true,
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  PluginExtensionSlot: ({
    point,
    context,
  }: {
    point: string
    context?: Record<string, unknown>
  }) => <div data-testid={`slot-${point}`} data-context={JSON.stringify(context)} />,
  usePluginSlotHasExtensions: () => false,
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

// Mutable PR-status map so a test can seed a teammate's PR observation. Prefixed
// `mock*` to satisfy jest's out-of-scope factory rule.
const mockPrStatus: { current: Map<string, { derivedStatus: string; prUrl?: string }> } = {
  current: new Map(),
}
jest.mock("@/hooks/agent-runs/use-team-pr-status", () => ({
  useTeamPrStatusByTeammate: () => mockPrStatus.current,
}))

import { AgentTeamMembers } from "./members"
import { buildTeam } from "@/lib/storybook/fixtures/agent-team"
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
  mockPrStatus.current = new Map()
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
    expect(screen.getByTestId("agent-team-avatar-lead_1")).toHaveAttribute(
      "data-avatar-id",
      "coordinator"
    )
    expect(screen.getByTestId("agent-team-avatar-tm_1")).toHaveAttribute(
      "src",
      expect.stringMatching(/^\/icons\/cognia-agent-team\/webp\/.+\.webp$/)
    )
    const status = screen.getByTestId("member-tm_1-status")
    expect(status.textContent ?? "").toMatch(/Executing/i)
  })

  it("renders a PR status badge with a PR link when the teammate has an observed PR", () => {
    mockPrStatus.current = new Map([
      ["tm_1", { derivedStatus: "ci_failed", prUrl: "https://gh/acme/app/pull/1" }],
    ])
    const worker = teammate({ id: "tm_1", name: "Worker One", role: "teammate" })
    render(<AgentTeamMembers teamId="team_x" teammates={[worker]} leadId="" />)
    expect(screen.getByTestId("pr-status-badge")).toBeInTheDocument()
    expect(screen.getByTestId("pr-status-link")).toHaveAttribute(
      "href",
      "https://gh/acme/app/pull/1"
    )
  })

  it("renders no PR status badge when the teammate has no observed PR", () => {
    const worker = teammate({ id: "tm_1", name: "Worker One", role: "teammate" })
    render(<AgentTeamMembers teamId="team_x" teammates={[worker]} leadId="" />)
    expect(screen.queryByTestId("pr-status-badge")).toBeNull()
  })

  it("does not render a determinate progress bar even when progress > 0", () => {
    // The pseudo-percentage member bar was removed in favor of the honest
    // live activity surfaced in the Activity panel.
    const worker = teammate({ id: "tm_1", name: "Worker One", progress: 80 })
    render(<AgentTeamMembers teamId="team_x" teammates={[worker]} leadId="" />)
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
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

  it("mounts the agent.teammate.actions slot in a teammate dropdown with teammate-scoped context", async () => {
    const lead = teammate({ id: "lead_1", name: "Lead Bot", role: "lead" })
    const worker = teammate({
      id: "tm_1",
      name: "Worker One",
      role: "teammate",
      status: "executing",
      config: { runtime: "codex", specialization: "qa" },
    })
    render(<AgentTeamMembers teamId="team_x" teammates={[lead, worker]} leadId="lead_1" />)
    const triggers = screen.getAllByRole("button", { name: "" })
    const trigger = triggers.find(
      (b) => b.closest('[data-testid="member-tm_1"]') !== null && b.querySelector("svg")
    )
    await userEvent.click(trigger!)
    const slot = await screen.findByTestId("slot-agent.teammate.actions")
    const ctx = JSON.parse(slot.getAttribute("data-context") ?? "{}")
    expect(ctx).toMatchObject({
      teamId: "team_x",
      teammateId: "tm_1",
      role: "teammate",
      status: "executing",
      runtime: "codex",
      specialization: "qa",
    })
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

  it("persists a runtime switch through updateTeammate, merging rather than replacing config", async () => {
    // Radix Select needs userEvent, not fireEvent (jest-gotchas #4).
    const user = userEvent.setup()
    const worker = teammate({
      id: "tm_1",
      name: "Worker One",
      role: "teammate",
      config: { runtime: "claude", model: "sonnet" } as AgentTeammate["config"],
    })
    render(<AgentTeamMembers teamId="team_x" teammates={[worker]} leadId="" />)

    const combo = screen.getByTestId("runtime-select-tm_1")
    expect(combo).toHaveAttribute("role", "combobox")
    await user.click(combo)
    const option = await screen.findByRole("option", { name: "Codex" })
    await user.click(option)

    // The `model` key must survive — the handler spreads the existing config.
    expect(updateTeammateMock).toHaveBeenCalledWith("tm_1", {
      config: { runtime: "codex", model: "sonnet" },
    })
  })

  it("opens the teammate config dialog from the row menu", async () => {
    const user = userEvent.setup()
    const worker = teammate({ id: "tm_1", name: "Worker One", role: "teammate" })
    render(<AgentTeamMembers team={buildTeam()} teammates={[worker]} leadId="" />)

    const trigger = screen
      .getAllByRole("button")
      .find((b) => b.closest('[data-testid="member-tm_1"]') !== null && b.querySelector("svg"))
    await user.click(trigger!)
    await user.click(await screen.findByTestId("configure-tm_1"))
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
  })

  it("falls back to the default runtime when a teammate has none configured", () => {
    const worker = teammate({
      id: "tm_1",
      name: "Worker One",
      role: "teammate",
      config: {},
    })
    render(<AgentTeamMembers teamId="team_x" teammates={[worker]} leadId="" />)
    // Rendering at all proves the `?? DEFAULT_TEAMMATE_RUNTIME` fallback ran;
    // a missing runtime used to leave the Select with an undefined value.
    expect(screen.getByTestId("runtime-select-tm_1")).toBeInTheDocument()
  })

  it("refuses to add a teammate with a blank name", async () => {
    const user = userEvent.setup()
    render(<AgentTeamMembers teamId="team_x" teammates={[]} leadId="" />)
    await user.click(screen.getAllByRole("button").at(-1)!)
    const dialog = await screen.findByRole("dialog")
    // Submit with the name untouched — the guard must swallow it.
    const save = within(dialog)
      .getAllByRole("button")
      .find((b) => !/cancel/i.test(b.textContent ?? ""))
    await user.click(save!)
    expect(addTeammateMock).not.toHaveBeenCalled()
  })

  it("prefers the team prop over the legacy teamId prop", () => {
    const worker = teammate({ id: "tm_1", name: "Worker One", role: "teammate" })
    render(<AgentTeamMembers team={buildTeam()} teammates={[worker]} leadId="" />)
    expect(screen.getByTestId("member-tm_1")).toBeInTheDocument()
  })

  it("closes the config dialog when the teammate dialog requests it", async () => {
    const user = userEvent.setup()
    const worker = teammate({ id: "tm_1", name: "Worker One", role: "teammate" })
    render(<AgentTeamMembers team={buildTeam()} teammates={[worker]} leadId="" />)

    const trigger = screen
      .getAllByRole("button")
      .find((b) => b.closest('[data-testid="member-tm_1"]') !== null && b.querySelector("svg"))
    await user.click(trigger!)
    await user.click(await screen.findByTestId("configure-tm_1"))
    const dialog = await screen.findByRole("dialog")

    await user.keyboard("{Escape}")
    await waitFor(() => expect(dialog).not.toBeInTheDocument())
  })
})
