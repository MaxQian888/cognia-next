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

const setSquadLeadMock = jest.fn((_teamId: string, _teammateId: string) => ({ ok: true }))
const mockTeamStatus: { current: string } = { current: "idle" }
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (selector: (s: unknown) => unknown) =>
    selector({
      addTeammate: addTeammateMock,
      removeTeammate: removeTeammateMock,
      updateTeammate: updateTeammateMock,
      setSquadLead: (teamId: string, teammateId: string) => setSquadLeadMock(teamId, teammateId),
      teams: { team_x: { id: "team_x", status: mockTeamStatus.current } },
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

const mockExternalAgents: { current: Record<string, unknown> } = { current: {} }
jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: (selector: (s: unknown) => unknown) =>
    selector({ agents: mockExternalAgents.current }),
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
  setSquadLeadMock.mockClear()
  mockTeamStatus.current = "idle"
  addTeammateMock.mockClear()
  removeTeammateMock.mockClear()
  updateTeammateMock.mockClear()
  mockPrStatus.current = new Map()
  mockExternalAgents.current = {
    strict: {
      id: "strict",
      name: "Codex strict",
      enabled: true,
      metadata: { preset: "codex" },
      createdAt: "2025-01-01T00:00:00Z",
    },
    lenient: {
      id: "lenient",
      name: "Codex lenient",
      enabled: true,
      metadata: { preset: "codex" },
      createdAt: "2026-01-01T00:00:00Z",
    },
  }
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
    await userEvent.click(screen.getByRole("button", { name: "Actions for Worker One" }))
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
    // The icon-only menu trigger is named after its member.
    await userEvent.click(screen.getByRole("button", { name: "Actions for Worker One" }))
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

  describe("exact external-agent config pin", () => {
    it("pins a codex worker to one saved config", async () => {
      const user = userEvent.setup()
      const worker = teammate({ id: "tm_1", role: "teammate", config: { runtime: "codex" } })
      render(<AgentTeamMembers teamId="team_x" teammates={[worker]} leadId="" />)
      const pin = screen.getByTestId("config-pin-tm_1")
      expect(pin).toHaveTextContent("Any Codex config")
      await user.click(pin)
      await user.click(await screen.findByRole("option", { name: "Codex strict" }))
      expect(updateTeammateMock).toHaveBeenCalledWith("tm_1", {
        config: { runtime: "codex", externalAgentConfigId: "strict" },
      })
    })

    it("clears the pin back to any config", async () => {
      const user = userEvent.setup()
      const worker = teammate({
        id: "tm_1",
        role: "teammate",
        config: { runtime: "codex", externalAgentConfigId: "strict" },
      })
      render(<AgentTeamMembers teamId="team_x" teammates={[worker]} leadId="" />)
      await user.click(screen.getByTestId("config-pin-tm_1"))
      await user.click(await screen.findByRole("option", { name: "Any Codex config" }))
      const config = updateTeammateMock.mock.calls[0][1].config
      expect(config).toEqual({ runtime: "codex" })
      expect(config).not.toHaveProperty("externalAgentConfigId")
    })

    it("drops the pin when the runtime switches", async () => {
      const user = userEvent.setup()
      const worker = teammate({
        id: "tm_1",
        role: "teammate",
        config: { runtime: "codex", externalAgentConfigId: "strict" },
      })
      render(<AgentTeamMembers teamId="team_x" teammates={[worker]} leadId="" />)
      await user.click(screen.getByTestId("runtime-select-tm_1"))
      await user.click(await screen.findByRole("option", { name: "Claude" }))
      const config = updateTeammateMock.mock.calls[0][1].config
      expect(config.runtime).toBe("claude")
      expect(config).not.toHaveProperty("externalAgentConfigId")
    })

    it("offers no pin to a claude worker or to the lead", () => {
      const lead = teammate({ id: "lead_1", role: "lead", config: { runtime: "codex" } })
      const worker = teammate({ id: "tm_1", role: "teammate", config: { runtime: "claude" } })
      render(<AgentTeamMembers teamId="team_x" teammates={[lead, worker]} leadId="lead_1" />)
      expect(screen.queryByTestId("config-pin-tm_1")).not.toBeInTheDocument()
      expect(screen.queryByTestId("config-pin-lead_1")).not.toBeInTheDocument()
    })

    it("adds a teammate pinned to the chosen config", async () => {
      const user = userEvent.setup()
      render(<AgentTeamMembers teamId="team_x" teammates={[]} leadId="" />)
      await user.click(screen.getByRole("button", { name: /Add teammate/i }))
      fireEvent.change(screen.getByPlaceholderText(/Security Reviewer/i), {
        target: { value: "Eve" },
      })
      expect(screen.queryByTestId("config-pin-add")).not.toBeInTheDocument()
      await user.click(screen.getByTestId("runtime-select-add"))
      await user.click(await screen.findByRole("option", { name: "Codex" }))
      await user.click(screen.getByTestId("config-pin-add"))
      await user.click(await screen.findByRole("option", { name: "Codex lenient" }))
      await user.click(screen.getAllByRole("button", { name: /Add/ }).at(-1)!)
      expect(addTeammateMock.mock.calls[0][0].config).toEqual({
        runtime: "codex",
        externalAgentConfigId: "lenient",
      })
    })
  })

  describe("roster layout", () => {
    /** One list, lead first, so the roster reads the same wherever it is shown. */
    it("lists the lead first in one list, not a card per member", () => {
      const lead = teammate({ id: "lead_1", name: "Lead Bot", role: "lead" })
      const a = teammate({ id: "tm_a", name: "Alpha", role: "teammate" })
      const b = teammate({ id: "tm_b", name: "Bravo", role: "teammate" })
      render(<AgentTeamMembers teamId="team_x" teammates={[a, lead, b]} leadId="lead_1" />)
      const rows = screen.getAllByRole("listitem")
      expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual([
        "member-lead_1",
        "member-tm_a",
        "member-tm_b",
      ])
      expect(rows[0]).toHaveAttribute("data-role", "lead")
      expect(document.querySelector('[data-slot="card"]')).toBeNull()
    })

    it("counts the roster beside its add action", () => {
      const lead = teammate({ id: "lead_1", name: "Lead Bot", role: "lead" })
      const worker = teammate({ id: "tm_1", name: "Worker One", role: "teammate" })
      render(<AgentTeamMembers teamId="team_x" teammates={[lead, worker]} leadId="lead_1" />)
      expect(screen.getByTestId("workspace-members-count")).toHaveTextContent("2 members")
    })

    /** Sizes off the roster's own width, not the window's. */
    it("declares the container its rows reflow against", () => {
      const worker = teammate({ id: "tm_1", name: "Worker One", role: "teammate" })
      render(<AgentTeamMembers teamId="team_x" teammates={[worker]} leadId="" />)
      expect(screen.getByTestId("workspace-members").className).toContain("@container/roster")
    })
  })

  describe("controlled add dialog", () => {
    it("opens when its host asks, and reports the add button to the host", async () => {
      const onAddOpenChange = jest.fn()
      const worker = teammate({ id: "tm_1", name: "Worker One", role: "teammate" })
      const { rerender } = render(
        <AgentTeamMembers
          teamId="team_x"
          teammates={[worker]}
          leadId=""
          addOpen={false}
          onAddOpenChange={onAddOpenChange}
        />
      )
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
      await userEvent.click(screen.getByTestId("workspace-members-add"))
      expect(onAddOpenChange).toHaveBeenCalledWith(true)
      // Still closed: the host owns the state and has not said yes.
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
      rerender(
        <AgentTeamMembers
          teamId="team_x"
          teammates={[worker]}
          leadId=""
          addOpen
          onAddOpenChange={onAddOpenChange}
        />
      )
      expect(await screen.findByRole("dialog")).toHaveTextContent("Add new teammate")
    })

    it("owns the dialog itself when no host controls it", async () => {
      const worker = teammate({ id: "tm_1", name: "Worker One", role: "teammate" })
      render(<AgentTeamMembers teamId="team_x" teammates={[worker]} leadId="" />)
      await userEvent.click(screen.getByTestId("workspace-members-add"))
      expect(await screen.findByRole("dialog")).toHaveTextContent("Add new teammate")
    })
  })

  describe("changing the lead", () => {
    const lead = teammate({ id: "lead_1", name: "Lead Bot", role: "lead" })
    const worker = teammate({ id: "tm_1", name: "Worker One", role: "teammate" })

    it("hands the lead to a teammate from its menu", async () => {
      const { toast } = jest.requireMock("sonner") as { toast: { success: jest.Mock } }
      render(<AgentTeamMembers teamId="team_x" teammates={[lead, worker]} leadId="lead_1" />)
      await userEvent.click(screen.getByRole("button", { name: "Actions for Worker One" }))
      await userEvent.click(await screen.findByTestId("make-lead-tm_1"))
      expect(setSquadLeadMock).toHaveBeenCalledWith("team_x", "tm_1")
      expect(toast.success).toHaveBeenCalledWith("Worker One now leads this Squad.")
    })

    it("offers no such action on the lead itself", async () => {
      render(<AgentTeamMembers teamId="team_x" teammates={[lead, worker]} leadId="lead_1" />)
      await userEvent.click(screen.getByRole("button", { name: "Actions for Lead Bot" }))
      await screen.findByTestId("configure-lead_1")
      expect(screen.queryByTestId("make-lead-lead_1")).not.toBeInTheDocument()
    })

    /** Said in the item, because a disabled item's tooltip never shows on touch. */
    it.each(["planning", "executing", "paused"])(
      "locks the action while the Squad is %s, saying why in the item",
      async (status) => {
        mockTeamStatus.current = status
        render(<AgentTeamMembers teamId="team_x" teammates={[lead, worker]} leadId="lead_1" />)
        await userEvent.click(screen.getByRole("button", { name: "Actions for Worker One" }))
        const item = await screen.findByTestId("make-lead-tm_1")
        expect(item).toHaveAttribute("data-disabled")
        expect(item).toHaveTextContent("Locked while a run is live or paused")
      }
    )

    it("explains a refusal the store returns", async () => {
      const { toast } = jest.requireMock("sonner") as { toast: { error: jest.Mock } }
      setSquadLeadMock.mockReturnValueOnce({ ok: false, reason: "run_active" } as never)
      render(<AgentTeamMembers teamId="team_x" teammates={[lead, worker]} leadId="lead_1" />)
      await userEvent.click(screen.getByRole("button", { name: "Actions for Worker One" }))
      await userEvent.click(await screen.findByTestId("make-lead-tm_1"))
      expect(toast.error).toHaveBeenCalledWith(
        "The lead can't change while a run is live or paused. Stop the run first."
      )
    })
  })
})
