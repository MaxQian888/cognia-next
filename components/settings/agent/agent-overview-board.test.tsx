/** Summary filters, attention actions, and first-run preset selection. */

import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AgentOverviewBoard } from "./agent-overview-board"
import type { AgentReadiness } from "@/lib/ai/agent/external/agent-readiness"
import type { LifecycleExternalAgentConfig } from "@/stores/agent/external-agent-store"

jest.mock("@/components/agent/external-agent/add-agent/preset-picker-list", () => ({
  PresetPickerList: ({
    onPick,
    disabled,
  }: {
    onPick: (id: string) => void
    disabled?: boolean
  }) => (
    <div data-testid="preset-picker-list">
      <button onClick={() => onPick("codex")} disabled={disabled}>
        Codex CLI
      </button>
      <button onClick={() => onPick("custom")} disabled={disabled}>
        Custom configuration
      </button>
    </div>
  ),
}))

const agent = (id: string, name: string) =>
  ({
    id,
    name,
    protocol: "acp",
    transport: "stdio",
    enabled: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }) as unknown as LifecycleExternalAgentConfig

const readiness = (over: Partial<AgentReadiness> = {}): AgentReadiness => ({
  state: "connected",
  ready: (over.state ?? "connected") === "connected",
  blockReason: null,
  blockTransient: false,
  steps: [
    { id: "configured", state: "done" },
    { id: "runnable", state: "done" },
    { id: "connected", state: "done" },
    { id: "routed", state: "done", optional: true },
  ],
  nextAction: null,
  ...over,
})

const entries = [
  { agent: agent("ready", "Ready agent"), readiness: readiness() },
  {
    agent: agent("off", "Off agent"),
    readiness: readiness({ state: "off", nextAction: "connect" }),
  },
  {
    agent: agent("blocked", "Blocked agent"),
    readiness: readiness({
      state: "blocked",
      blockReason: "runtime not installed",
      nextAction: "inspect",
    }),
  },
  { agent: agent("connecting", "Connecting agent"), readiness: readiness({ state: "connecting" }) },
  {
    agent: agent("disabled", "Disabled agent"),
    readiness: readiness({ state: "disabled", nextAction: "enable" }),
  },
]

function renderBoard(over: Partial<Parameters<typeof AgentOverviewBoard>[0]> = {}) {
  const props = {
    entries,
    stateFilter: "all" as const,
    onStateFilterChange: jest.fn(),
    onOpenAgent: jest.fn(),
    onAction: jest.fn(),
    onPickPreset: jest.fn(),
    ...over,
  }
  render(<AgentOverviewBoard {...props} />)
  return props
}

describe("AgentOverviewBoard", () => {
  it.each(["Codex (app-server)", "Work assistant"])(
    "shows the Codex icon for %s without preset metadata",
    (name) => {
      renderBoard({
        entries: [
          {
            agent: {
              ...agent("codex", name),
              protocol: "codex-app-server",
              process: { command: "codex", args: ["app-server"] },
            },
            readiness: readiness({ state: "off", nextAction: "connect" }),
          },
        ],
      })
      expect(screen.getByTestId("overview-open-codex").querySelector("img")).toHaveAttribute(
        "src",
        "/icons/lobe/codex-color.svg"
      )
    }
  )

  it("counts status groups without rendering a progress bar or the whole fleet", () => {
    renderBoard()
    expect(screen.getByTestId("overview-filter-connected")).toHaveTextContent("1")
    expect(screen.getByTestId("overview-filter-attention")).toHaveTextContent("2")
    expect(screen.getByTestId("overview-filter-off")).toHaveTextContent("2")
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
    expect(screen.queryByTestId("overview-row-ready")).not.toBeInTheDocument()
    expect(screen.queryByTestId("overview-row-connecting")).not.toBeInTheDocument()
    expect(screen.getAllByTestId(/^overview-row-/)).toHaveLength(3)
  })

  it.each(["connected", "attention", "off"] as const)(
    "selects the %s rail filter",
    async (filter) => {
      const user = userEvent.setup()
      const { onStateFilterChange } = renderBoard()
      const toggle = screen.getByTestId(`overview-filter-${filter}`)
      expect(toggle).toHaveAttribute("aria-pressed", "false")
      await user.click(toggle)
      expect(onStateFilterChange).toHaveBeenCalledWith(filter)
    }
  )

  it("reflects and clears the selected filter", async () => {
    const user = userEvent.setup()
    const { onStateFilterChange } = renderBoard({ stateFilter: "attention" })
    const toggle = screen.getByTestId("overview-filter-attention")
    expect(toggle).toHaveAttribute("aria-pressed", "true")
    await user.click(toggle)
    expect(onStateFilterChange).toHaveBeenCalledWith("all")
  })

  it("opens the inspector and runs the next action for an attention row", async () => {
    const user = userEvent.setup()
    const { onOpenAgent, onAction } = renderBoard()
    await user.click(screen.getByTestId("overview-open-blocked"))
    expect(onOpenAgent).toHaveBeenCalledWith("blocked")
    await user.click(screen.getByTestId("overview-action-off"))
    expect(onAction).toHaveBeenCalledWith("off", "connect")
    await user.click(screen.getByTestId("overview-action-blocked"))
    expect(onAction).toHaveBeenCalledWith("blocked", "inspect")
    expect(
      within(screen.getByTestId("overview-row-blocked")).getByText("runtime not installed")
    ).toBeInTheDocument()
  })

  it("keeps optional routing in a muted suggestions list and shows all-clear", async () => {
    const user = userEvent.setup()
    const { onAction } = renderBoard({
      entries: [
        { agent: agent("unrouted", "Unrouted"), readiness: readiness({ nextAction: "add-rule" }) },
        { agent: agent("ready", "Ready"), readiness: readiness() },
      ],
    })
    expect(screen.getByTestId("overview-all-clear")).toBeInTheDocument()
    expect(screen.queryByTestId("overview-rows")).not.toBeInTheDocument()
    expect(screen.queryByTestId("overview-row-unrouted")).not.toBeInTheDocument()
    expect(screen.queryByTestId("overview-suggestion-ready")).not.toBeInTheDocument()
    await user.click(within(screen.getByTestId("overview-suggestion-unrouted")).getByRole("button"))
    expect(onAction).toHaveBeenCalledWith("unrouted", "add-rule")
  })

  it("shows the failure headline and softens transient blockers", () => {
    renderBoard({
      entries: [
        {
          agent: agent("failed", "Failed"),
          readiness: readiness({ state: "error", nextAction: "retry" }),
          failureHeadline: "Process exited unexpectedly",
        },
        {
          agent: agent("checking", "Checking"),
          readiness: readiness({
            state: "blocked",
            blockReason: "runtime update in progress",
            blockTransient: true,
          }),
        },
      ],
    })
    expect(screen.getByText("Process exited unexpectedly")).toBeInTheDocument()
    expect(screen.getByText("runtime update in progress")).toHaveClass("text-muted-foreground")
  })

  it("offers per-agent remedies without a global gate", () => {
    renderBoard({
      entries: [
        entries[1],
        entries[2],
        entries[4],
        { agent: agent("unrouted", "Unrouted"), readiness: readiness({ nextAction: "add-rule" }) },
        {
          agent: agent("failed", "Failed"),
          readiness: readiness({ state: "error", nextAction: "retry" }),
        },
      ],
    })
    expect(screen.getByTestId("overview-action-off")).toBeEnabled()
    expect(screen.getByTestId("overview-action-failed")).toBeEnabled()
    expect(screen.getByTestId("overview-action-disabled")).toBeEnabled()
    expect(
      within(screen.getByTestId("overview-suggestion-unrouted")).getByRole("button")
    ).toBeEnabled()
    expect(screen.getByTestId("overview-action-blocked")).toBeEnabled()
  })

  it("offers preset and custom configuration without a duplicate Add button on first run", async () => {
    const user = userEvent.setup()
    const { onPickPreset } = renderBoard({ entries: [] })
    expect(screen.getByTestId("preset-picker-list")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Codex CLI" }))
    expect(onPickPreset).toHaveBeenCalledWith("codex")
    await user.click(screen.getByRole("button", { name: "Custom configuration" }))
    expect(onPickPreset).toHaveBeenCalledWith("custom")
    expect(screen.queryByRole("button", { name: "Add Agent" })).not.toBeInTheDocument()
    const heading = screen.getByRole("heading", { level: 2 })
    expect(heading).toHaveAttribute("data-detail-heading", "overview")
    expect(heading).toHaveAttribute("tabindex", "-1")
  })

  it("keeps the first-run picker available", () => {
    renderBoard({ entries: [] })
    for (const button of screen.getAllByRole("button")) expect(button).toBeEnabled()
  })
})
