/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"

import { TooltipProvider } from "@/components/ui/tooltip"
import type { HostExternalAgentConfigsState } from "@/hooks/agent/use-host-external-agent-configs"
import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"
import messages from "@/i18n/messages/en/externalAgent.json"
import manageMessages from "@/i18n/messages/en/externalAgentManage.json"
import mobileMessages from "@/i18n/messages/en/mobile/externalAgents.json"

import { HostAgentEditor, type HostAgentEditorProps } from "./host-agent-editor"
import { __setRemoteHostConfigDepsForTests } from "@/lib/ai/agent/external/runtimes/remote/remote-host-configs"
import type { HostFeatureManifest } from "@/lib/platform/host-feature-manifest"

// Resolve complete namespaces from split sources; aggregates are rebuilt by the orchestrator.
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/hooks/ui/use-mobile", () => ({ useIsMobile: () => false }))
jest.mock("@/hooks/files/use-directory-picker", () => ({
  useDirectoryPicker: () => ({ available: false, busy: false, browse: jest.fn() }),
}))
jest.mock("@/components/agent/external-agent/cognia-model-picker", () => ({
  CogniaModelPicker: ({
    onChange,
  }: {
    onChange: (binding: { providerId: string; modelId: string }) => void
  }) => (
    <button type="button" onClick={() => onChange({ providerId: "", modelId: "" })}>
      Choose incomplete model
    </button>
  ),
}))
jest.mock("@/components/agent/external-agent/role-model-fields", () => ({
  RoleModelFields: ({
    blocker,
    spawnModelsSupported,
  }: {
    blocker?: string
    spawnModelsSupported?: boolean
  }) => (
    <div role="status" aria-label="Role models" data-spawn-supported={String(spawnModelsSupported)}>
      {blocker}
    </div>
  ),
}))
jest.mock("@/components/icons/brand-icon", () => ({
  BrandIcon: ({ id }: { id: string }) => <span data-testid={`brand-icon-${id}`} />,
}))

let mockSupportsModelRoles = true

const hostState: { current: HostExternalAgentConfigsState } = {
  current: {} as HostExternalAgentConfigsState,
}
jest.mock("@/hooks/agent/use-host-external-agent-configs", () => ({
  useHostExternalAgentConfigs: () => hostState.current,
  useHostSupportsModelRoles: () => mockSupportsModelRoles,
}))

const onRemoved = jest.fn()
const onDuplicated = jest.fn()
const onSaved = jest.fn()
const settings = messages.settings

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
      process: { command: "codex-acp", args: [], cwd: "/work", env: { KEEP: "yes" } },
      metadata: { preset: "codex" },
      ...config,
    },
  } as ExternalAgentConfigRecord
}

function setHost(over: Partial<HostExternalAgentConfigsState> = {}) {
  hostState.current = {
    configs: [record()],
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
  }
}

function editor(props: Partial<HostAgentEditorProps> = {}) {
  return (
    <TooltipProvider>
      <HostAgentEditor
        configId="eac_1"
        onRemoved={onRemoved}
        onDuplicated={onDuplicated}
        onSaved={onSaved}
        {...props}
      />
    </TooltipProvider>
  )
}

const drawer = () => screen.getByRole("dialog")
function open(label: string) {
  fireEvent.click(screen.getByRole("button", { name: label }))
}
function change(label: string, value: string) {
  fireEvent.change(within(drawer()).getByLabelText(label, { exact: true }), {
    target: { value },
  })
}
function save() {
  fireEvent.click(within(drawer()).getByRole("button", { name: "Save" }))
}

beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn()
  Element.prototype.hasPointerCapture = jest.fn(() => false)
  Element.prototype.setPointerCapture = jest.fn()
  Element.prototype.releasePointerCapture = jest.fn()
})
beforeEach(() => {
  mockSupportsModelRoles = true
  jest.clearAllMocks()
  setHost()
})

describe("HostAgentEditor: states and status", () => {
  it("explains when the Host cannot serve configurations", () => {
    setHost({ unavailable: "no-host" })
    render(editor())
    expect(screen.getByTestId("host-agent-detail-unavailable")).toHaveTextContent(
      messages.hostConfigs.unavailableNoHost
    )
    expect(screen.queryByTestId("host-agent-detail")).not.toBeInTheDocument()
  })

  it("shows a skeleton during the initial load", () => {
    setHost({ configs: [], loaded: false, loading: true })
    render(editor())
    expect(screen.getByTestId("host-agent-detail-loading")).toHaveAttribute("aria-busy", "true")
    expect(screen.queryByTestId("host-agent-detail-not-found")).not.toBeInTheDocument()
  })

  it("distinguishes a failed load from a missing configuration and retries", () => {
    setHost({ configs: [], loaded: false, error: "relay timeout" })
    render(editor())
    expect(screen.getByTestId("host-agent-detail-load-failed")).toHaveTextContent("relay timeout")
    expect(screen.queryByTestId("host-agent-detail-not-found")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: mobileMessages.retry }))
    expect(hostState.current.refresh).toHaveBeenCalledTimes(1)
  })

  it("shows the not-found state after the Host has been read", () => {
    render(editor({ configId: "eac_missing" }))
    expect(screen.getByTestId("host-agent-detail-not-found")).toHaveTextContent(
      mobileMessages.detailNotFoundTitle
    )
  })

  it("shows identity and one status before the grouped configuration rows", () => {
    setHost({ configs: [record({ config: { stateIsolation: "isolated" } })] })
    render(editor())
    const header = screen.getByTestId("agent-detail-header")
    expect(within(header).getByRole("heading", { name: "Codex" })).toBeInTheDocument()
    expect(within(header).getByTestId("brand-icon-codex")).toBeInTheDocument()
    expect(header).toHaveTextContent("ACP")
    expect(header).toHaveTextContent("Own state")
    const status = screen.getByText(mobileMessages.hostEnabledStatus)
    const general = screen.getByText(settings.mobileDetailGeneral)
    expect(status.compareDocumentPosition(general) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument()
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument()
  })

  it("shows the lifecycle diagnosis and explains credentials that need the Host UI", () => {
    setHost({
      configs: [
        record({
          enabled: false,
          lifecycleStatus: "needs-credentials",
          config: { lifecycleReasonCode: "credential_missing" },
        }),
      ],
    })
    render(editor())
    const status = screen.getByTestId("lifecycle-status-notice")
    expect(status).toHaveAttribute("data-status", "needs-credentials")
    expect(status).toHaveTextContent(mobileMessages.hostCredentialsRemedy)
    expect(screen.getByRole("switch", { name: "Enable Codex" })).toBeDisabled()
    expect(screen.queryByText(mobileMessages.hostEnabledStatus)).not.toBeInTheDocument()
  })

  it("opens the matching shared editor for a remote-capable lifecycle remedy", () => {
    setHost({
      configs: [
        record({
          enabled: false,
          lifecycleStatus: "blocked",
          config: { lifecycleReasonCode: "session_limit_reached" },
        }),
      ],
    })
    render(editor())
    const notice = screen.getByTestId("lifecycle-status-notice")
    fireEvent.click(
      within(notice).getByRole("button", { name: settings.remedies["edit-session-limit"] })
    )
    expect(
      within(drawer()).getByLabelText(messages.instanceSection.sessionLimit)
    ).toBeInTheDocument()
  })

  it("keeps Host-only fields visible as read-only rows", () => {
    setHost({
      configs: [
        record({
          config: {
            codexOptions: { sandboxMode: "readOnly" },
            subscriptionAccountId: "account-1",
            autoApprovePatterns: ["read:*"],
            requireApprovalFor: ["write:*"],
          },
        }),
      ],
    })
    render(editor())
    expect(screen.getByText(settings.codexSandboxMode)).toBeInTheDocument()
    expect(screen.getByText(manageMessages.editor.autoApprove)).toBeInTheDocument()
    expect(screen.getByText(manageMessages.editor.requireApprovalFor)).toBeInTheDocument()
    expect(screen.getByText(mobileMessages.subscriptionAccount)).toBeInTheDocument()
    expect(screen.getAllByText(mobileMessages.changeOnHost)).toHaveLength(4)
    expect(
      screen.queryByRole("button", { name: settings.codexSandboxMode })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: manageMessages.editor.autoApprove })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: manageMessages.editor.requireApprovalFor })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: mobileMessages.subscriptionAccount })
    ).not.toBeInTheDocument()
  })

  it("shows Pi packages with the Host management hint", () => {
    setHost({
      configs: [
        record({
          config: {
            protocol: "pi-rpc",
            process: { command: "pi", args: [] },
            metadata: { preset: "pi", piPackages: ["npm:pi-tools"] },
          },
        }),
      ],
    })
    render(editor())
    expect(screen.getByText(mobileMessages.piPackages)).toBeInTheDocument()
    expect(screen.getByText("npm:pi-tools")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: mobileMessages.piPackages })
    ).not.toBeInTheDocument()
    expect(screen.getAllByText(mobileMessages.changeOnHost)).toHaveLength(3)
  })

  it("enables a ready configuration through a single revision-checked patch", async () => {
    const row = record({ enabled: false })
    setHost({ configs: [row] })
    render(editor())
    expect(screen.getByText(mobileMessages.hostDisabledStatus)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("switch", { name: "Enable Codex" }))
    await waitFor(() =>
      expect(hostState.current.update).toHaveBeenCalledWith(row, { enabled: true })
    )
    expect(onSaved).toHaveBeenCalledTimes(1)
  })
})

describe("HostAgentEditor: one-item saves", () => {
  it("saves name and description against the opened revision even after a refresh", async () => {
    const opened = record({ config: { description: "Old description" } })
    setHost({ configs: [opened] })
    const view = render(editor())
    open(settings.mobileDetailNameDescription)
    change(settings.agentName, "Codex reviews")
    change(manageMessages.editor.description, "Reviews only")
    hostState.current = {
      ...hostState.current,
      configs: [record({ revision: "eacr_2", config: { defaultPermissionMode: "plan" } })],
    }
    view.rerender(editor())
    save()
    await waitFor(() =>
      expect(hostState.current.update).toHaveBeenCalledWith(opened, {
        name: "Codex reviews",
        description: "Reviews only",
      })
    )
    expect(hostState.current.update).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledWith(mobileMessages.saved)
  })

  it("clears an emptied description with null", async () => {
    const row = record({ config: { description: "Remove me" } })
    setHost({ configs: [row] })
    render(editor())
    open(settings.mobileDetailNameDescription)
    change(manageMessages.editor.description, "")
    save()
    await waitFor(() =>
      expect(hostState.current.update).toHaveBeenCalledWith(row, { description: null })
    )
  })

  it("clears both session limits with null", async () => {
    const row = record({ config: { maxConcurrentSessions: 2, sessionIdleTimeout: 60000 } })
    setHost({ configs: [row] })
    render(editor())
    open(settings.mobileDetailSessionLimit)
    change(messages.instanceSection.sessionLimit, "")
    change(manageMessages.editor.idleTimeout, "")
    save()
    await waitFor(() =>
      expect(hostState.current.update).toHaveBeenCalledWith(row, {
        maxConcurrentSessions: null,
        sessionIdleTimeout: null,
      })
    )
  })

  it("saves permission without rewriting connection or identity fields", async () => {
    const user = userEvent.setup()
    const row = record()
    setHost({ configs: [row] })
    render(editor())
    open(settings.mobileDetailPermissionMode)
    await user.click(within(drawer()).getByRole("radio", { name: settings.permissionPlan }))
    save()
    await waitFor(() =>
      expect(hostState.current.update).toHaveBeenCalledWith(row, { defaultPermissionMode: "plan" })
    )
  })

  it("warns before moving an existing shared configuration to its own state", async () => {
    const user = userEvent.setup()
    const row = record()
    setHost({ configs: [row] })
    render(editor())
    open(messages.stateIsolationField.legend)
    expect(within(drawer()).getByRole("radio", { name: /Shared state/ })).toBeChecked()
    await user.click(within(drawer()).getByRole("radio", { name: /Own state/ }))
    expect(screen.getByTestId("state-isolation-sign-in-warning")).toBeInTheDocument()
    save()
    await waitFor(() =>
      expect(hostState.current.update).toHaveBeenCalledWith(row, { stateIsolation: "isolated" })
    )
  })

  it("preserves saved API key references when changing only the endpoint", async () => {
    const row = record({
      config: {
        protocol: "a2a",
        transport: "http",
        process: undefined,
        metadata: {},
        network: { endpoint: "https://old.example", headers: { "X-Tenant": "one" } },
        credentialRefs: { apiKey: "saved-api-key", processEnv: "saved-env" },
      },
    })
    setHost({ configs: [row] })
    render(editor())
    open(settings.endpoint)
    change(settings.endpoint, "https://new.example")
    save()
    await waitFor(() => expect(hostState.current.update).toHaveBeenCalledTimes(1))
    expect(hostState.current.update).toHaveBeenCalledWith(row, {
      network: {
        endpoint: "https://new.example",
        headers: { "X-Tenant": "one" },
        apiKey: undefined,
      },
    })
    expect(row.config.credentialRefs).toEqual({
      apiKey: "saved-api-key",
      processEnv: "saved-env",
    })
  })

  it("keeps the saved API key when its replacement input is left empty", async () => {
    const row = record({
      config: {
        protocol: "a2a",
        transport: "http",
        process: undefined,
        metadata: {},
        network: { endpoint: "https://agent.example" },
        credentialRefs: { apiKey: "saved-api-key" },
      },
    })
    setHost({ configs: [row] })
    render(editor())
    open(settings.apiKey)
    expect(within(drawer()).getByLabelText(settings.apiKey)).toHaveValue("")
    expect(within(drawer()).getByText(settings.inspectorKeySaved)).toBeInTheDocument()
    save()
    await waitFor(() => expect(hostState.current.update).toHaveBeenCalledWith(row, {}))
  })

  it.each([
    ["name", settings.mobileDetailNameDescription, settings.agentName, " ", settings.nameRequired],
    ["command", settings.command, settings.command, "", settings.commandRequired],
    [
      "arguments",
      settings.arguments,
      settings.arguments,
      "'unterminated",
      settings.argumentsInvalid,
    ],
    [
      "session limit",
      settings.mobileDetailSessionLimit,
      messages.instanceSection.sessionLimit,
      "0",
      settings.sessionLimitInvalid,
    ],
    [
      "idle timeout",
      settings.mobileDetailSessionLimit,
      manageMessages.editor.idleTimeout,
      "1.5",
      manageMessages.editor.invalidIdleTimeout,
    ],
    [
      "retry count",
      settings.sectionRetry,
      settings.maxRetries,
      "-1",
      settings.mobileDetailNonNegativeIntegerInvalid,
    ],
  ])(
    "rejects an invalid %s without sending a Host update",
    async (_name, rowLabel, fieldLabel, invalid, message) => {
      render(editor())
      open(rowLabel)
      change(fieldLabel, invalid)
      save()
      expect(await within(drawer()).findByRole("alert")).toHaveTextContent(message)
      expect(within(drawer()).getByLabelText(fieldLabel)).toHaveAttribute("aria-invalid", "true")
      expect(hostState.current.update).not.toHaveBeenCalled()
      expect(onSaved).not.toHaveBeenCalled()
    }
  )

  it("refuses an empty network endpoint", async () => {
    setHost({
      configs: [
        record({
          config: {
            protocol: "a2a",
            transport: "http",
            metadata: {},
            network: { endpoint: "https://agent.example" },
          },
        }),
      ],
    })
    render(editor())
    open(settings.endpoint)
    change(settings.endpoint, "")
    save()
    expect(await within(drawer()).findByRole("alert")).toHaveTextContent(settings.endpointRequired)
    expect(hostState.current.update).not.toHaveBeenCalled()
  })

  it("rejects an incomplete Cognia model binding without updating the Host", async () => {
    render(editor())
    open(messages.cogniaModel.model)
    fireEvent.click(within(drawer()).getByRole("button", { name: "Choose incomplete model" }))
    save()
    expect(await within(drawer()).findByRole("alert")).toHaveTextContent(
      messages.cogniaModel.invalid
    )
    expect(hostState.current.update).not.toHaveBeenCalled()
  })

  it("edits state for an OpenCode server spawned on the Host", async () => {
    const user = userEvent.setup()
    const row = record({
      config: {
        protocol: "opencode",
        transport: "http",
        process: undefined,
        metadata: { preset: "opencode", autoSpawnServer: true },
        network: { endpoint: "http://127.0.0.1:4096" },
      },
    })
    setHost({ configs: [row] })
    render(editor())
    open(messages.stateIsolationField.legend)
    await user.click(within(drawer()).getByRole("radio", { name: /Own state/ }))
    save()
    await waitFor(() =>
      expect(hostState.current.update).toHaveBeenCalledWith(row, { stateIsolation: "isolated" })
    )
  })

  it("accepts comma and newline retry patterns while retaining other retry settings", async () => {
    const row = record({
      config: {
        retryConfig: {
          maxRetries: 4,
          retryDelay: 250,
          maxRetryDelay: 5000,
          exponentialBackoff: false,
          retryOnErrors: ["old"],
        },
      },
    })
    setHost({ configs: [row] })
    render(editor())
    open(settings.sectionRetry)
    change(settings.retryErrorPatterns, "ETIMEDOUT, ECONNRESET\nrate_limit")
    save()
    await waitFor(() =>
      expect(hostState.current.update).toHaveBeenCalledWith(row, {
        retryConfig: {
          maxRetries: 4,
          retryDelay: 250,
          maxRetryDelay: 5000,
          exponentialBackoff: false,
          retryOnErrors: ["ETIMEDOUT", "ECONNRESET", "rate_limit"],
        },
      })
    )
  })

  it("cancels a draft without saving", () => {
    render(editor())
    open(settings.mobileDetailNameDescription)
    change(settings.agentName, "Not saved")
    fireEvent.click(within(drawer()).getByRole("button", { name: "Cancel" }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(hostState.current.update).not.toHaveBeenCalled()
  })
})

describe("HostAgentEditor: conflicts", () => {
  it("retains the draft through a conflict and reloads theirs only when requested", async () => {
    const opened = record()
    const latest = record({
      revision: "eacr_2",
      config: { name: "Their name", description: "Their description" },
    })
    const update = jest.fn(async () => false)
    setHost({ configs: [opened], update })
    const view = render(editor())
    open(settings.mobileDetailNameDescription)
    change(settings.agentName, "My draft")
    save()
    await waitFor(() => expect(update).toHaveBeenCalledWith(opened, { name: "My draft" }))
    hostState.current = {
      ...hostState.current,
      configs: [latest],
      error: "external agent config eac_1 moved to revision eacr_2 (expected eacr_1)",
    }
    view.rerender(editor())
    expect(within(drawer()).getByLabelText(settings.agentName)).toHaveValue("My draft")
    expect(within(drawer()).getByRole("alert")).toHaveTextContent(mobileMessages.saveConflict)
    expect(onSaved).not.toHaveBeenCalled()
    fireEvent.click(within(drawer()).getByRole("button", { name: mobileMessages.reloadTheirs }))
    expect(within(drawer()).getByLabelText(settings.agentName)).toHaveValue("Their name")
    expect(within(drawer()).getByLabelText(manageMessages.editor.description)).toHaveValue(
      "Their description"
    )
    expect(within(drawer()).queryByRole("alert")).not.toBeInTheDocument()
    expect(update).toHaveBeenCalledTimes(1)
  })

  it("overwrites only the opened item against the newest revision and preserves nested process changes", async () => {
    const opened = record()
    const latest = record({
      revision: "eacr_2",
      config: {
        process: {
          command: "their-codex",
          args: ["--new-argument"],
          cwd: "/their-work",
          env: { KEEP: "updated", NEW: "yes" },
        },
      },
    })
    const update = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    setHost({ configs: [opened], update })
    const view = render(editor())
    open(settings.command)
    change(settings.command, "my-codex")
    save()
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    hostState.current = {
      ...hostState.current,
      configs: [latest],
      error: "config_conflict: moved to revision eacr_2",
    }
    view.rerender(editor())
    expect(within(drawer()).getByLabelText(settings.command)).toHaveValue("my-codex")
    fireEvent.click(within(drawer()).getByRole("button", { name: mobileMessages.overwriteMine }))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2))
    expect(update).toHaveBeenLastCalledWith(latest, {
      process: {
        command: "my-codex",
        args: ["--new-argument"],
        cwd: "/their-work",
        env: { KEEP: "updated", NEW: "yes" },
      },
    })
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it("preserves the newest endpoint, headers and other credential slots when overwriting an API key", async () => {
    const opened = record({
      config: {
        protocol: "a2a",
        transport: "http",
        metadata: {},
        network: { endpoint: "https://old.example", headers: { "X-Tenant": "old" } },
        credentialRefs: { apiKey: "saved-key", processEnv: "saved-env" },
      },
    })
    const latest = record({
      revision: "eacr_3",
      config: {
        ...opened.config,
        network: { endpoint: "https://new.example", headers: { "X-Tenant": "new" } },
      },
    })
    const update = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    setHost({ configs: [opened], update })
    const view = render(editor())
    open(settings.apiKey)
    change(settings.apiKey, "my-new-key")
    save()
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    hostState.current = { ...hostState.current, configs: [latest], error: "config_conflict" }
    view.rerender(editor())
    fireEvent.click(within(drawer()).getByRole("button", { name: mobileMessages.overwriteMine }))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2))
    expect(update).toHaveBeenLastCalledWith(latest, {
      network: {
        endpoint: "https://new.example",
        headers: { "X-Tenant": "new" },
        apiKey: "my-new-key",
      },
    })
    expect(latest.config.credentialRefs).toEqual({
      apiKey: "saved-key",
      processEnv: "saved-env",
    })
  })

  it("keeps the draft and reports other Host failures without offering conflict resolution", async () => {
    const update = jest.fn(async () => false)
    setHost({ update })
    const view = render(editor())
    open(settings.mobileDetailNameDescription)
    change(settings.agentName, "Keep this draft")
    save()
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    hostState.current = { ...hostState.current, error: "keyring locked" }
    view.rerender(editor())
    expect(within(drawer()).getByRole("alert")).toHaveTextContent("Could not save: keyring locked")
    expect(within(drawer()).getByLabelText(settings.agentName)).toHaveValue("Keep this draft")
    expect(
      within(drawer()).queryByRole("button", { name: mobileMessages.reloadTheirs })
    ).not.toBeInTheDocument()
    expect(onSaved).not.toHaveBeenCalled()
  })
})

describe("HostAgentEditor: siblings and actions", () => {
  it("shows lineage and opens the source through the hosting surface", () => {
    const onOpenConfig = jest.fn()
    setHost({
      configs: [
        record(),
        record({
          configId: "eac_2",
          config: { name: "Codex copy", duplicatedFromAgentId: "eac_1" },
        }),
      ],
    })
    render(editor({ configId: "eac_2", onOpenConfig }))
    fireEvent.click(
      within(screen.getByTestId("agent-detail-header")).getByRole("button", {
        name: "Copy of Codex",
      })
    )
    expect(onOpenConfig).toHaveBeenCalledWith("eac_1")
  })

  it("says when a copy's source was removed", () => {
    setHost({ configs: [record({ config: { duplicatedFromAgentId: "gone" } })] })
    render(editor())
    expect(screen.getByText(mobileMessages.copiedFromRemoved)).toBeInTheDocument()
  })

  it("lists only runtime siblings, includes their differences, and opens one locally", () => {
    setHost({
      configs: [
        record(),
        record({
          configId: "eac_2",
          config: {
            name: "Codex reviews",
            defaultPermissionMode: "plan",
            stateIsolation: "isolated",
          },
        }),
        record({
          configId: "eac_other",
          config: {
            name: "Other runtime",
            protocol: "a2a",
            transport: "http",
            metadata: {},
            process: undefined,
          },
        }),
      ],
    })
    render(editor())
    const siblings = screen.getByTestId("host-agent-siblings")
    const sibling = within(siblings).getByRole("button", { name: "Codex reviews" })
    expect(sibling).toHaveTextContent("Permission: Plan")
    expect(sibling).toHaveTextContent("State: Own state")
    expect(within(siblings).queryByText("Other runtime")).not.toBeInTheDocument()
    fireEvent.click(sibling)
    expect(
      within(screen.getByTestId("agent-detail-header")).getByRole("heading", {
        name: "Codex reviews",
      })
    ).toBeInTheDocument()
  })

  it("omits siblings when this runtime has only one configuration", () => {
    render(editor())
    expect(screen.queryByTestId("host-agent-siblings")).not.toBeInTheDocument()
  })

  it("removes only after confirmation and calls the surface after success", async () => {
    const row = record()
    setHost({ configs: [row] })
    render(editor())
    open("Remove Codex")
    expect(hostState.current.remove).not.toHaveBeenCalled()
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Remove Codex?")
    fireEvent.click(screen.getByTestId("host-agent-remove-confirm"))
    await waitFor(() => expect(hostState.current.remove).toHaveBeenCalledWith(row))
    expect(onRemoved).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledWith("Codex was removed.")
  })

  it("does not navigate after a refused removal", async () => {
    setHost({ remove: jest.fn(async () => false), error: "Host disconnected" })
    render(editor())
    open("Remove Codex")
    fireEvent.click(screen.getByTestId("host-agent-remove-confirm"))
    await waitFor(() => expect(hostState.current.remove).toHaveBeenCalledTimes(1))
    expect(onRemoved).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent("Host disconnected")
  })

  it("duplicates through the shared sheet and returns the new configuration id", async () => {
    const copy = record({ configId: "eac_copy", config: { name: "Codex (copy)" } })
    setHost({ duplicate: jest.fn(async () => ({ ok: true as const, record: copy })) })
    render(editor())
    open("Duplicate Codex")
    expect(screen.getByTestId("duplicate-name")).toHaveValue("Codex (copy)")
    fireEvent.click(screen.getByTestId("duplicate-submit"))
    await waitFor(() => expect(hostState.current.duplicate).toHaveBeenCalledTimes(1))
    expect(onDuplicated).toHaveBeenCalledWith("eac_copy")
  })

  it("keeps a refused duplicate open without calling the surface", async () => {
    setHost({ duplicate: jest.fn(async () => ({ ok: false as const, error: "keyring locked" })) })
    render(editor())
    open("Duplicate Codex")
    fireEvent.click(screen.getByTestId("duplicate-submit"))
    expect(await screen.findByTestId("duplicate-problem")).toHaveTextContent("keyring locked")
    expect(onDuplicated).not.toHaveBeenCalled()
  })
})

it.each([true, false])(
  "keeps native model controls gated and preserves other Codex options (%s)",
  async (supported) => {
    const restore = __setRemoteHostConfigDepsForTests({
      hasLocalAuthority: () => false,
      isRemoteHostActive: () => true,
      activeHostFeatureManifest: () =>
        ({
          schemaVersion: 1,
          features: {
            "external-agent.host-configs": {
              version: 1,
              operations: supported
                ? ["external_agent_native_subagent_control", "external_agent_config_model_roles_v2"]
                : [],
            },
          },
        }) as HostFeatureManifest,
    })
    try {
      setHost({
        configs: [
          record({
            config: {
              protocol: "codex-app-server",
              metadata: { preset: "codex-app-server" },
              codexOptions: { sandboxMode: "readOnly", stepModelSwitching: false },
            },
          }),
        ],
      })
      render(editor())
      open(messages.cogniaModel.model)
      const toggle = within(drawer()).getByRole("switch", {
        name: "Experimental current-turn model switching",
      })
      expect(toggle).toHaveProperty("disabled", !supported)
      expect(within(drawer()).getByRole("status", { name: "Role models" })).toHaveAttribute(
        "data-spawn-supported",
        String(supported)
      )
      if (supported) {
        await userEvent.setup().click(toggle)
        save()
        await waitFor(() => expect(hostState.current.update).toHaveBeenCalled())
        expect((hostState.current.update as jest.Mock).mock.calls[0][1].codexOptions).toEqual({
          sandboxMode: "readOnly",
          stepModelSwitching: true,
        })
      }
    } finally {
      restore()
    }
  }
)

it.each([true, false])(
  "gates Host editor role models on capability support (%s)",
  async (supported) => {
    mockSupportsModelRoles = supported
    render(editor())
    open(messages.cogniaModel.model)
    expect(within(drawer()).getByRole("status", { name: "Role models" })).toHaveTextContent(
      supported ? "" : "host-outdated"
    )
    save()
    await waitFor(() => expect(hostState.current.update).toHaveBeenCalled())
    const patch = (hostState.current.update as jest.Mock).mock.calls[0][1]
    if (supported) expect(patch.modelRoles).toBeNull()
    else expect(patch).not.toHaveProperty("modelRoles")
  }
)
