/** @jest-environment jsdom */

import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// Resolve complete namespaces from split sources; aggregates are rebuilt by the orchestrator.
import { HostExternalAgentConfigs } from "./host-external-agent-configs"
import { TooltipProvider } from "@/components/ui/tooltip"

/** The app mounts `TooltipProvider` in its layout; the badges need it. */
function renderInShell() {
  return render(
    <TooltipProvider>
      <HostExternalAgentConfigs />
    </TooltipProvider>
  )
}
import type { HostExternalAgentConfigsState } from "@/hooks/agent/use-host-external-agent-configs"
import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"

const state: { current: HostExternalAgentConfigsState } = {
  current: {} as HostExternalAgentConfigsState,
}

jest.mock("@/hooks/agent/use-host-external-agent-configs", () => ({
  useHostExternalAgentConfigs: () => state.current,
}))

jest.mock("@/components/agent/external-agent/add-agent/preset-picker-list", () => ({
  PresetPickerList: ({ onPick }: { onPick: (presetId: string) => void }) => (
    <button onClick={() => onPick("codex")}>Pick Codex runtime</button>
  ),
}))

jest.mock("@/components/agent/external-agent/host/host-agent-editor", () => ({
  HostAgentEditor: ({
    configId,
    onRemoved,
    onDuplicated,
    onSaved,
    onOpenConfig,
  }: {
    configId: string
    onRemoved: () => void
    onDuplicated: (id: string) => void
    onSaved: () => void
    onOpenConfig: (id: string) => void
  }) => (
    <div data-testid="shared-host-editor">
      <span>{configId}</span>
      <button onClick={onRemoved}>Remove edited configuration</button>
      <button onClick={() => onDuplicated("eac_copy")}>Duplicate edited configuration</button>
      <button onClick={onSaved}>Save edited configuration</button>
      <button onClick={() => onOpenConfig("eac_sibling")}>Open sibling configuration</button>
    </div>
  ),
}))

jest.mock("@/components/agent/external-agent/host/host-agent-create-form", () => ({
  HostAgentCreateForm: ({
    presetId,
    onCreated,
    onCancel,
  }: {
    presetId: string
    onCreated: (id: string) => void
    onCancel: () => void
  }) => (
    <div data-testid="shared-host-create-form">
      <span>{presetId}</span>
      <button onClick={() => onCreated("eac_created")}>Create host configuration</button>
      <button onClick={onCancel}>Choose another runtime</button>
    </div>
  ),
}))

const localAgents: {
  current: Record<string, Record<string, unknown> & { id: string; name: string }>
} = { current: {} }

jest.mock("@/hooks/ui/use-mobile", () => ({ useIsMobile: () => false }))

jest.mock("@/components/ui/sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

import { toast } from "@/components/ui/sonner"

jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: (selector: (state: unknown) => unknown) =>
    selector({ agents: localAgents.current }),
}))

function record(over: Partial<ExternalAgentConfigRecord> = {}): ExternalAgentConfigRecord {
  return {
    configId: "eac_1",
    revision: "eacr_1",
    lifecycleGeneration: 1,
    seq: 3,
    enabled: true,
    lifecycleStatus: "ready",
    createdAt: 1,
    updatedAt: 1,
    config: { name: "Pi", protocol: "pi-rpc" },
    ...over,
  } as ExternalAgentConfigRecord
}

function setState(over: Partial<HostExternalAgentConfigsState> = {}) {
  state.current = {
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
    create: jest.fn(async () => ({ ok: false as const, error: "not used" })),
    duplicate: jest.fn(async () => ({ ok: false as const, error: "not used" })),
    ...over,
  }
}

beforeEach(() => {
  localAgents.current = {}
})

describe("HostExternalAgentConfigs", () => {
  it("lists the host's configurations", () => {
    setState({ configs: [record()] })
    render(<HostExternalAgentConfigs />)
    expect(screen.getByText("Pi")).toBeInTheDocument()
    expect(screen.getByText("pi-rpc")).toBeInTheDocument()
  })

  it("shows the revision a run would be admitted against", () => {
    setState({ configs: [record({ seq: 12 })] })
    render(<HostExternalAgentConfigs />)
    expect(screen.getByText(/12/)).toBeInTheDocument()
  })

  // The three unreachable reasons are different screens on purpose: "pair a
  // host", "wait", and "upgrade the host" are three different actions.
  it.each([
    ["no-host", /Pair a host to configure/i],
    ["unsupported", /does not support/i],
    ["manifest-missing", /Waiting for/i],
  ] as const)("explains %s rather than showing an empty list", (reason, copy) => {
    setState({ unavailable: reason })
    render(<HostExternalAgentConfigs />)
    expect(screen.getByText(copy)).toBeInTheDocument()
  })

  it("distinguishes 'this host has none' from 'there is no host'", () => {
    setState({ configs: [] })
    render(<HostExternalAgentConfigs />)
    expect(screen.getByText(/No agents configured on this host/i)).toBeInTheDocument()
    expect(screen.queryByText(/Pair a host/i)).not.toBeInTheDocument()
  })

  it("shows a loading state", () => {
    setState({ loading: true })
    render(<HostExternalAgentConfigs />)
    expect(screen.getByText(/Loading host configurations/i)).toBeInTheDocument()
  })

  it("links an unpaired device to Connectivity settings", () => {
    setState({ unavailable: "no-host", loaded: false })
    render(<HostExternalAgentConfigs />)
    expect(screen.getByRole("link", { name: "Pair a host" })).toHaveAttribute(
      "href",
      "/settings?section=connectivity"
    )
  })

  it("shows a first-load failure with retry without claiming the Host is empty", async () => {
    const refresh = jest.fn(async () => {})
    setState({ loaded: false, error: "relay timeout", refresh })
    render(<HostExternalAgentConfigs />)
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load host configurations")
    expect(screen.getByRole("alert")).toHaveTextContent("relay timeout")
    expect(screen.queryByText(/No agents configured on this host/i)).not.toBeInTheDocument()
    await userEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Retry" }))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("keeps retry loading distinct from its previous failure", () => {
    setState({ loaded: false, loading: true, error: "relay timeout" })
    render(<HostExternalAgentConfigs />)
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.queryByText(/No agents configured on this host/i)).not.toBeInTheDocument()
  })

  it("keeps its focus heading and renders flat divided rows", () => {
    setState({ configs: [record()] })
    const { container } = render(<HostExternalAgentConfigs />)
    expect(screen.getByRole("heading", { name: "Host-owned agents" })).toHaveAttribute(
      "tabindex",
      "-1"
    )
    expect(screen.getByRole("heading", { name: "Host-owned agents" })).toHaveAttribute(
      "data-detail-heading"
    )
    expect(container.querySelector('[data-slot="card"]')).toBeNull()
    expect(screen.getByTestId("host-config-eac_1")).toHaveClass("border-0")
    expect(screen.getByTestId("host-config-eac_1").parentElement).toHaveClass("divide-y")
  })

  it("surfaces a write failure in the panel, not only as a toast", () => {
    setState({ configs: [record()], error: "revision conflict" })
    render(<HostExternalAgentConfigs />)
    expect(screen.getByText("revision conflict")).toBeInTheDocument()
  })

  it("toggles a configuration through the host", async () => {
    const setEnabled = jest.fn(async () => {})
    setState({ configs: [record()], setEnabled })
    render(<HostExternalAgentConfigs />)
    await userEvent.click(screen.getByRole("switch"))
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith(expect.anything(), false))
  })

  // Offering the switch on a config the host says cannot run would imply a
  // choice the user does not have; the host would refuse the write anyway.
  it("locks the switch on a configuration that is not ready", () => {
    setState({ configs: [record({ lifecycleStatus: "needs-credentials", enabled: false })] })
    render(<HostExternalAgentConfigs />)
    expect(screen.getByRole("switch")).toBeDisabled()
  })

  it("renders the readiness verdict a not-ready configuration carries", () => {
    setState({
      configs: [
        record({
          lifecycleStatus: "needs-credentials",
          enabled: false,
          config: {
            name: "Pi",
            protocol: "pi-rpc",
            lifecycleReasonCode: "credential_missing",
          } as never,
        }),
      ],
    })
    render(<HostExternalAgentConfigs />)
    // The notice renders for anything that is not ready; the exact sentence is
    // LifecycleStatusNotice's own contract and is pinned by its own tests.
    expect(screen.getByRole("switch")).toBeDisabled()
    expect(screen.getByText("Pi")).toBeInTheDocument()
  })

  it("asks before deleting, naming the configuration, then deletes through the host", async () => {
    const remove = jest.fn(async () => true)
    setState({ configs: [record()], remove })
    render(<HostExternalAgentConfigs />)
    await userEvent.click(screen.getByRole("button", { name: "Actions for Pi" }))
    await userEvent.click(screen.getByRole("menuitem", { name: /Delete Pi/i }))
    expect(remove).not.toHaveBeenCalled()
    const confirm = screen.getByRole("alertdialog")
    expect(confirm).toHaveTextContent('Delete "Pi" from the host?')
    await userEvent.click(within(confirm).getByRole("button", { name: /^Delete$/ }))
    await waitFor(() =>
      expect(remove).toHaveBeenCalledWith(expect.objectContaining({ configId: "eac_1" }))
    )
  })

  it("keeps the configuration when the deletion is cancelled", async () => {
    const remove = jest.fn(async () => true)
    setState({ configs: [record()], remove })
    render(<HostExternalAgentConfigs />)
    await userEvent.click(screen.getByRole("button", { name: "Actions for Pi" }))
    await userEvent.click(screen.getByRole("menuitem", { name: /Delete Pi/i }))
    await userEvent.click(screen.getByRole("button", { name: /^Cancel$/ }))
    expect(remove).not.toHaveBeenCalled()
  })

  it("asks the host to re-check readiness", async () => {
    const reconcile = jest.fn(async () => {})
    setState({ configs: [record()], reconcile })
    render(<HostExternalAgentConfigs />)
    await userEvent.click(screen.getByRole("button", { name: /Re-check/i }))
    await waitFor(() => expect(reconcile).toHaveBeenCalled())
  })

  it("disables every control while a write is in flight", () => {
    setState({ configs: [record()], busy: true })
    render(<HostExternalAgentConfigs />)
    expect(screen.getByRole("switch")).toBeDisabled()
    expect(screen.getByRole("combobox")).toBeDisabled()
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled()
  })

  it("falls back to the id when a configuration has no name", () => {
    setState({ configs: [record({ config: {} as never })] })
    render(<HostExternalAgentConfigs />)
    expect(screen.getByText("eac_1")).toBeInTheDocument()
  })

  it("updates permission against the row's current revision", async () => {
    const source = record()
    const update = jest.fn(async () => true)
    setState({ configs: [source], update })
    render(<HostExternalAgentConfigs />)
    await userEvent.click(screen.getByRole("combobox", { name: "Permission mode for Pi" }))
    await userEvent.click(screen.getByRole("option", { name: "Plan" }))
    expect(update).toHaveBeenCalledWith(source, { defaultPermissionMode: "plan" })
  })

  it("offers only permission modes the host runtime supports", async () => {
    setState({ configs: [record({ config: { name: "Remote", protocol: "a2a" } as never })] })
    render(<HostExternalAgentConfigs />)
    await userEvent.click(screen.getByRole("combobox", { name: "Permission mode for Remote" }))
    expect(screen.getAllByRole("option")).toHaveLength(1)
    expect(screen.getByRole("option")).toHaveTextContent("Default")
  })

  it("opens the route-free editor and refreshes the list after saving", async () => {
    setState({ configs: [record()] })
    render(<HostExternalAgentConfigs />)
    await userEvent.click(screen.getByRole("button", { name: "Edit Pi" }))
    const sheet = screen.getByRole("dialog", { name: "Edit host configuration" })
    expect(sheet).toHaveClass("w-full", "sm:max-w-lg")
    expect(within(sheet).getByTestId("shared-host-editor")).toHaveTextContent("eac_1")
    await userEvent.click(within(sheet).getByRole("button", { name: "Save edited configuration" }))
    expect(state.current.refresh).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    await userEvent.click(
      within(sheet).getByRole("button", { name: "Remove edited configuration" })
    )
    expect(state.current.refresh).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("keeps duplicates and siblings inside the desktop editor sheet", async () => {
    setState({ configs: [record()] })
    render(<HostExternalAgentConfigs />)
    await userEvent.click(screen.getByRole("button", { name: "Edit Pi" }))
    await userEvent.click(screen.getByRole("button", { name: "Duplicate edited configuration" }))
    expect(screen.getByTestId("shared-host-editor")).toHaveTextContent("eac_copy")
    expect(state.current.refresh).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole("button", { name: "Open sibling configuration" }))
    expect(screen.getByTestId("shared-host-editor")).toHaveTextContent("eac_sibling")
  })

  it("creates from the shared picker and highlights the created row after closing", async () => {
    const created = record({
      configId: "eac_created",
      config: { name: "Codex", protocol: "acp" } as never,
    })
    setState({ configs: [] })
    const { rerender } = render(<HostExternalAgentConfigs />)
    await userEvent.click(screen.getByRole("button", { name: "New on host" }))
    expect(screen.getByRole("dialog", { name: "New on host" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Pick Codex runtime" }))
    expect(screen.getByTestId("shared-host-create-form")).toHaveTextContent("codex")
    await userEvent.click(screen.getByRole("button", { name: "Create host configuration" }))
    expect(state.current.refresh).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    state.current.configs = [created]
    rerender(<HostExternalAgentConfigs />)
    expect(screen.getByTestId("host-config-eac_created")).toHaveAttribute(
      "data-highlighted",
      "true"
    )
  })

  it("returns to the picker on cancel and starts each new sheet at the picker", async () => {
    setState({ configs: [] })
    render(<HostExternalAgentConfigs />)
    await userEvent.click(screen.getByRole("button", { name: "New on host" }))
    await userEvent.click(screen.getByRole("button", { name: "Pick Codex runtime" }))
    await userEvent.click(screen.getByRole("button", { name: "Choose another runtime" }))
    expect(screen.getByRole("button", { name: "Pick Codex runtime" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Pick Codex runtime" }))
    await userEvent.click(screen.getByRole("button", { name: "Close" }))
    await userEvent.click(screen.getByRole("button", { name: "New on host" }))
    expect(screen.getByRole("button", { name: "Pick Codex runtime" })).toBeInTheDocument()
    expect(screen.queryByTestId("shared-host-create-form")).not.toBeInTheDocument()
  })
})

describe("copying a local agent to the host", () => {
  // The empty state has always told the user to copy one across. Until this
  // control existed, that sentence named an action with nothing behind it.
  it("offers every local agent the host does not already have", async () => {
    localAgents.current = {
      "local-1": { id: "local-1", name: "Pi (native RPC)" },
      "local-2": { id: "local-2", name: "Pi" },
    }
    const copyLocal = jest.fn(async () => {})
    setState({ configs: [record({ config: { name: "Pi" } as never })], copyLocal })
    render(<HostExternalAgentConfigs />)

    await userEvent.click(screen.getByRole("button", { name: /Copy from this device/i }))

    // "Pi" is already on the host, so only the other one is offered.
    expect(screen.getByRole("menuitem", { name: "Pi (native RPC)" })).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Pi" })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole("menuitem", { name: "Pi (native RPC)" }))
    await waitFor(() =>
      expect(copyLocal).toHaveBeenCalledWith({ id: "local-1", name: "Pi (native RPC)" })
    )
  })

  // Disabled rather than hidden: the empty state names this action, and a
  // control that vanishes makes the sentence look like a lie.
  it("stays visible and disabled when there is nothing left to copy", () => {
    localAgents.current = { "local-1": { id: "local-1", name: "Pi" } }
    setState({ configs: [record({ config: { name: "Pi" } as never })] })
    render(<HostExternalAgentConfigs />)

    expect(screen.getByRole("button", { name: /Copy from this device/i })).toBeDisabled()
  })
})

describe("instances on the host (ADR-0216)", () => {
  const codex = (over: Record<string, unknown>) =>
    ({
      name: "Codex",
      protocol: "acp",
      transport: "stdio",
      process: { command: "codex", args: [] },
      metadata: { preset: "codex" },
      ...over,
    }) as never

  it("shows each row's state isolation, lineage and what sets it apart", () => {
    setState({
      configs: [
        record({ configId: "eac_src", config: codex({ defaultPermissionMode: "plan" }) }),
        record({
          configId: "eac_copy",
          config: codex({
            name: "Codex (copy)",
            stateIsolation: "isolated",
            defaultPermissionMode: "bypassPermissions",
            duplicatedFromAgentId: "eac_src",
          }),
        }),
      ],
    })
    renderInShell()
    const source = screen.getByTestId("host-config-eac_src")
    const copy = screen.getByTestId("host-config-eac_copy")
    expect(within(source).getByTestId("state-isolation-badge")).toHaveTextContent("Shared state")
    expect(within(copy).getByTestId("state-isolation-badge")).toHaveTextContent("Own state")
    expect(within(copy).getByTestId("duplicated-from-hint")).toHaveTextContent("Copy of Codex")
    expect(within(source).queryByTestId("duplicated-from-hint")).toBeNull()
    expect(within(source).getByTestId("instance-trait-chips")).toHaveTextContent("Plan")
    expect(within(copy).getByTestId("instance-trait-chips")).toHaveTextContent("Bypass")
  })

  it("says nothing about lineage when the source has been deleted", () => {
    setState({
      configs: [record({ config: codex({ duplicatedFromAgentId: "gone" }) })],
    })
    renderInShell()
    expect(screen.queryByTestId("duplicated-from-hint")).toBeNull()
  })

  it("duplicates on the host with the chosen name, state and enablement", async () => {
    const duplicate = jest.fn(async () => ({
      ok: true as const,
      record: record({ configId: "eac_2", config: codex({ name: "Codex review" }) }),
    }))
    setState({ configs: [record({ config: codex({}) })], duplicate })
    renderInShell()
    await userEvent.click(screen.getByRole("button", { name: "Actions for Codex" }))
    await userEvent.click(screen.getByRole("menuitem", { name: "Duplicate Codex" }))
    const name = screen.getByTestId("duplicate-agent-name")
    expect(name).toHaveValue("Codex (copy)")
    await userEvent.clear(name)
    await userEvent.type(name, "Codex review")
    // Codex can be isolated, so a copy starts with its own state.
    expect(screen.getByTestId("state-isolation-isolated")).toHaveAttribute("data-state", "checked")
    await userEvent.click(screen.getByTestId("state-isolation-shared"))
    await userEvent.click(screen.getByTestId("duplicate-agent-enabled"))
    await userEvent.click(screen.getByTestId("duplicate-agent-submit"))
    await waitFor(() =>
      expect(duplicate).toHaveBeenCalledWith(expect.objectContaining({ configId: "eac_1" }), {
        name: "Codex review",
        stateIsolation: "shared",
        enabled: false,
      })
    )
    await waitFor(() =>
      expect(screen.queryByTestId("duplicate-agent-name")).not.toBeInTheDocument()
    )
    expect(toast.success).toHaveBeenCalledWith('Duplicated as "Codex review"')
  })

  it("keeps the duplicate dialog open and says why when the host refuses", async () => {
    const duplicate = jest.fn(async () => ({ ok: false as const, error: "keyring locked" }))
    setState({ configs: [record({ config: codex({}) })], duplicate })
    renderInShell()
    await userEvent.click(screen.getByRole("button", { name: "Actions for Codex" }))
    await userEvent.click(screen.getByRole("menuitem", { name: "Duplicate Codex" }))
    await userEvent.click(screen.getByTestId("duplicate-agent-submit"))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("keyring locked"))
    )
    expect(screen.getByTestId("duplicate-agent-name")).toBeInTheDocument()
  })

  it("suggests a free name when the default copy name is taken on the host", async () => {
    setState({
      configs: [
        record({ config: codex({}) }),
        record({ configId: "eac_2", config: codex({ name: "Codex (copy)" }) }),
      ],
    })
    renderInShell()
    await userEvent.click(screen.getByRole("button", { name: "Actions for Codex" }))
    await userEvent.click(screen.getByRole("menuitem", { name: "Duplicate Codex" }))
    expect(screen.getByTestId("duplicate-agent-name")).not.toHaveValue("Codex (copy)")
  })

  it("tells two local configurations of one runtime apart in the copy menu", async () => {
    const base = {
      protocol: "acp",
      transport: "stdio",
      process: { command: "codex", args: [] },
      metadata: { preset: "codex" },
    }
    localAgents.current = {
      "local-1": { ...base, id: "local-1", name: "Codex", defaultPermissionMode: "plan" },
      "local-2": { ...base, id: "local-2", name: "Codex", defaultPermissionMode: "acceptEdits" },
    }
    setState({ configs: [] })
    renderInShell()
    await userEvent.click(screen.getByRole("button", { name: /Copy from this device/i }))
    expect(screen.getByTestId("copy-local-traits-local-1")).toHaveTextContent("Plan")
    expect(screen.getByTestId("copy-local-traits-local-2")).toHaveTextContent("Accept edits")
  })
})
