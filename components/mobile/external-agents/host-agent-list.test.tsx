/** @jest-environment jsdom */

// Resolve complete namespaces from split sources; aggregates are rebuilt by the orchestrator.
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"

import type { HostExternalAgentConfigsState } from "@/hooks/agent/use-host-external-agent-configs"
import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"

import { HostAgentList } from "./host-agent-list"

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

const mockPush = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
}))

const hostState: { current: HostExternalAgentConfigsState } = {
  current: {} as HostExternalAgentConfigsState,
}

jest.mock("@/hooks/agent/use-host-external-agent-configs", () => ({
  useHostExternalAgentConfigs: () => hostState.current,
}))

// The real mark is decorative (aria-hidden); a stub makes "which brand" assertable.
jest.mock("@/components/icons/brand-icon", () => ({
  BrandIcon: ({ id }: { id: string }) => <span data-testid={`brand-icon-${id}`} />,
}))

const toastSuccess = toast.success as jest.Mock

// Radix Select / DropdownMenu need pointer and scroll APIs jsdom lacks.
beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn()
  Element.prototype.hasPointerCapture = jest.fn(() => false)
  Element.prototype.setPointerCapture = jest.fn()
  Element.prototype.releasePointerCapture = jest.fn()
})

// Rows in these tests only carry the config fields the list reads.
type RecordOverrides = Omit<Partial<ExternalAgentConfigRecord>, "config"> & {
  config?: Partial<ExternalAgentConfigRecord["config"]>
}

function record(over: RecordOverrides = {}): ExternalAgentConfigRecord {
  return {
    configId: "eac_1",
    revision: "eacr_1",
    lifecycleGeneration: 1,
    seq: 1,
    enabled: true,
    lifecycleStatus: "ready",
    createdAt: 1,
    updatedAt: 1,
    config: {
      name: "Claude Code",
      protocol: "acp",
      transport: "stdio",
      defaultPermissionMode: "default",
      metadata: { preset: "claude-code" },
    },
    ...over,
  } as ExternalAgentConfigRecord
}

function setHost(over: Partial<HostExternalAgentConfigsState> = {}) {
  hostState.current = {
    configs: [],
    loading: false,
    loaded: true,
    unavailable: null,
    error: null,
    busy: false,
    refresh: jest.fn(async () => {}),
    reconcile: jest.fn(async () => {}),
    setEnabled: jest.fn(async () => {}),
    update: jest.fn(async () => true),
    remove: jest.fn(async () => true),
    copyLocal: jest.fn(async () => {}),
    create: jest.fn(),
    duplicate: jest.fn(),
    ...over,
  } as HostExternalAgentConfigsState
}

beforeEach(() => {
  jest.clearAllMocks()
  setHost()
})

describe("HostAgentList", () => {
  it("explains a Host that cannot serve the list", () => {
    setHost({ unavailable: "no-host" })
    render(<HostAgentList />)
    expect(screen.getByTestId("host-agents-unavailable")).toHaveTextContent(
      "Pair a host to configure external agents that can actually run."
    )
    expect(screen.queryByTestId("host-agents-section")).toBeNull()
  })

  it("shows placeholders while the first load is in flight", () => {
    setHost({ loading: true })
    render(<HostAgentList />)
    expect(screen.getByTestId("host-agents-loading")).toBeInTheDocument()
    expect(screen.queryByTestId("host-agents-empty")).toBeNull()
  })

  it("keeps the rows on screen during a reload", () => {
    setHost({ loading: true, configs: [record()] })
    render(<HostAgentList />)
    expect(screen.queryByTestId("host-agents-loading")).toBeNull()
    expect(screen.getByTestId("host-agent-eac_1")).toBeInTheDocument()
  })

  it("offers the add flow from the empty state", () => {
    render(<HostAgentList />)
    const empty = screen.getByTestId("host-agents-empty")
    expect(empty).toHaveTextContent("No agents on your Host yet")
    expect(within(empty).getByRole("link", { name: "Add agent" })).toHaveAttribute(
      "href",
      "/me/external-agents/new"
    )
  })

  it("renders divided Host rows with their mark, name and connection", () => {
    setHost({
      configs: [
        record(),
        record({
          configId: "eac_2",
          config: { name: "Mine", protocol: "a2a", transport: "http", metadata: {} },
        }),
      ],
    })
    render(<HostAgentList />)

    const first = screen.getByTestId("host-agent-eac_1")
    expect(within(first).getByText("Claude Code")).toBeInTheDocument()
    expect(within(first).getByText("acp · stdio")).toBeInTheDocument()
    expect(within(first).getByTestId("brand-icon-claude-code")).toBeInTheDocument()

    const second = screen.getByTestId("host-agent-eac_2")
    expect(within(second).getByText("Mine")).toBeInTheDocument()
    expect(within(second).getByText("a2a · http")).toBeInTheDocument()
    // No preset: a generic mark, not a brand.
    expect(within(second).queryByTestId(/brand-icon-/)).toBeNull()

    expect(screen.getByTestId("host-agents-add")).toHaveAttribute("href", "/me/external-agents/new")
  })

  it("falls back to the config id when a row has no name", () => {
    setHost({ configs: [record({ config: { protocol: "acp", transport: "stdio" } })] })
    render(<HostAgentList />)
    expect(within(screen.getByTestId("host-agent-eac_1")).getByText("eac_1")).toBeInTheDocument()
  })

  it("will not offer the switch for a config the Host says cannot run", () => {
    setHost({
      configs: [
        record({ lifecycleStatus: "needs-runtime", enabled: false }),
        record({ configId: "eac_2" }),
      ],
    })
    render(<HostAgentList />)
    expect(screen.getByTestId("host-agent-switch-eac_1")).toBeDisabled()
    expect(
      within(screen.getByTestId("host-agent-eac_1")).getByText("Needs attention")
    ).toBeInTheDocument()
    expect(screen.getByTestId("host-agent-switch-eac_2")).not.toBeDisabled()
  })

  it("disables every control while a write is in flight", () => {
    setHost({ busy: true, configs: [record()] })
    render(<HostAgentList />)
    expect(screen.getByTestId("host-agent-switch-eac_1")).toBeDisabled()
    expect(screen.getByTestId("host-agent-menu-eac_1")).toBeDisabled()
  })

  it("toggles through the Host and confirms only an accepted write", async () => {
    const user = userEvent.setup()
    const row = record()
    const update = jest.fn(async () => true)
    setHost({ configs: [row], update })
    render(<HostAgentList />)

    const target = screen.getByTestId("host-agent-switch-eac_1").closest("label")!
    expect(target).toHaveClass("size-11")
    await user.click(target)
    await waitFor(() => expect(update).toHaveBeenCalledWith(row, { enabled: false }))
    expect(toastSuccess).toHaveBeenCalledWith("Change saved on the Host.")
  })

  it("does not toast a refused toggle", async () => {
    const user = userEvent.setup()
    const update = jest.fn(async () => false)
    setHost({ configs: [record()], update })
    render(<HostAgentList />)

    await user.click(screen.getByTestId("host-agent-switch-eac_1"))
    await waitFor(() => expect(update).toHaveBeenCalled())
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it("leaves permission editing in the detail instead of on every row", () => {
    setHost({ configs: [record()] })
    render(<HostAgentList />)
    expect(within(screen.getByTestId("host-agent-eac_1")).queryByRole("combobox")).toBeNull()
    expect(screen.getByRole("link", { name: "Open Claude Code" })).toHaveAttribute(
      "href",
      "/me/external-agents/detail?id=eac_1"
    )
  })

  it("removes an agent only after confirmation and toasts on success", async () => {
    const user = userEvent.setup()
    const row = record()
    const remove = jest.fn(async () => true)
    setHost({ configs: [row], remove })
    render(<HostAgentList />)

    await user.click(screen.getByTestId("host-agent-menu-eac_1"))
    await user.click(await screen.findByTestId("host-agent-remove-eac_1"))
    expect(remove).not.toHaveBeenCalled()
    expect(await screen.findByText("Remove Claude Code?")).toBeInTheDocument()

    await user.click(screen.getByTestId("host-agent-remove-confirm"))
    await waitFor(() => expect(remove).toHaveBeenCalledWith(row))
    expect(toastSuccess).toHaveBeenCalledWith("Claude Code was removed.")
  })

  it("does not toast a removal the Host refused", async () => {
    const user = userEvent.setup()
    const remove = jest.fn(async () => false)
    setHost({ configs: [record()], remove })
    render(<HostAgentList />)

    await user.click(screen.getByTestId("host-agent-menu-eac_1"))
    await user.click(await screen.findByTestId("host-agent-remove-eac_1"))
    await user.click(await screen.findByTestId("host-agent-remove-confirm"))
    await waitFor(() => expect(remove).toHaveBeenCalled())
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it("keeps the agent when the confirmation is cancelled", async () => {
    const user = userEvent.setup()
    const remove = jest.fn(async () => true)
    setHost({ configs: [record()], remove })
    render(<HostAgentList />)

    await user.click(screen.getByTestId("host-agent-menu-eac_1"))
    await user.click(await screen.findByTestId("host-agent-remove-eac_1"))
    await user.click(await screen.findByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByText("Remove Claude Code?")).toBeNull())
    expect(remove).not.toHaveBeenCalled()
  })

  it("shows the Host's last error above the list", () => {
    setHost({ configs: [record()], error: "revision conflict" })
    render(<HostAgentList />)
    expect(screen.getByTestId("host-agents-error")).toHaveTextContent(
      "Could not save the change: revision conflict"
    )
    expect(screen.queryByTestId("host-agents-load-failed")).toBeNull()
  })

  it("shows a failed load as a load failure with a retry, not as an empty Host", async () => {
    const user = userEvent.setup()
    const refresh = jest.fn(async () => {})
    setHost({ loaded: false, error: "relay timeout", refresh })
    render(<HostAgentList />)

    expect(screen.getByTestId("host-agents-load-failed")).toHaveTextContent(
      "Could not load external agents: relay timeout"
    )
    expect(screen.queryByTestId("host-agents-empty")).toBeNull()
    expect(screen.queryByTestId("host-agents-error")).toBeNull()
    await user.click(screen.getByTestId("host-agents-retry"))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("keeps showing the skeleton while a reload after a failure is in flight", () => {
    setHost({ loaded: false, error: "relay timeout", loading: true })
    render(<HostAgentList />)
    expect(screen.getByTestId("host-agents-loading")).toBeInTheDocument()
    expect(screen.queryByTestId("host-agents-load-failed")).toBeNull()
    expect(screen.queryByTestId("host-agents-error")).toBeNull()
  })

  it("opens the detail screen from the row identity, with the controls outside the link", () => {
    setHost({ configs: [record()] })
    render(<HostAgentList />)
    const link = screen.getByRole("link", { name: "Open Claude Code" })
    expect(link).toHaveAttribute("href", "/me/external-agents/detail?id=eac_1")
    // No interactive control nested inside the link.
    expect(within(link).queryByRole("switch")).toBeNull()
    expect(within(link).queryByRole("combobox")).toBeNull()
    expect(within(link).queryByRole("button")).toBeNull()
  })

  it("says where each agent keeps its state and which one it was copied from", () => {
    setHost({
      configs: [
        record({ config: { name: "Codex", protocol: "acp", transport: "stdio" } }),
        record({
          configId: "eac_2",
          config: {
            name: "Codex RO",
            protocol: "acp",
            transport: "stdio",
            stateIsolation: "isolated",
            duplicatedFromAgentId: "eac_1",
          },
        }),
      ],
    })
    render(<HostAgentList />)
    expect(screen.getByTestId("host-agent-isolation-eac_1")).toHaveTextContent("Shared state")
    expect(screen.getByTestId("host-agent-isolation-eac_2")).toHaveTextContent("Own state")
    expect(screen.getByTestId("host-agent-lineage-eac_2")).toHaveTextContent("Copy of Codex")
    expect(screen.queryByTestId("host-agent-lineage-eac_1")).toBeNull()
  })

  it("groups two configurations of one runtime under the runtime's name", () => {
    setHost({
      configs: [
        record({
          config: {
            name: "Codex RO",
            protocol: "acp",
            transport: "stdio",
            metadata: { preset: "codex" },
          },
        }),
        record({
          configId: "eac_2",
          config: { name: "Mine", protocol: "a2a", transport: "http", metadata: {} },
        }),
        record({
          configId: "eac_3",
          config: {
            name: "Codex RW",
            protocol: "acp",
            transport: "stdio",
            metadata: { preset: "codex" },
          },
        }),
      ],
    })
    render(<HostAgentList />)
    const group = screen.getByRole("group", { name: /Codex/ })
    expect(group).toHaveTextContent("2 configurations")
    expect(within(group).getByTestId("host-agent-eac_1")).toBeInTheDocument()
    expect(within(group).getByTestId("host-agent-eac_3")).toBeInTheDocument()
    expect(within(group).queryByTestId("host-agent-eac_2")).toBeNull()
    expect(screen.getAllByRole("group")).toHaveLength(2)
    const row = within(group).getByTestId("host-agent-eac_1")
    expect(row.parentElement).toHaveClass("divide-y", "border")
    expect(row).not.toHaveClass("border")
  })

  it("searches configurations while preserving runtime grouping and lineage", async () => {
    const user = userEvent.setup()
    setHost({
      configs: [
        record(),
        record({
          configId: "eac_2",
          config: {
            name: "Claude work",
            protocol: "acp",
            transport: "stdio",
            duplicatedFromAgentId: "eac_1",
            metadata: { preset: "claude-code" },
          },
        }),
        record({
          configId: "eac_3",
          config: {
            name: "Remote",
            protocol: "a2a",
            transport: "http",
          },
        }),
      ],
    })
    render(<HostAgentList />)
    await user.type(screen.getByRole("textbox", { name: "Search agents" }), " work ")
    expect(screen.queryByTestId("host-agent-eac_1")).toBeNull()
    expect(screen.queryByTestId("host-agent-eac_3")).toBeNull()
    const group = screen.getByRole("group", { name: /Claude Code/ })
    expect(within(group).getByTestId("host-agent-eac_2")).toBeInTheDocument()
    expect(within(group).getByText("Copy of Claude Code")).toBeInTheDocument()
  })

  it("keeps same-name configurations distinguishable after search and state filters", async () => {
    const user = userEvent.setup()
    setHost({
      configs: [
        record({
          config: {
            name: "Codex",
            description: "Work",
            protocol: "acp",
            transport: "stdio",
            defaultPermissionMode: "default",
            stateIsolation: "shared",
            metadata: { preset: "codex" },
          },
        }),
        record({
          configId: "eac_2",
          enabled: false,
          config: {
            name: "Codex",
            description: "Review",
            protocol: "acp",
            transport: "stdio",
            defaultPermissionMode: "plan",
            stateIsolation: "isolated",
            metadata: { preset: "codex" },
          },
        }),
      ],
    })
    render(<HostAgentList />)
    const first = screen.getByTestId("host-agent-eac_1")
    const second = screen.getByTestId("host-agent-eac_2")
    expect(within(first).getByText("Ask")).toBeInTheDocument()
    expect(within(second).getByText("Plan")).toBeInTheDocument()
    expect(within(first).getAllByText("Shared state")).toHaveLength(1)
    expect(within(second).getAllByText("Own state")).toHaveLength(1)

    const search = screen.getByRole("textbox", { name: "Search agents" })
    await user.type(search, "Review")
    expect(screen.queryByTestId("host-agent-eac_1")).toBeNull()
    expect(within(screen.getByTestId("host-agent-eac_2")).getByText("Plan")).toBeInTheDocument()

    await user.clear(search)
    await user.click(screen.getByRole("combobox", { name: "Filter agents by state" }))
    await user.click(await screen.findByRole("option", { name: "On" }))
    expect(screen.queryByTestId("host-agent-eac_2")).toBeNull()
    expect(within(screen.getByTestId("host-agent-eac_1")).getByText("Ask")).toBeInTheDocument()
  })

  it("filters attention, on and off independently and reports an empty filter result", async () => {
    const user = userEvent.setup()
    setHost({
      configs: [
        record(),
        record({ configId: "eac_2", enabled: false }),
        record({ configId: "eac_3", enabled: false, lifecycleStatus: "needs-runtime" }),
      ],
    })
    render(<HostAgentList />)
    const filter = screen.getByRole("combobox", { name: "Filter agents by state" })
    await user.click(filter)
    await user.click(await screen.findByRole("option", { name: "Needs attention" }))
    expect(screen.getByTestId("host-agent-eac_3")).toBeInTheDocument()
    expect(screen.queryByTestId("host-agent-eac_1")).toBeNull()
    expect(screen.queryByTestId("host-agent-eac_2")).toBeNull()
    await user.click(filter)
    await user.click(await screen.findByRole("option", { name: "On" }))
    expect(screen.getByTestId("host-agent-eac_1")).toBeInTheDocument()
    expect(screen.queryByTestId("host-agent-eac_3")).toBeNull()
    await user.click(filter)
    await user.click(await screen.findByRole("option", { name: "Off" }))
    expect(screen.getByTestId("host-agent-eac_2")).toBeInTheDocument()
    expect(screen.getByTestId("host-agent-eac_3")).toBeInTheDocument()
    await user.type(screen.getByRole("textbox", { name: "Search agents" }), "unknown")
    expect(screen.getByRole("status")).toHaveTextContent("No agents match these filters.")
    expect(screen.queryByTestId("host-agents-empty")).toBeNull()
    expect(screen.getByRole("textbox", { name: "Search agents" })).toHaveValue("unknown")
    await user.clear(screen.getByRole("textbox", { name: "Search agents" }))
    await user.click(filter)
    await user.click(await screen.findByRole("option", { name: "All" }))
    expect(screen.getByTestId("host-agent-eac_1")).toBeInTheDocument()
    expect(screen.getByTestId("host-agent-eac_2")).toBeInTheDocument()
    expect(screen.getByTestId("host-agent-eac_3")).toBeInTheDocument()
  })

  it("offers edit, duplicate and remove in the overflow menu", async () => {
    const user = userEvent.setup()
    setHost({ configs: [record()] })
    render(<HostAgentList />)
    await user.click(screen.getByTestId("host-agent-menu-eac_1"))
    expect(await screen.findByTestId("host-agent-edit-eac_1")).toHaveAttribute(
      "href",
      "/me/external-agents/detail?id=eac_1"
    )
    expect(screen.getByRole("menuitem", { name: "Duplicate Claude Code" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Remove Claude Code" })).toBeInTheDocument()
  })

  it("duplicates through the sheet and opens the copy", async () => {
    const user = userEvent.setup()
    const row = record()
    const copy = record({ configId: "eac_copy", config: { name: "Claude Code (copy)" } })
    const duplicate = jest.fn(async () => ({ ok: true as const, record: copy }))
    setHost({ configs: [row], duplicate })
    render(<HostAgentList />)

    await user.click(screen.getByTestId("host-agent-menu-eac_1"))
    await user.click(await screen.findByTestId("host-agent-duplicate-eac_1"))
    expect(await screen.findByTestId("duplicate-name")).toHaveValue("Claude Code (copy)")
    await user.click(screen.getByTestId("duplicate-submit"))

    await waitFor(() =>
      expect(duplicate).toHaveBeenCalledWith(
        row,
        expect.objectContaining({ name: "Claude Code (copy)" })
      )
    )
    expect(mockPush).toHaveBeenCalledWith("/me/external-agents/detail?id=eac_copy")
  })
})
