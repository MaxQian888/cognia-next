/** @jest-environment jsdom */

import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"

import type { HostExternalAgentConfigsState } from "@/hooks/agent/use-host-external-agent-configs"
import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"

import { HostAgentList } from "./host-agent-list"

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

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

// Rows in these tests only carry the config fields the card reads.
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

  it("renders one card per Host agent with its mark, name and connection", () => {
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
    expect(screen.getByText("eac_1")).toBeInTheDocument()
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
      within(screen.getByTestId("host-agent-eac_1")).getByTestId("lifecycle-status-notice")
    ).toHaveAttribute("data-status", "needs-runtime")
    expect(screen.getByTestId("host-agent-switch-eac_2")).not.toBeDisabled()
  })

  it("disables every control while a write is in flight", () => {
    setHost({ busy: true, configs: [record()] })
    render(<HostAgentList />)
    expect(screen.getByTestId("host-agent-switch-eac_1")).toBeDisabled()
    expect(screen.getByTestId("host-agent-mode-eac_1")).toBeDisabled()
    expect(screen.getByTestId("host-agent-menu-eac_1")).toBeDisabled()
  })

  it("toggles through the Host and confirms only an accepted write", async () => {
    const user = userEvent.setup()
    const row = record()
    const update = jest.fn(async () => true)
    setHost({ configs: [row], update })
    render(<HostAgentList />)

    await user.click(screen.getByTestId("host-agent-switch-eac_1"))
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

  it("changes the permission mode through the Host", async () => {
    const user = userEvent.setup()
    const row = record()
    const update = jest.fn(async () => true)
    setHost({ configs: [row], update })
    render(<HostAgentList />)

    await user.click(screen.getByTestId("host-agent-mode-eac_1"))
    await user.click(await screen.findByRole("option", { name: "Plan" }))
    await waitFor(() => expect(update).toHaveBeenCalledWith(row, { defaultPermissionMode: "plan" }))
    expect(toastSuccess).toHaveBeenCalledWith("Change saved on the Host.")
  })

  it("shows the mode clamped to what the protocol can run", () => {
    setHost({
      configs: [
        record({
          config: {
            name: "Remote",
            protocol: "a2a",
            transport: "http",
            defaultPermissionMode: "plan",
          },
        }),
      ],
    })
    render(<HostAgentList />)
    // a2a only runs as `default`; a stored `plan` must not be shown as if it applied.
    expect(screen.getByTestId("host-agent-mode-eac_1")).toHaveTextContent("Default")
    expect(screen.getByTestId("host-agent-mode-eac_1")).not.toHaveTextContent("Plan")
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
    setHost({ error: "relay timeout", refresh })
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
    setHost({ error: "relay timeout", loading: true })
    render(<HostAgentList />)
    expect(screen.getByTestId("host-agents-loading")).toBeInTheDocument()
    expect(screen.queryByTestId("host-agents-load-failed")).toBeNull()
    expect(screen.queryByTestId("host-agents-error")).toBeNull()
  })
})
