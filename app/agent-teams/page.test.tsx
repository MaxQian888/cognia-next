/**
 * @jest-environment jsdom
 *
 * Coverage for the Agent Teams management list page focused on the i18n /
 * layout fixes:
 *   - Team card status renders the TRANSLATED label (StatusBadge →
 *     agentTeam.status.*) rather than the raw enum value.
 *   - The template "Built-in" badge uses the agentTeamsWorkspace.builtInBadge
 *     key instead of a hard-coded literal.
 *   - The per-card actions menu container is touch-reachable (always visible,
 *     hover/focus reveal only from `sm:` up) so it is usable without a pointer.
 */

import React from "react"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { AgentTeam, AgentTeamTemplate } from "@/types/agent/agent-team"

const pushMock = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

// The auto-compose dialog pulls in LLM client wiring we don't need here.
jest.mock("@/components/agent/workspace/auto-compose-dialog", () => ({
  AutoComposeDialog: () => null,
}))

// No plugin-overlay templates / warnings in this test.
jest.mock("@/lib/plugin/registries/agent-team-template-registry", () => ({
  listAgentTeamTemplateEntries: () => [],
  getTemplateWarnings: () => [],
}))

jest.mock("@/lib/ai/agent/sample-team", () => ({
  createSampleTeam: () => ({ teamId: "sample_1" }),
}))

const team = (overrides: Partial<AgentTeam>): AgentTeam =>
  ({
    id: "team_1",
    name: "Research Squad",
    description: "A team",
    task: "do research",
    status: "executing",
    config: {},
    teammateIds: [],
    messageIds: [],
    taskIds: [],
    events: [],
    createdAt: new Date("2024-01-01T00:00:00Z"),
    ...overrides,
  }) as AgentTeam

const template = (overrides: Partial<AgentTeamTemplate>): AgentTeamTemplate =>
  ({
    id: "tpl_1",
    name: "Manager Worker",
    description: "Built-in template",
    category: "general",
    isBuiltIn: true,
    teammates: [],
    config: {},
    ...overrides,
  }) as AgentTeamTemplate

let storeState: Record<string, unknown>

jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (selector: (s: unknown) => unknown) => selector(storeState),
}))

jest.mock("@/stores/ui/ui-store", () => ({
  useUIStore: (selector: (s: unknown) => unknown) =>
    selector({ pendingCreateRequest: undefined, clearPendingCreate: jest.fn() }),
}))

// useTeamLiveStatus derives status from the durable workflowRuns row. Mock it
// so the card renders a deterministic status without a live Dexie query; an
// override lets a test simulate the run row diverging from the store value.
let liveStatusOverride: AgentTeam["status"] | undefined
jest.mock("@/hooks/agent-runs/use-team-live-status", () => ({
  useTeamLiveStatus: (t: { status: AgentTeam["status"] }) => liveStatusOverride ?? t.status,
}))

import AgentTeamsListPage from "./page"

beforeEach(() => {
  pushMock.mockClear()
  liveStatusOverride = undefined
  storeState = {
    teams: { team_1: team({ status: "executing" }) },
    teammates: {},
    templates: { tpl_1: template({}) },
    createTeam: jest.fn(() => ({ id: "copy_1", name: "Research Squad (copy)" })),
    addTeammate: jest.fn(),
    deleteTeam: jest.fn(),
    updateTeam: jest.fn(),
  }
})

describe("AgentTeamsListPage", () => {
  it("renders the team status with the translated label, not the raw enum", () => {
    render(<AgentTeamsListPage />)
    const card = screen.getByTestId("team-card-team_1")
    // agentTeam.status.executing === "Executing" (capitalised) — proves the
    // StatusBadge translation ran instead of rendering the raw "executing".
    expect(within(card).getByText("Executing")).toBeInTheDocument()
    expect(within(card).queryByText("executing")).toBeNull()
  })

  it("renders the authoritative live status when it diverges from the store", async () => {
    // Store still says executing (stale optimistic write), but the workflowRuns
    // subscription reports the run completed — the card must show completed.
    liveStatusOverride = "completed"
    const user = userEvent.setup()
    render(<AgentTeamsListPage />)
    const card = screen.getByTestId("team-card-team_1")
    // agentTeam.status.completed === "Completed"
    expect(within(card).getByText("Completed")).toBeInTheDocument()
    expect(within(card).queryByText("Executing")).toBeNull()
    // And the actions menu offers "Open" (not "View") since the run is terminal.
    await user.click(within(card).getByRole("button"))
    expect(await screen.findByRole("menuitem", { name: "Open workspace" })).toBeInTheDocument()
  })

  it("keeps the per-card actions menu reachable on touch devices", () => {
    render(<AgentTeamsListPage />)
    const card = screen.getByTestId("team-card-team_1")
    const trigger = within(card).getByRole("button")
    const actions = trigger.parentElement as HTMLElement
    // Always visible by default; hover/focus reveal only kicks in from sm: up.
    expect(actions.className).toMatch(/opacity-100/)
    expect(actions.className).toMatch(/sm:opacity-0/)
    expect(actions.className).not.toMatch(/(^|\s)opacity-0(\s|$)/)
  })

  it("labels built-in templates via the i18n key", async () => {
    const user = userEvent.setup()
    render(<AgentTeamsListPage />)
    await user.click(screen.getByRole("tab", { name: "Templates" }))
    const card = await screen.findByTestId("template-card-tpl_1")
    expect(within(card).getByText("Built-in")).toBeInTheDocument()
  })

  it("duplicates a team with the i18n-formatted copy suffix from the actions menu", async () => {
    const user = userEvent.setup()
    render(<AgentTeamsListPage />)
    const card = screen.getByTestId("team-card-team_1")
    // The menu trigger is reachable (the touch-reachability fix keeps it visible).
    await user.click(within(card).getByRole("button"))
    // agentTeamsWorkspace.duplicate === "Duplicate"
    await user.click(await screen.findByRole("menuitem", { name: "Duplicate" }))
    // agentTeamsWorkspace.duplicatedName === "{name} (copy)"
    expect(storeState.createTeam).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Research Squad (copy)" })
    )
  })
})
