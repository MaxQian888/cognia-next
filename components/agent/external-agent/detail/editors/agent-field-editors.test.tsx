// Resolve complete namespaces from split sources; aggregates are rebuilt by the orchestrator.
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  NameDescriptionEditor,
  ProcessEditor,
  NetworkEditor,
  PermissionModeEditor,
  AgentStateEditor,
  SessionLimitEditor,
  TimeoutRetryEditor,
  WebSearchEditor,
} from "./agent-field-editors"
import { draftFromAgent } from "@/components/settings/agent/inspector-draft"
import {
  supportedPermissionModes,
  adaptPermissionMode,
} from "@/lib/ai/agent/external/policy/permission-modes"
import { PERMISSION_MODE_LABEL_KEY } from "@/components/settings/agent/agent-editor-dialog"
import messages from "@/i18n/messages/en/externalAgent.json"
import manage from "@/i18n/messages/en/externalAgentManage.json"

jest.mock("@/hooks/files/use-directory-picker", () => ({
  useDirectoryPicker: () => ({ available: true, busy: false, browse: async () => "/picked" }),
}))

const draft = draftFromAgent({
  id: "test",
  name: "Agent",
  protocol: "acp",
  transport: "stdio",
  enabled: true,
  process: { command: "pi", args: ["my skills"] },
})
const onChange = jest.fn()
beforeEach(() => onChange.mockClear())

it("edits name and description as controlled fields and associates validation", () => {
  render(
    <NameDescriptionEditor draft={draft} onChange={onChange} errors={{ name: "nameRequired" }} />
  )
  const name = screen.getByLabelText(messages.settings.agentName)
  expect(name).toHaveValue("Agent")
  expect(name).toHaveAttribute("aria-invalid", "true")
  expect(name).toHaveAccessibleDescription(messages.settings.nameRequired)
  fireEvent.change(name, { target: { value: "Reviewer" } })
  fireEvent.change(screen.getByLabelText(manage.editor.description), {
    target: { value: "Code reviews" },
  })
  expect(onChange.mock.calls).toEqual([
    ["name", "Reviewer"],
    ["description", "Code reviews"],
  ])
})

it("renders only the selected process item with inline shell syntax errors", () => {
  render(
    <ProcessEditor
      field="processArgs"
      draft={draft}
      onChange={onChange}
      errors={{ processArgs: "argumentsInvalid" }}
    />
  )
  expect(screen.queryByLabelText(messages.settings.command)).not.toBeInTheDocument()
  const args = screen.getByLabelText(messages.settings.arguments)
  expect(args).toHaveValue("'my skills'")
  expect(args).toHaveAccessibleDescription(messages.settings.argumentsInvalid)
  expect(args).toHaveAttribute("aria-invalid", "true")
  fireEvent.change(args, { target: { value: "--verbose" } })
  expect(onChange).toHaveBeenCalledWith("processArgs", "--verbose")
})

it("reuses the directory picker while keeping changes inside the caller draft", async () => {
  render(<ProcessEditor field="processCwd" draft={draft} onChange={onChange} />)
  fireEvent.change(screen.getByRole("textbox", { name: messages.settings.workingDirectory }), {
    target: { value: "/typed" },
  })
  expect(onChange).toHaveBeenCalledWith("processCwd", "/typed")
  await userEvent.click(
    screen.getByRole("button", { name: messages.settings.codexSkillRootsBrowse })
  )
  expect(onChange).toHaveBeenCalledWith("processCwd", "/picked")
})

it("edits a Host path without offering the desktop's local directory picker", () => {
  render(
    <ProcessEditor field="processCwd" draft={draft} onChange={onChange} allowLocalBrowse={false} />
  )
  expect(
    screen.queryByRole("button", { name: messages.settings.codexSkillRootsBrowse })
  ).not.toBeInTheDocument()
  fireEvent.change(screen.getByLabelText(messages.settings.workingDirectory), {
    target: { value: "/host/work" },
  })
  expect(onChange).toHaveBeenCalledWith("processCwd", "/host/work")
})

it("shows the saved-secret hint without revealing a stored key", () => {
  render(
    <NetworkEditor
      draft={draft}
      onChange={onChange}
      hasSavedApiKey
      errors={{ networkEndpoint: "endpointRequired" }}
    />
  )
  const key = screen.getByLabelText(messages.settings.apiKey)
  expect(key).toHaveAttribute("type", "password")
  expect(key).toHaveValue("")
  expect(key).toHaveAccessibleDescription(messages.settings.inspectorKeySaved)
  expect(screen.getByLabelText(messages.settings.endpoint)).toHaveAccessibleDescription(
    messages.settings.endpointRequired
  )
  fireEvent.change(key, { target: { value: "replacement" } })
  expect(onChange).toHaveBeenCalledWith("networkApiKey", "replacement")
})

it("lists only supported permissions and adapts the selected value", async () => {
  render(<PermissionModeEditor protocol="codex-app-server" value="dontAsk" onChange={onChange} />)
  const supported = supportedPermissionModes("codex-app-server")
  expect(screen.getAllByRole("radio")).toHaveLength(supported.length)
  const adapted = adaptPermissionMode("dontAsk", "codex-app-server").mode
  expect(
    screen.getByRole("radio", {
      name: String(
        messages.settings[PERMISSION_MODE_LABEL_KEY[adapted] as keyof typeof messages.settings]
      ),
    })
  ).toBeChecked()
  await userEvent.click(
    screen.getByRole("radio", { name: messages.settings.permissionAcceptEdits })
  )
  expect(onChange).toHaveBeenCalledWith("acceptEdits")
})

it("keeps the shared state field sign-in warning", async () => {
  render(<AgentStateEditor value="isolated" onChange={onChange} command="pi" showSignInWarning />)
  expect(screen.getByTestId("state-isolation-sign-in-warning")).toBeInTheDocument()
  await userEvent.click(screen.getByTestId("state-isolation-shared"))
  expect(onChange).toHaveBeenCalledWith("shared")
})

it("shows both optional session values and associates each validation error", () => {
  render(
    <SessionLimitEditor
      draft={draft}
      onChange={onChange}
      errors={{ sessionLimit: "sessionLimitInvalid", sessionIdleTimeout: "invalidIdleTimeout" }}
    />
  )
  const limit = screen.getByLabelText(messages.instanceSection.sessionLimit)
  const idle = screen.getByLabelText(manage.editor.idleTimeout)
  expect(limit).toHaveAttribute("aria-invalid", "true")
  expect(limit).toHaveAccessibleDescription(
    expect.stringContaining(messages.settings.sessionLimitInvalid)
  )
  expect(idle).toHaveAttribute("aria-invalid", "true")
  expect(idle).toHaveAccessibleDescription(
    expect.stringContaining(manage.editor.invalidIdleTimeout)
  )
  fireEvent.change(limit, { target: { value: "2" } })
  fireEvent.change(idle, { target: { value: "60000" } })
  expect(onChange.mock.calls).toEqual([
    ["sessionLimit", "2"],
    ["sessionIdleTimeout", "60000"],
  ])
})

it("controls every timeout/retry value and exponential backoff", async () => {
  render(
    <TimeoutRetryEditor
      draft={draft}
      onChange={onChange}
      errors={{ retryDelayMs: "mobileDetailNonNegativeIntegerInvalid" }}
    />
  )
  for (const [label, field] of [
    [messages.settings.executionTimeoutMs, "timeoutMs"],
    [messages.settings.maxRetries, "retryMaxRetries"],
    [messages.settings.retryDelayMs, "retryDelayMs"],
    [messages.settings.maxRetryDelayMs, "retryMaxDelayMs"],
  ]) {
    fireEvent.change(screen.getByLabelText(label), { target: { value: "0" } })
    expect(onChange).toHaveBeenCalledWith(field, "0")
  }
  expect(screen.getByLabelText(messages.settings.retryDelayMs)).toHaveAccessibleDescription(
    messages.settings.mobileDetailNonNegativeIntegerInvalid
  )
  await userEvent.click(screen.getByRole("switch", { name: messages.settings.backoffExponential }))
  expect(onChange).toHaveBeenCalledWith("retryExponentialBackoff", false)
})

it("controls automatic, native and unsupported web-search declarations", async () => {
  render(<WebSearchEditor value="auto" onChange={onChange} />)
  expect(screen.getByRole("radio", { name: messages.settings.declaredWebSearchAuto })).toBeChecked()
  await userEvent.click(
    screen.getByRole("radio", { name: messages.settings.declaredWebSearchNative })
  )
  await userEvent.click(
    screen.getByRole("radio", { name: messages.settings.declaredWebSearchNone })
  )
  expect(onChange.mock.calls).toEqual([["native"], ["unsupported"]])
})
