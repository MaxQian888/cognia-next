/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"

import { TeammateExecutionBindingField } from "./teammate-execution-binding-field"

const flags: Record<string, boolean> = {
  agentExecutionResolverV2: false,
  agentTeamRemoteDispatch: false,
}
let taskWorkspace = false
let hosts: Array<Record<string, unknown>> = []

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("@/hooks/agent/use-agent-execution-flag", () => ({
  useAgentExecutionFlag: (flag: string) => flags[flag] ?? false,
}))
jest.mock("@/hooks/fleet/use-fleet-snapshot", () => ({
  useFleetSnapshot: () => ({ snapshot: { hosts } }),
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: { developer: { taskWorkspace } } }),
}))
jest.mock("@/components/ui/select", () => ({
  ...(() => {
    const React = jest.requireActual<typeof import("react")>("react")
    const SelectContext = React.createContext<(value: string) => void>(() => undefined)
    return {
      Select: ({
        children,
        onValueChange,
      }: {
        children: React.ReactNode
        onValueChange?: (value: string) => void
      }) => (
        <SelectContext.Provider value={onValueChange ?? (() => undefined)}>
          <div>{children}</div>
        </SelectContext.Provider>
      ),
      SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      SelectItem: ({
        children,
        disabled,
        value,
      }: {
        children: React.ReactNode
        disabled?: boolean
        value: string
      }) => {
        const onValueChange = React.useContext(SelectContext)
        return (
          <button disabled={disabled} onClick={() => onValueChange(value)}>
            {children}
          </button>
        )
      },
      SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      SelectValue: () => null,
    }
  })(),
}))

describe("TeammateExecutionBindingField remote prerequisites", () => {
  beforeEach(() => {
    flags.agentExecutionResolverV2 = false
    flags.agentTeamRemoteDispatch = false
    taskWorkspace = false
    hosts = []
  })

  it("keeps an offline pinned host visible while disabling remote targets", () => {
    render(
      <TeammateExecutionBindingField
        value={{ mode: "inherit", executionTarget: { mode: "pinned", hostRef: "device:saved" } }}
        onChange={jest.fn()}
      />
    )

    expect(screen.getByRole("button", { name: "hostAuto" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "hostPinnedOffline" })).toBeDisabled()
    expect(screen.getByText("remotePrerequisitesHint")).toBeInTheDocument()
  })

  it("enables only profile-ready remote hosts after all gates are active", () => {
    flags.agentExecutionResolverV2 = true
    flags.agentTeamRemoteDispatch = true
    taskWorkspace = true
    hosts = [
      { hostRef: "device:ready", online: true, placementReady: true },
      { hostRef: "device:legacy", online: true, placementReady: false },
      { hostRef: "device:offline", online: false, placementReady: true },
    ]
    render(<TeammateExecutionBindingField value={{ mode: "inherit" }} onChange={jest.fn()} />)

    expect(screen.getByRole("button", { name: "hostAuto" })).toBeEnabled()
    const pinned = screen.getAllByRole("button", { name: "hostPinned" })
    expect(pinned[0]).toBeEnabled()
    expect(pinned[1]).toBeDisabled()
    expect(screen.getByRole("button", { name: "hostPinnedOffline" })).toBeDisabled()
  })

  it.each([
    [true, false, true, true],
    [true, true, false, true],
    [true, true, true, false],
  ])(
    "keeps remote auto disabled when one prerequisite is missing",
    (resolver, dispatch, workspace, profile) => {
      flags.agentExecutionResolverV2 = resolver
      flags.agentTeamRemoteDispatch = dispatch
      taskWorkspace = workspace
      hosts = profile ? [{ hostRef: "device:ready", online: true, placementReady: true }] : []
      const { unmount } = render(
        <TeammateExecutionBindingField value={undefined} onChange={jest.fn()} />
      )
      expect(screen.getByRole("button", { name: "hostAuto" })).toBeDisabled()
      unmount()
    }
  )

  it("labels an advertised offline host and preserves the waiting warning", () => {
    flags.agentExecutionResolverV2 = true
    flags.agentTeamRemoteDispatch = true
    taskWorkspace = true
    hosts = [{ hostRef: "device:offline", online: false, placementReady: true }]
    render(
      <TeammateExecutionBindingField
        value={{ mode: "pinned", executionTarget: { mode: "pinned", hostRef: "device:offline" } }}
        teamDefault={{ mode: "inherit" }}
        onChange={jest.fn()}
      />
    )

    expect(screen.getByRole("button", { name: "hostPinnedOffline" })).toBeDisabled()
    expect(screen.getByText("hostWaitingWarning")).toBeInTheDocument()
    expect(screen.getByPlaceholderText("deploymentRefPlaceholder")).toHaveValue("")
    expect(screen.getByPlaceholderText("credentialProfileRefPlaceholder")).toHaveValue("")
  })

  it("routes binding, host, policy, and ref edits through the shared field", () => {
    flags.agentExecutionResolverV2 = true
    flags.agentTeamRemoteDispatch = true
    taskWorkspace = true
    hosts = [{ hostRef: "device:ready", online: true, placementReady: true }]
    const onChange = jest.fn()
    const { rerender } = render(
      <TeammateExecutionBindingField
        value={{
          mode: "pinned",
          runtimePolicy: "ai-sdk",
          modelRole: "fast",
          deploymentRef: "deployment:old",
          credentialProfileRef: "credential:old",
          executionTarget: { mode: "pinned", hostRef: "device:ready" },
        }}
        onChange={onChange}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "modeInherit" }))
    fireEvent.click(screen.getByRole("button", { name: "modePinned" }))
    fireEvent.click(screen.getByRole("button", { name: "modePool" }))
    fireEvent.click(screen.getByRole("button", { name: "hostLocal" }))
    fireEvent.click(screen.getByRole("button", { name: "hostAuto" }))
    fireEvent.click(screen.getByRole("button", { name: "hostPinned" }))
    fireEvent.click(screen.getByRole("button", { name: "runtimeAuto" }))
    fireEvent.click(screen.getByRole("button", { name: "runtimeAiSdk" }))
    fireEvent.click(screen.getByRole("button", { name: "modelRoleInherit" }))
    fireEvent.click(screen.getByRole("button", { name: "modelRolePrimary" }))

    const deployment = screen.getByPlaceholderText("deploymentRefPlaceholder")
    fireEvent.change(deployment, { target: { value: " deployment:new " } })
    fireEvent.blur(deployment)
    const credential = screen.getByPlaceholderText("credentialProfileRefPlaceholder")
    fireEvent.change(credential, { target: { value: " " } })
    fireEvent.blur(credential)

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ executionTarget: { mode: "auto" } })
    )
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ deploymentRef: "deployment:new" })
    )
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ credentialProfileRef: undefined })
    )

    rerender(
      <TeammateExecutionBindingField
        value={{ mode: "pool", candidateIds: ["a"], executionTarget: { mode: "colocate" } }}
        onChange={onChange}
      />
    )
    const candidates = screen.getByPlaceholderText("candidateIdsPlaceholder")
    fireEvent.change(candidates, { target: { value: " a, , b " } })
    fireEvent.blur(candidates)
    expect(onChange).toHaveBeenCalledWith({
      mode: "pool",
      candidateIds: ["a", "b"],
      executionTarget: { mode: "colocate" },
    })
  })
})
