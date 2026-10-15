// Resolve complete namespaces from split sources; aggregates are rebuilt by the orchestrator.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AgentMobileDetail } from "./agent-mobile-detail"
import type { ComponentProps } from "react"
import type { LifecycleExternalAgentConfig } from "@/stores/agent/external-agent-store"
import type { ExternalAgentFailure } from "@/lib/ai/agent/external/agent-failure"
import messages from "@/i18n/messages/en/externalAgent.json"
import zhMessages from "@/i18n/messages/zh-CN/externalAgent.json"
import manageMessages from "@/i18n/messages/en/externalAgentManage.json"

jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce: true, durationScale: 1 }),
}))
jest.mock("@/hooks/ui/use-mobile", () => ({ useIsMobile: () => false }))
jest.mock("@/hooks/files/use-directory-picker", () => ({
  useDirectoryPicker: () => ({ browse: jest.fn(), available: false }),
}))
const updateConfig = jest.fn()
const toastError = jest.fn()
const clearFailure = jest.fn()
let failures: Record<string, ExternalAgentFailure> = {}
jest.mock("@/components/ui/sonner", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args), success: jest.fn() },
}))
jest.mock("@/lib/ai/agent/external/lifecycle/service", () => ({
  getExternalAgentLifecycleService: async () => ({ updateConfig }),
}))
jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: (selector: (state: unknown) => unknown) =>
    selector({ agentFailures: failures, clearAgentFailure: clearFailure }),
}))
jest.mock("./codex-app-server-status-card", () => ({
  CodexAppServerStatusCard: () => <div data-testid="codex-diagnostic" />,
}))
jest.mock("./opencode-status-card", () => ({
  OpencodeStatusCard: () => <div data-testid="opencode-diagnostic" />,
}))
jest.mock("./pi-auth-status-card", () => ({
  PiAuthStatusCard: () => <div data-testid="pi-diagnostic" />,
}))
jest.mock("./kimi-management-card", () => ({
  KimiManagementCard: () => <div data-testid="kimi-diagnostic" />,
}))
jest.mock("@/components/agent/external-agent/unsandboxed-consent-action", () => ({
  UnsandboxedConsentAction: () => <button data-testid="consent-action">Review permission</button>,
}))

const agent = {
  id: "a1",
  name: "Alpha",
  description: "Original",
  protocol: "acp",
  transport: "stdio",
  enabled: true,
  process: { command: "codex", args: ["app-server"], cwd: "/work", env: { KEEP: "yes" } },
  defaultPermissionMode: "default",
  stateIsolation: "shared",
  timeout: 300000,
  retryConfig: { maxRetries: 3, retryDelay: 1000, maxRetryDelay: 30000, exponentialBackoff: true },
  createdAt: new Date(0),
  updatedAt: new Date(0),
} as LifecycleExternalAgentConfig

function setup(over: Partial<ComponentProps<typeof AgentMobileDetail>> = {}) {
  const props: ComponentProps<typeof AgentMobileDetail> = {
    agent,
    allAgents: [agent],
    readiness: {
      state: "off",
      ready: false,
      blockReason: null,
      blockTransient: false,
      steps: [
        { id: "configured", state: "done" },
        { id: "runnable", state: "done" },
        { id: "connected", state: "todo" },
        { id: "routed", state: "todo", optional: true },
      ],
      nextAction: "connect",
    },
    isConnecting: false,
    masterEnabled: true,
    onConnect: jest.fn(),
    onDisconnect: jest.fn(),
    onEdit: jest.fn(),
    onDuplicate: jest.fn(),
    onDelete: jest.fn(),
    onAddRule: jest.fn(),
    onOpenAgent: jest.fn(),
    onOpenRuntimes: jest.fn(),
    onOpenPlugins: jest.fn(),
    ...over,
  }
  const view = render(<AgentMobileDetail {...props} />)
  return {
    ...props,
    ...view,
    rerenderProps: (next: Partial<typeof props>) =>
      view.rerender(<AgentMobileDetail {...props} {...next} />),
  }
}
const settings = messages.settings
const drawer = () => screen.getByRole("dialog")
async function open(label: string) {
  await userEvent.click(screen.getByRole("button", { name: label }))
}
async function save() {
  await userEvent.click(within(drawer()).getByRole("button", { name: "Save" }))
}
function change(label: string, value: string) {
  fireEvent.change(within(drawer()).getByLabelText(label, { exact: true }), { target: { value } })
}

beforeEach(() => {
  updateConfig.mockReset().mockResolvedValue(undefined)
  toastError.mockClear()
  clearFailure.mockClear()
  failures = {}
})

it("renders the exact sections, read-only header, truncated values and no global draft controls", () => {
  setup()
  expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
    "Alpha",
    "General",
    "Connection",
    "Behaviour",
    "Manage",
  ])
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
  expect(screen.queryByRole("tablist")).not.toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument()
  expect(screen.getByTitle("/work")).toHaveClass("truncate")
  expect(screen.getByRole("heading", { name: "Alpha" })).toHaveAttribute(
    "data-detail-heading",
    "agent-a1"
  )
  expect(screen.getByTestId("agent-detail-status").querySelector("details")).not.toHaveAttribute(
    "open"
  )
})

it.each([
  ["Name & description", settings.agentName, "Renamed", { name: "Renamed" }],
  [
    settings.command,
    settings.command,
    "new-command",
    { process: { ...agent.process, command: "new-command" } },
  ],
  [
    settings.arguments,
    settings.arguments,
    '"one two" three',
    { process: { ...agent.process, args: ["one two", "three"] } },
  ],
  [
    settings.workingDirectory,
    settings.workingDirectory,
    "/new directory",
    { process: { ...agent.process, cwd: "/new directory" } },
  ],
  ["Session limit", messages.instanceSection.sessionLimit, "2", { maxConcurrentSessions: 2 }],
  [settings.sectionRetry, settings.executionTimeoutMs, "1000", { timeout: 1000 }],
])("saves %s through the lifecycle service", async (row, label, value, expected) => {
  setup()
  await open(row)
  change(label, value)
  await save()
  await waitFor(() => expect(updateConfig).toHaveBeenCalledWith("a1", expected))
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
})

it("edits description, both session limits, every retry value, and preserves retry extension fields", async () => {
  setup({
    agent: {
      ...agent,
      maxConcurrentSessions: 4,
      sessionIdleTimeout: 9000,
      retryConfig: { ...agent.retryConfig!, retryOnErrors: ["timeout"] },
    },
  })
  await open("Name & description")
  change(manageMessages.editor.description, "Edited description")
  await save()
  await waitFor(() =>
    expect(updateConfig).toHaveBeenLastCalledWith("a1", { description: "Edited description" })
  )
  await open("Session limit")
  change(messages.instanceSection.sessionLimit, "")
  change(manageMessages.editor.idleTimeout, "")
  await save()
  await waitFor(() =>
    expect(updateConfig).toHaveBeenLastCalledWith("a1", {
      maxConcurrentSessions: null,
      sessionIdleTimeout: null,
    })
  )
  await open(settings.sectionRetry)
  change(settings.maxRetries, "0")
  change(settings.retryDelayMs, "200")
  change(settings.maxRetryDelayMs, "2000")
  fireEvent.click(within(drawer()).getByRole("switch", { name: settings.backoffExponential }))
  await save()
  await waitFor(() =>
    expect(updateConfig).toHaveBeenLastCalledWith("a1", {
      retryConfig: {
        maxRetries: 0,
        retryDelay: 200,
        maxRetryDelay: 2000,
        exponentialBackoff: false,
        retryOnErrors: ["timeout"],
      },
    })
  )
})

it.each([
  ["Name & description", settings.agentName, "", settings.nameRequired],
  [settings.command, settings.command, " ", settings.commandRequired],
  [settings.arguments, settings.arguments, '"open', settings.argumentsInvalid],
  ["Session limit", messages.instanceSection.sessionLimit, "1.5", settings.sessionLimitInvalid],
  [
    "Session limit",
    manageMessages.editor.idleTimeout,
    "0",
    manageMessages.editor.invalidIdleTimeout,
  ],
  [
    settings.sectionRetry,
    settings.executionTimeoutMs,
    "-1",
    settings.mobileDetailNonNegativeIntegerInvalid,
  ],
])(
  "keeps invalid %s edits open with an associated inline error",
  async (row, label, value, error) => {
    setup()
    await open(row)
    change(label, value)
    await save()
    const input = within(drawer()).getByLabelText(label, { exact: true })
    expect(input).toHaveAttribute("aria-invalid", "true")
    expect(input).toHaveAccessibleDescription(expect.stringContaining(error))
    expect(updateConfig).not.toHaveBeenCalled()
  }
)

it("edits network fields, preserves credentials when blank, and never exposes the saved reference", async () => {
  setup({
    agent: {
      ...agent,
      transport: "http",
      protocol: "http",
      network: { endpoint: "https://agent.test", headers: { Keep: "yes" } },
      credentialRefs: { apiKey: "keyring:private-ref" },
    },
  })
  expect(screen.queryByRole("button", { name: settings.command })).not.toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "Agent state" })).not.toBeInTheDocument()
  await open(settings.endpoint)
  change(settings.endpoint, "")
  await save()
  expect(within(drawer()).getByLabelText(settings.endpoint)).toHaveAccessibleDescription(
    settings.endpointRequired
  )
  change(settings.endpoint, "https://new.test")
  await save()
  await waitFor(() =>
    expect(updateConfig).toHaveBeenLastCalledWith("a1", {
      network: { endpoint: "https://new.test", apiKey: undefined, headers: { Keep: "yes" } },
    })
  )
  await open(settings.apiKey)
  expect(within(drawer()).getByLabelText(settings.apiKey)).toHaveValue("")
  expect(within(drawer()).getByText(settings.inspectorKeySaved)).toBeInTheDocument()
  expect(screen.queryByDisplayValue("keyring:private-ref")).not.toBeInTheDocument()
  change(settings.apiKey, "new-secret")
  await save()
  await waitFor(() =>
    expect(updateConfig).toHaveBeenLastCalledWith("a1", {
      network: { endpoint: "https://agent.test", apiKey: "new-secret", headers: { Keep: "yes" } },
    })
  )
})

it("saves permission, state with sign-in warning, and declared web search without losing other capabilities", async () => {
  setup({
    agent: {
      ...agent,
      declaredCapabilities: { "web.search": "native", "tools.ordinary": "native" },
    },
  })
  await open("Permission mode")
  fireEvent.click(within(drawer()).getByRole("radio", { name: settings.permissionPlan }))
  await save()
  await waitFor(() =>
    expect(updateConfig).toHaveBeenLastCalledWith("a1", { defaultPermissionMode: "plan" })
  )
  await open("Agent state")
  fireEvent.click(within(drawer()).getByRole("radio", { name: /Own state/ }))
  expect(within(drawer()).getByText(messages.stateIsolationField.signInWarning)).toBeInTheDocument()
  await save()
  await waitFor(() =>
    expect(updateConfig).toHaveBeenLastCalledWith("a1", { stateIsolation: "isolated" })
  )
  await open("Web search")
  fireEvent.click(within(drawer()).getByRole("radio", { name: settings.declaredWebSearchAuto }))
  await save()
  await waitFor(() =>
    expect(updateConfig).toHaveBeenLastCalledWith("a1", {
      declaredCapabilities: { "tools.ordinary": "native" },
    })
  )
})

it("discards drawer edits on cancel and selection change and reports lifecycle failures inline", async () => {
  const view = setup()
  await open(settings.command)
  change(settings.command, "discard me")
  await userEvent.click(within(drawer()).getByRole("button", { name: "Cancel" }))
  await open(settings.command)
  expect(within(drawer()).getByLabelText(settings.command)).toHaveValue("codex")
  updateConfig.mockRejectedValueOnce(new Error("private implementation detail"))
  change(settings.command, "updated")
  await save()
  expect(await within(drawer()).findByRole("alert")).toHaveTextContent(
    messages.lifecycleErrors.unknown
  )
  view.rerenderProps({ agent: { ...agent, id: "a2", name: "Beta" } })
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
})

it("writes the Enabled switch instantly and toasts lifecycle failures", async () => {
  setup()
  updateConfig.mockRejectedValueOnce(new Error("failed"))
  fireEvent.click(screen.getByRole("switch", { name: "Enabled" }))
  await waitFor(() => expect(updateConfig).toHaveBeenCalledWith("a1", { enabled: false }))
  await waitFor(() => expect(toastError).toHaveBeenCalledWith(messages.lifecycleErrors.unknown))
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
})

it("prioritizes a lifecycle blocker over failure and routes the remedy", () => {
  failures.a1 = {
    agentId: "a1",
    phase: "connect",
    message: "older failure",
    causes: ["older cause"],
    at: 1,
  }
  const view = setup({
    agent: { ...agent, lifecycleStatus: "needs-runtime", lifecycleReasonCode: "runtime_missing" },
  })
  const status = within(screen.getByTestId("agent-detail-status"))
  expect(status.getByText(messages.lifecycleErrors.runtimeMissing)).toBeInTheDocument()
  expect(status.queryByText("older failure")).not.toBeInTheDocument()
  fireEvent.click(status.getByRole("button", { name: settings.remedies["open-runtimes"] }))
  expect(view.onOpenRuntimes).toHaveBeenCalledTimes(1)
})

it("shows one failure with causes, retry and dismissal ahead of readiness", () => {
  failures.a1 = {
    agentId: "a1",
    phase: "connect",
    message: "Connection failed",
    causes: ["Executable missing"],
    at: 1,
  }
  const view = setup()
  const status = within(screen.getByTestId("agent-detail-status"))
  expect(screen.getByRole("alert")).toHaveTextContent(messages.failure.connect)
  expect(status.getByText("Executable missing").closest("details")).toBeInTheDocument()
  fireEvent.click(status.getByRole("button", { name: "Retry" }))
  expect(view.onConnect).toHaveBeenCalledTimes(1)
  fireEvent.click(status.getByRole("button", { name: "Dismiss" }))
  expect(clearFailure).toHaveBeenCalledWith("a1")
})

it.each([false, true])("respects the master switch for connect/retry (failure=%s)", (failure) => {
  if (failure)
    failures.a1 = { agentId: "a1", phase: "connect", message: "Failed", causes: [], at: 1 }
  setup({ masterEnabled: false })
  const action = screen.getByRole("button", { name: failure ? "Retry" : "Connect" })
  expect(action).toBeDisabled()
  expect(action).toHaveAccessibleDescription(settings.inspectorMasterDisabled)
})

it("provides Enable, busy connection, Connected/Disconnect, and optional routing states", async () => {
  const view = setup()
  view.rerenderProps({ readiness: { ...view.readiness, state: "disabled", nextAction: "enable" } })
  fireEvent.click(
    within(screen.getByTestId("agent-detail-status")).getByRole("button", { name: "Enable" })
  )
  await waitFor(() => expect(updateConfig).toHaveBeenCalledWith("a1", { enabled: true }))
  view.rerenderProps({
    readiness: { ...view.readiness, state: "connecting", nextAction: null },
    isConnecting: true,
  })
  expect(screen.getByRole("button", { name: "Connecting" })).toBeDisabled()
  view.rerenderProps({
    readiness: { ...view.readiness, state: "connected", nextAction: null, ready: true },
  })
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }))
  expect(view.onDisconnect).toHaveBeenCalledTimes(1)
  view.rerenderProps({
    readiness: { ...view.readiness, state: "connected", nextAction: "add-rule", ready: true },
  })
  fireEvent.click(screen.getByRole("button", { name: "Add routing rule" }))
  expect(view.onAddRule).toHaveBeenCalledTimes(1)
})

it("renders consent in place of other remedies", () => {
  setup({
    agent: { ...agent, lifecycleStatus: "needs-consent", lifecycleReasonCode: "consent_required" },
  })
  expect(
    within(screen.getByTestId("agent-detail-status")).getByTestId("consent-action")
  ).toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument()
})

it.each([
  ["codex-app-server", "Codex app-server", "codex"],
  ["opencode", "OpenCode", "opencode"],
  ["opencode-v2", "OpenCode", "opencode"],
  ["pi-rpc", "Pi sign-in", "pi"],
  ["acp", "Kimi", "kimi"],
] as const)(
  "only mounts the applicable %s diagnostics after opening its row",
  async (protocol, title, id) => {
    setup({
      agent: { ...agent, protocol, ...(id === "kimi" ? { metadata: { preset: "kimi" } } : {}) },
    })
    expect(screen.queryByTestId(`${id}-diagnostic`)).not.toBeInTheDocument()
    await open(title)
    expect(within(drawer()).getByTestId(`${id}-diagnostic`)).toBeInTheDocument()
    await userEvent.click(
      within(screen.getByTestId("agent-diagnostics-footer")).getByRole("button", { name: "Close" })
    )
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  }
)

it("dispatches manage actions and source navigation", async () => {
  const source = { ...agent, id: "source", name: "Original agent" }
  const view = setup({
    agent: { ...agent, duplicatedFromAgentId: "source" },
    allAgents: [source, agent],
  })
  fireEvent.click(screen.getByRole("button", { name: "Copy of Original agent" }))
  expect(view.onOpenAgent).toHaveBeenCalledWith("source")
  const manage = screen.getByRole("heading", { name: "Manage" }).closest("section")!
  fireEvent.click(within(manage).getByRole("button", { name: "More options" }))
  fireEvent.click(within(manage).getByRole("button", { name: "Duplicate" }))
  fireEvent.click(within(manage).getByRole("button", { name: "Delete" }))
  expect(view.onEdit).toHaveBeenCalledTimes(1)
  expect(view.onDuplicate).toHaveBeenCalledTimes(1)
  expect(view.onDelete).toHaveBeenCalledTimes(1)
  await userEvent.click(screen.getAllByRole("button", { name: "More options" })[0])
  await userEvent.click(screen.getByRole("menuitem", { name: "More options" }))
  expect(view.onEdit).toHaveBeenCalledTimes(2)
})

it("preserves live changes to untouched fields within a grouped drawer", async () => {
  const view = setup()
  await open("Name & description")
  change(settings.agentName, "Renamed")
  view.rerenderProps({
    agent: { ...agent, description: "Synced description", updatedAt: new Date(1) },
  })
  await save()
  await waitFor(() => expect(updateConfig).toHaveBeenCalledWith("a1", { name: "Renamed" }))
})

it("ships every narrow-detail label in both split catalogues", () => {
  for (const key of Object.keys(settings).filter((key) => key.startsWith("mobileDetail"))) {
    expect(zhMessages.settings[key as keyof typeof zhMessages.settings]).toEqual(expect.any(String))
    expect(zhMessages.settings[key as keyof typeof zhMessages.settings]).not.toBe("")
  }
})
