/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${ns}.${key}:${JSON.stringify(vals)}` : `${ns}.${key}`,
}))

// `var`, not `const`: jest.mock factories hoist above this body.
// eslint-disable-next-line no-var -- hoisting is the point.
var push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))

// eslint-disable-next-line no-var -- same hoisting rule.
var toastSuccess = jest.fn()
// eslint-disable-next-line no-var -- same hoisting rule.
var toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

// eslint-disable-next-line no-var -- same hoisting rule.
var connectSsh = jest.fn()
jest.mock("@/lib/terminal/ssh-connect", () => ({
  ...jest.requireActual("@/lib/terminal/ssh-connect"),
  connectSshFromDock: (...args: unknown[]) => connectSsh(...args),
}))

// eslint-disable-next-line no-var -- same hoisting rule.
var killSession = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/terminal/spawn-orchestrator", () => ({
  killFromDock: (...args: unknown[]) => killSession(...args),
}))

// eslint-disable-next-line no-var -- same hoisting rule.
var savedHosts: unknown[] = []
jest.mock("@/lib/terminal/saved-ssh-hosts", () => ({
  readSavedSshHosts: () => savedHosts,
}))

// eslint-disable-next-line no-var -- same hoisting rule.
var setPanelOpen = jest.fn()
jest.mock("@/stores/terminal/terminal-store", () => ({
  useTerminalStore: { getState: () => ({ setPanelOpen, sessions: {} }) },
}))

// eslint-disable-next-line no-var -- same hoisting rule.
var hostKeyOptions: { onForgotten?: (change: unknown) => void } = {}
// eslint-disable-next-line no-var -- same hoisting rule.
var capture = jest.fn(
  (message: unknown) => typeof message === "string" && message.startsWith("ssh_host_key_changed:")
)
jest.mock("@/hooks/terminal/use-ssh-host-key-change", () => ({
  useSshHostKeyChange: (options: { onForgotten?: (change: unknown) => void }) => {
    hostKeyOptions = options
    return { capture, dialog: null, change: null }
  },
}))

import type { SshHostProfile } from "@/lib/terminal/ssh-profiles"

import { useSshConnect } from "./use-ssh-connect"

const prod: SshHostProfile = {
  id: "ssh-1",
  name: "Production",
  host: "prod.example.com",
  port: 22,
  username: "deploy",
  authMethod: "password",
  credentialRef: "ssh-1",
}

beforeEach(() => {
  jest.clearAllMocks()
  savedHosts = [prod]
  connectSsh.mockResolvedValue({
    kind: "connected",
    sessionId: "tab-1",
    hostKeyStatus: "learned",
    hostKeyFingerprint: "SHA256:abc",
  })
})

it("connects a saved host, reveals the dock and reports the host-key verdict", async () => {
  const onConnected = jest.fn()
  const { result } = renderHook(() => useSshConnect({ onConnected }))
  await act(async () => {
    await result.current.connect({ hostId: "ssh-1", projectId: "p-1" })
  })
  expect(connectSsh).toHaveBeenCalledWith(
    expect.objectContaining({ profile: prod, allProfiles: [prod], projectId: "p-1" })
  )
  expect(setPanelOpen).toHaveBeenCalledWith(true)
  expect(toastSuccess).toHaveBeenCalledWith(
    'terminal.sshConnect.connected.learned:{"name":"Production"}',
    { description: "SHA256:abc" }
  )
  expect(onConnected).toHaveBeenCalledWith("tab-1")
})

it("does not open the dock for a surface that is the terminal", async () => {
  const { result } = renderHook(() => useSshConnect({ revealDock: false }))
  await act(async () => {
    await result.current.connect({ hostId: "ssh-1" })
  })
  expect(setPanelOpen).not.toHaveBeenCalled()
})

it("says the host verified the key when the wire carries no verdict", async () => {
  connectSsh.mockResolvedValue({
    kind: "connected",
    sessionId: "tab-2",
    hostKeyStatus: null,
    hostKeyFingerprint: null,
  })
  const { result } = renderHook(() => useSshConnect())
  await act(async () => {
    await result.current.connect({ hostId: "ssh-1" })
  })
  expect(toastSuccess).toHaveBeenCalledWith(
    'terminal.sshConnect.connected.viaHost:{"name":"Production"}'
  )
})

it("refuses a password host with nothing stored, with an action that opens it", async () => {
  savedHosts = [{ ...prod, credentialRef: undefined }]
  const { result } = renderHook(() => useSshConnect())
  await act(async () => {
    await result.current.connect({ hostId: "ssh-1" })
  })
  expect(connectSsh).not.toHaveBeenCalled()
  const [, options] = toastError.mock.calls[0]
  expect(options.action.label).toBe("terminal.sshConnect.actions.addPassword")
  options.action.onClick()
  expect(push).toHaveBeenCalledWith("/settings?section=terminal&terminalPanel=ssh&sshHost=ssh-1")
})

it("points the fix at a bastion that is missing its password", async () => {
  const bastion: SshHostProfile = {
    ...prod,
    id: "ssh-2",
    name: "Bastion",
    credentialRef: undefined,
  }
  savedHosts = [{ ...prod, authMethod: "agent", jumpHostId: "ssh-2" }, bastion]
  const { result } = renderHook(() => useSshConnect())
  await act(async () => {
    await result.current.connect({ hostId: "ssh-1" })
  })
  expect(toastError.mock.calls[0][0]).toBe(
    'terminal.sshConnect.credentialRequiredBastion:{"name":"Production","bastion":"Bastion"}'
  )
  toastError.mock.calls[0][1].action.onClick()
  expect(push).toHaveBeenCalledWith("/settings?section=terminal&terminalPanel=ssh&sshHost=ssh-2")
})

it("names a broken jump chain before dialing anything", async () => {
  savedHosts = [{ ...prod, jumpHostId: "gone" }]
  const { result } = renderHook(() => useSshConnect())
  await act(async () => {
    await result.current.connect({ hostId: "ssh-1" })
  })
  expect(connectSsh).not.toHaveBeenCalled()
  expect(toastError.mock.calls[0][0]).toBe('terminal.sshConnect.chainBroken:{"name":"Production"}')
})

it("translates the not-on-host marker instead of printing it", async () => {
  connectSsh.mockResolvedValue({ kind: "error", message: "ssh_profile_not_on_host:Production" })
  const { result } = renderHook(() => useSshConnect())
  await act(async () => {
    await result.current.connect({ hostId: "ssh-1" })
  })
  expect(toastError.mock.calls[0][0]).toBe('terminal.sshConnect.notOnHost:{"name":"Production"}')
})

it("names the invalid field rather than the raw reason", async () => {
  connectSsh.mockResolvedValue({ kind: "error", message: "invalid SSH host profile: localForward" })
  const { result } = renderHook(() => useSshConnect())
  await act(async () => {
    await result.current.connect({ hostId: "ssh-1" })
  })
  expect(toastError.mock.calls[0][1].description).toBe(
    "terminal.sshConnect.invalidField.localForward"
  )
})

it("recognises a missing ssh-agent", async () => {
  savedHosts = [{ ...prod, authMethod: "agent", credentialRef: undefined }]
  connectSsh.mockResolvedValue({ kind: "error", message: "SSH agent is not running" })
  const { result } = renderHook(() => useSshConnect())
  await act(async () => {
    await result.current.connect({ hostId: "ssh-1" })
  })
  expect(toastError).toHaveBeenCalledWith(
    'terminal.sshConnect.agentUnavailable:{"name":"Production"}',
    expect.objectContaining({ description: "SSH agent is not running" })
  )
})

it("routes failures inline when the caller asks, never toasting them", async () => {
  connectSsh.mockResolvedValue({ kind: "error", message: "connection refused" })
  const onFailure = jest.fn()
  const { result } = renderHook(() => useSshConnect({ onFailure }))
  await act(async () => {
    await result.current.connect({ hostId: "ssh-1" })
  })
  expect(toastError).not.toHaveBeenCalled()
  expect(onFailure).toHaveBeenCalledWith(
    'terminal.sshConnect.failed:{"name":"Production"} connection refused'
  )
})

it("hands a changed host key to the dialog and retries once it is re-trusted", async () => {
  connectSsh.mockResolvedValueOnce({ kind: "error", message: "ssh_host_key_changed:{}" })
  const { result } = renderHook(() => useSshConnect())
  await act(async () => {
    await result.current.connect({ hostId: "ssh-1" })
  })
  expect(toastError).not.toHaveBeenCalled()
  expect(connectSsh).toHaveBeenCalledTimes(1)

  await act(async () => {
    hostKeyOptions.onForgotten?.({})
  })
  expect(connectSsh).toHaveBeenCalledTimes(2)
  expect(toastSuccess).toHaveBeenCalled()
})

it("closes the replaced tab only after the new connection exists", async () => {
  const { result } = renderHook(() => useSshConnect())
  await act(async () => {
    await result.current.connect({ hostId: "ssh-1", replacesSessionId: "old-tab" })
  })
  expect(killSession).toHaveBeenCalledWith("old-tab", expect.anything())

  killSession.mockClear()
  connectSsh.mockResolvedValue({ kind: "error", message: "connection refused" })
  await act(async () => {
    await result.current.connect({ hostId: "ssh-1", replacesSessionId: "old-tab" })
  })
  expect(killSession).not.toHaveBeenCalled()
})

it("resolves against the editor's in-flight list when one is passed", async () => {
  const edited = { ...prod, port: 2222 }
  const { result } = renderHook(() => useSshConnect())
  await act(async () => {
    await result.current.connect({ hostId: "ssh-1", profiles: [edited] })
  })
  expect(connectSsh).toHaveBeenCalledWith(expect.objectContaining({ profile: edited }))
})

it("reports which host is connecting while the dial is in flight", async () => {
  let release: (value: unknown) => void = () => undefined
  connectSsh.mockReturnValue(new Promise((resolve) => (release = resolve)))
  const { result } = renderHook(() => useSshConnect())
  let pending: Promise<unknown> = Promise.resolve()
  act(() => {
    pending = result.current.connect({ hostId: "ssh-1" })
  })
  expect(result.current.pendingHostId).toBe("ssh-1")
  await act(async () => {
    release({
      kind: "connected",
      sessionId: "x",
      hostKeyStatus: "verified",
      hostKeyFingerprint: "f",
    })
    await pending
  })
  expect(result.current.pendingHostId).toBeNull()
})
