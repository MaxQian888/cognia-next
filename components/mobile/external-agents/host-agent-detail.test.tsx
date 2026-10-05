/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"

import { TooltipProvider } from "@/components/ui/tooltip"
import type { HostExternalAgentConfigsState } from "@/hooks/agent/use-host-external-agent-configs"
import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"

import { HostAgentDetail } from "./host-agent-detail"

const mockPush = jest.fn()
const mockReplace = jest.fn()

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace, back: jest.fn() }),
  usePathname: () => "/me/external-agents/detail",
  useSearchParams: () => new URLSearchParams(),
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

const hostState: { current: HostExternalAgentConfigsState } = {
  current: {} as HostExternalAgentConfigsState,
}

jest.mock("@/hooks/agent/use-host-external-agent-configs", () => ({
  useHostExternalAgentConfigs: () => hostState.current,
}))

jest.mock("@/hooks/agent/use-external-agent-process-plane", () => ({
  useExternalAgentProcessPlane: () => ({ ok: true }),
}))

// The model picker reads the settings and account stores; a stub keeps this
// suite about the detail screen.
jest.mock("@/components/agent/external-agent/cognia-model-picker", () => ({
  CogniaModelPicker: () => null,
}))

jest.mock("@/components/icons/brand-icon", () => ({
  BrandIcon: ({ id }: { id: string }) => <span data-testid={`brand-icon-${id}`} />,
}))

const toastSuccess = toast.success as jest.Mock

beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn()
  Element.prototype.hasPointerCapture = jest.fn(() => false)
  Element.prototype.setPointerCapture = jest.fn()
  Element.prototype.releasePointerCapture = jest.fn()
})

type RecordOverrides = Omit<Partial<ExternalAgentConfigRecord>, "config"> & {
  config?: Partial<ExternalAgentConfigRecord["config"]>
}

function record(over: RecordOverrides = {}): ExternalAgentConfigRecord {
  const { config, ...rest } = over
  return {
    configId: "eac_1",
    revision: "eacr_1",
    lifecycleGeneration: 1,
    seq: 1,
    enabled: true,
    lifecycleStatus: "ready",
    createdAt: 1,
    updatedAt: 1,
    ...rest,
    config: {
      name: "Codex",
      protocol: "acp",
      transport: "stdio",
      defaultPermissionMode: "default",
      process: { command: "codex-acp", args: [] },
      metadata: { preset: "codex" },
      ...config,
    },
  } as ExternalAgentConfigRecord
}

function setHost(over: Partial<HostExternalAgentConfigsState> = {}) {
  hostState.current = {
    configs: [record()],
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
    duplicate: jest.fn(),
    ...over,
  } as HostExternalAgentConfigsState
}

function detail(configId = "eac_1") {
  return (
    <TooltipProvider>
      <HostAgentDetail configId={configId} />
    </TooltipProvider>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  setHost()
})

describe("HostAgentDetail: states", () => {
  it("explains a Host that cannot serve configurations", () => {
    setHost({ unavailable: "no-host" })
    render(detail())
    expect(screen.getByTestId("host-agent-detail-unavailable")).toBeInTheDocument()
  })

  it("shows a skeleton while the first load is in flight", () => {
    setHost({ loading: true, configs: [] })
    render(detail())
    expect(screen.getByTestId("host-agent-detail-loading")).toHaveAttribute("aria-busy", "true")
  })

  it("offers a retry when the Host could not be read", async () => {
    const user = userEvent.setup()
    const refresh = jest.fn(async () => {})
    setHost({ configs: [], error: "relay timeout", refresh })
    render(detail())
    expect(screen.getByTestId("host-agent-detail-load-failed")).toHaveTextContent("relay timeout")
    await user.click(screen.getByTestId("host-agent-detail-retry"))
    expect(refresh).toHaveBeenCalled()
  })

  it("says the agent is gone, with a way back, when the Host no longer has it", () => {
    render(detail("eac_missing"))
    expect(screen.getByTestId("host-agent-detail-not-found")).toHaveTextContent(
      "This agent is no longer on your Host"
    )
    expect(screen.getByRole("link", { name: "All agents" })).toHaveAttribute(
      "href",
      "/me/external-agents"
    )
  })
})

describe("HostAgentDetail: header", () => {
  it("shows the agent, its state, readiness and lineage", () => {
    setHost({
      configs: [
        record(),
        record({
          configId: "eac_2",
          revision: "eacr_2",
          config: { name: "Codex RO", stateIsolation: "isolated", duplicatedFromAgentId: "eac_1" },
        }),
      ],
    })
    render(detail("eac_2"))
    const header = screen.getByTestId("host-agent-detail-header")
    expect(within(header).getByText("Codex RO")).toBeInTheDocument()
    expect(within(header).getByText("acp · stdio")).toBeInTheDocument()
    expect(within(header).getByTestId("brand-icon-codex")).toBeInTheDocument()
    expect(within(header).getByTestId("host-agent-isolation-eac_2")).toHaveTextContent("Own state")
    expect(within(header).getByTestId("host-agent-detail-ready")).toHaveTextContent("Ready")
    expect(within(header).getByRole("link", { name: "Copied from Codex" })).toHaveAttribute(
      "href",
      "/me/external-agents/detail?id=eac_1"
    )
  })

  it("says when the source of a copy has been removed", () => {
    setHost({ configs: [record({ config: { duplicatedFromAgentId: "eac_gone" } })] })
    render(detail())
    expect(screen.getByTestId("host-agent-detail-lineage")).toHaveTextContent(
      "Copied from an agent that has since been removed"
    )
  })

  it("explains why the Host cannot run it and keeps it switched off", () => {
    setHost({
      configs: [
        record({
          lifecycleStatus: "needs-credentials",
          enabled: false,
          config: { lifecycleReasonCode: "credential_missing" },
        }),
      ],
    })
    render(detail())
    expect(screen.getByTestId("lifecycle-status-notice")).toHaveAttribute(
      "data-status",
      "needs-credentials"
    )
    expect(screen.queryByTestId("host-agent-detail-ready")).toBeNull()
    expect(screen.getByTestId("host-agent-detail-enabled")).toBeDisabled()
  })
})

describe("HostAgentDetail: editing", () => {
  it("seeds the form from the saved configuration", () => {
    setHost({
      configs: [record({ config: { description: "Read-only reviews", maxConcurrentSessions: 2 } })],
    })
    render(detail())
    expect(screen.getByTestId("host-agent-detail-name")).toHaveValue("Codex")
    expect(screen.getByTestId("host-agent-detail-description")).toHaveValue("Read-only reviews")
    expect(screen.getByTestId("host-agent-detail-max-sessions")).toHaveValue(2)
    expect(screen.getByTestId("host-agent-detail-enabled")).toBeChecked()
    // Absent isolation is the shared state every older configuration keeps.
    expect(screen.getByRole("radio", { name: /Shared state/ })).toBeChecked()
  })

  it("saves the edit as one patch at the revision it was read at", async () => {
    const user = userEvent.setup()
    const row = record()
    const update = jest.fn(async () => true)
    setHost({ configs: [row], update })
    render(detail())

    await user.clear(screen.getByTestId("host-agent-detail-name"))
    await user.type(screen.getByTestId("host-agent-detail-name"), "Codex RO")
    await user.type(screen.getByTestId("host-agent-detail-description"), "Reviews only")
    await user.click(screen.getByTestId("host-agent-detail-permission"))
    await user.click(await screen.findByRole("option", { name: "Plan" }))
    await user.type(screen.getByTestId("host-agent-detail-max-sessions"), "3")
    await user.click(screen.getByTestId("host-agent-detail-save"))

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    const [sentRecord, patch] = update.mock.calls[0] as unknown as [
      ExternalAgentConfigRecord,
      Record<string, unknown>,
    ]
    expect(sentRecord).toBe(row)
    expect(patch).toMatchObject({
      name: "Codex RO",
      description: "Reviews only",
      defaultPermissionMode: "plan",
      maxConcurrentSessions: 3,
      enabled: true,
      stateIsolation: "shared",
      process: expect.objectContaining({ command: "codex-acp" }),
      metadata: expect.objectContaining({ preset: "codex" }),
    })
    expect(toastSuccess).toHaveBeenCalledWith("Changes saved on the Host.")
  })

  it("warns that moving to own state means signing in again", async () => {
    const user = userEvent.setup()
    const update = jest.fn(async () => true)
    setHost({ update })
    render(detail())
    expect(screen.queryByTestId("state-isolation-sign-in-warning")).toBeNull()
    await user.click(screen.getByRole("radio", { name: /Own state/ }))
    expect(screen.getByTestId("state-isolation-sign-in-warning")).toBeInTheDocument()
    await user.click(screen.getByTestId("host-agent-detail-save"))
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ stateIsolation: "isolated" })
      )
    )
  })

  it("clears the session limit and an emptied description with null", async () => {
    const user = userEvent.setup()
    const update = jest.fn(async () => true)
    setHost({
      configs: [record({ config: { maxConcurrentSessions: 2, description: "d" } })],
      update,
    })
    render(detail())
    await user.clear(screen.getByTestId("host-agent-detail-max-sessions"))
    await user.clear(screen.getByTestId("host-agent-detail-description"))
    await user.click(screen.getByTestId("host-agent-detail-save"))
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ maxConcurrentSessions: null, description: null })
      )
    )
  })

  it("refuses an invalid session limit without calling the Host", async () => {
    const update = jest.fn(async () => true)
    setHost({ update })
    render(detail())
    fireEvent.change(screen.getByTestId("host-agent-detail-max-sessions"), {
      target: { value: "0" },
    })
    fireEvent.submit(screen.getByTestId("host-agent-config-form"))
    expect(await screen.findByTestId("host-agent-detail-problem")).toHaveTextContent(
      "Enter a whole number above zero"
    )
    expect(update).not.toHaveBeenCalled()
  })

  it("refuses an empty name with the add flow's message", async () => {
    const update = jest.fn(async () => true)
    setHost({ update })
    render(detail())
    fireEvent.change(screen.getByTestId("host-agent-detail-name"), { target: { value: " " } })
    fireEvent.submit(screen.getByTestId("host-agent-config-form"))
    expect(await screen.findByTestId("host-agent-detail-problem")).toBeInTheDocument()
    expect(update).not.toHaveBeenCalled()
  })

  it("reports a compare-and-swap conflict in words, not as the raw error", async () => {
    const user = userEvent.setup()
    const update = jest.fn(async () => {
      hostState.current = {
        ...hostState.current,
        error: "external agent config eac_1 moved to revision eacr_2 (expected eacr_1)",
      }
      return false
    })
    setHost({ update })
    const view = render(detail())
    await user.click(screen.getByTestId("host-agent-detail-save"))
    await waitFor(() => expect(update).toHaveBeenCalled())
    view.rerender(detail())
    expect(await screen.findByTestId("host-agent-detail-save-error")).toHaveTextContent(
      "This agent was changed on another device."
    )
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it("shows any other refusal with the Host's reason", async () => {
    const user = userEvent.setup()
    const update = jest.fn(async () => {
      hostState.current = { ...hostState.current, error: "keyring locked" }
      return false
    })
    setHost({ update })
    const view = render(detail())
    await user.click(screen.getByTestId("host-agent-detail-save"))
    await waitFor(() => expect(update).toHaveBeenCalled())
    view.rerender(detail())
    expect(await screen.findByTestId("host-agent-detail-save-error")).toHaveTextContent(
      "Could not save: keyring locked"
    )
  })
})

describe("HostAgentDetail: actions", () => {
  it("removes after confirmation and returns to the list", async () => {
    const user = userEvent.setup()
    const row = record()
    const remove = jest.fn(async () => true)
    setHost({ configs: [row], remove })
    render(detail())
    await user.click(screen.getByTestId("host-agent-detail-remove"))
    expect(remove).not.toHaveBeenCalled()
    expect(await screen.findByText("Remove Codex?")).toBeInTheDocument()
    await user.click(screen.getByTestId("host-agent-remove-confirm"))
    await waitFor(() => expect(remove).toHaveBeenCalledWith(row))
    expect(mockReplace).toHaveBeenCalledWith("/me/external-agents")
    expect(toastSuccess).toHaveBeenCalledWith("Codex was removed.")
  })

  it("names the agent on its action buttons", () => {
    render(detail())
    expect(screen.getByRole("button", { name: "Remove Codex" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Duplicate Codex" })).toBeInTheDocument()
  })

  it("stays on the screen when the Host refuses the removal", async () => {
    const user = userEvent.setup()
    const remove = jest.fn(async () => false)
    setHost({ remove })
    render(detail())
    await user.click(screen.getByTestId("host-agent-detail-remove"))
    await user.click(await screen.findByTestId("host-agent-remove-confirm"))
    await waitFor(() => expect(remove).toHaveBeenCalled())
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it("duplicates through the sheet and opens the copy", async () => {
    const user = userEvent.setup()
    const copy = record({ configId: "eac_copy", config: { name: "Codex (copy)" } })
    const duplicate = jest.fn(async () => ({ ok: true as const, record: copy }))
    setHost({ duplicate })
    render(detail())
    await user.click(screen.getByTestId("host-agent-detail-duplicate"))
    expect(await screen.findByTestId("duplicate-name")).toHaveValue("Codex (copy)")
    await user.click(screen.getByTestId("duplicate-submit"))
    await waitFor(() => expect(duplicate).toHaveBeenCalled())
    expect(mockPush).toHaveBeenCalledWith("/me/external-agents/detail?id=eac_copy")
  })
})

describe("HostAgentDetail: siblings", () => {
  it("lists the runtime's other configurations with what differs", () => {
    setHost({
      configs: [
        record({ config: { codexOptions: { sandboxMode: "readOnly" } } }),
        record({
          configId: "eac_2",
          revision: "eacr_2",
          config: {
            name: "Codex RW",
            defaultPermissionMode: "acceptEdits",
            stateIsolation: "isolated",
            codexOptions: { sandboxMode: "workspaceWrite" },
          },
        }),
        record({ configId: "eac_3", revision: "eacr_3", config: { name: "Codex twin" } }),
        record({
          configId: "eac_4",
          revision: "eacr_4",
          config: {
            name: "Other",
            protocol: "a2a",
            transport: "http",
            metadata: {},
            process: undefined,
          },
        }),
      ],
    })
    render(detail())
    const list = screen.getByTestId("host-agent-siblings")
    const rw = within(list).getByTestId("host-agent-sibling-eac_2")
    expect(rw).toHaveAttribute("href", "/me/external-agents/detail?id=eac_2")
    expect(rw).toHaveTextContent("Permission: Accept edits")
    expect(rw).toHaveTextContent("State: Own state")
    expect(rw).toHaveTextContent("Sandbox: workspace write")
    expect(within(list).getByTestId("host-agent-sibling-eac_3")).toHaveTextContent(
      "Sandbox: default"
    )
    expect(within(list).queryByTestId("host-agent-sibling-eac_4")).toBeNull()
  })

  it("says when a sibling has the same settings", () => {
    setHost({
      configs: [record(), record({ configId: "eac_2", revision: "eacr_2", config: { name: "B" } })],
    })
    render(detail())
    expect(screen.getByTestId("host-agent-sibling-eac_2")).toHaveTextContent(
      "Same settings as this one"
    )
  })

  it("has no siblings section for a runtime with one configuration", () => {
    render(detail())
    expect(screen.queryByTestId("host-agent-siblings")).toBeNull()
  })
})
