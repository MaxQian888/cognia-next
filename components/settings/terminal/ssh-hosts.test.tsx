/** @jest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react"

const saveSettings = jest.fn(async (..._args: unknown[]) => undefined)
const saveCredential = jest.fn(async (..._args: unknown[]) => undefined)
const clearCredential = jest.fn(async (..._args: unknown[]) => undefined)
const connect = jest.fn(async (..._args: unknown[]): Promise<unknown> => undefined)
const setPanelOpen = jest.fn()
const toastSuccess = jest.fn((..._args: unknown[]) => undefined)
const toastError = jest.fn((..._args: unknown[]) => undefined)
const mockSyncHostProfiles = jest.fn(async (..._args: unknown[]) => undefined)
let mockTauri = true
let settings: { terminal?: Record<string, unknown> } | undefined = {}

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({
      settings,
      save: (patch: { terminal?: Record<string, unknown> }) => {
        settings = { ...settings, ...patch }
        return saveSettings(patch)
      },
    }),
}))
jest.mock("@/stores/terminal/terminal-store", () => ({
  useTerminalStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({ setPanelOpen }),
    {
      getState: () => ({
        sessions: {},
        registerSession: jest.fn(),
        removeSession: jest.fn(),
        setSessionStatus: jest.fn(),
        setSessionExit: jest.fn(),
        setSessionCwd: jest.fn(),
        pushPrompt: jest.fn(),
        closePrompt: jest.fn(),
        pushCommand: jest.fn(),
        setPanelOpen,
      }),
    }
  ),
}))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) =>
    selector({ activeProjectId: "project-1" }),
}))
jest.mock("@/lib/terminal/ssh-credentials", () => ({
  saveSshCredential: (...args: unknown[]) => saveCredential(...args),
  clearSshCredential: (...args: unknown[]) => clearCredential(...args),
}))
jest.mock("@/lib/terminal/ssh-connect", () => ({
  connectSshFromDock: (...args: unknown[]) => connect(...args),
}))
jest.mock("@/lib/terminal/host-profiles", () => ({
  syncTerminalHostProfiles: (...args: unknown[]) => mockSyncHostProfiles(...args),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => mockTauri }))

import { SshHosts } from "./ssh-hosts"

beforeEach(() => {
  jest.clearAllMocks()
  settings = {}
  saveSettings.mockResolvedValue(undefined)
  saveCredential.mockResolvedValue(undefined)
  clearCredential.mockResolvedValue(undefined)
  connect.mockResolvedValue({
    kind: "connected",
    sessionId: "remote-1",
    hostKeyStatus: "learned",
    hostKeyFingerprint: "SHA256:abc",
  })
  mockSyncHostProfiles.mockResolvedValue(undefined)
  mockTauri = true
})

describe("SshHosts", () => {
  it("renders while settings are still loading", () => {
    settings = undefined
    render(<SshHosts />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("adds a secret-free SSH host profile", async () => {
    render(<SshHosts />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("ssh-hosts-add"))
    })
    expect(saveSettings).toHaveBeenLastCalledWith({
      terminal: expect.objectContaining({
        sshHosts: [
          expect.objectContaining({
            id: "ssh-1",
            host: "",
            port: 22,
            authMethod: "password",
          }),
        ],
      }),
    })
  })

  it("saves a password to keyring and opens the connected session in the dock", async () => {
    settings = {
      terminal: {
        sshHosts: [
          {
            id: "ssh-1",
            name: "Production",
            host: "prod.example.com",
            port: 22,
            username: "deploy",
            authMethod: "password",
          },
        ],
      },
    }
    render(<SshHosts />)
    fireEvent.change(screen.getByTestId("ssh-host-secret-ssh-1"), {
      target: { value: "  correct horse  " },
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId("ssh-host-connect-ssh-1"))
    })

    expect(saveCredential).toHaveBeenCalledWith("ssh-1", { password: "  correct horse  " })
    expect(saveSettings).toHaveBeenCalledWith({
      terminal: expect.objectContaining({
        sshHosts: [expect.objectContaining({ credentialRef: "ssh-1" })],
      }),
    })
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({ credentialRef: "ssh-1" }),
        projectId: "project-1",
        rows: 24,
        cols: 80,
      })
    )
    expect(setPanelOpen).toHaveBeenCalledWith(true)
    expect(toastSuccess).toHaveBeenCalledWith(
      "toasts.learned",
      expect.objectContaining({ description: "SHA256:abc" })
    )
  })

  it("removes the profile and its credential", async () => {
    settings = {
      terminal: {
        sshHosts: [
          {
            id: "ssh-1",
            name: "Production",
            host: "prod.example.com",
            port: 22,
            username: "deploy",
            authMethod: "password",
            credentialRef: "ssh-1",
          },
        ],
      },
    }
    render(<SshHosts />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("ssh-host-remove-ssh-1"))
    })
    expect(clearCredential).toHaveBeenCalledWith("ssh-1")
    expect(saveSettings).toHaveBeenCalledWith({
      terminal: expect.objectContaining({ sshHosts: [] }),
    })
  })

  it("persists edited host metadata", async () => {
    settings = {
      terminal: {
        sshHosts: [
          {
            id: "ssh-1",
            name: "Production",
            host: "prod.example.com",
            port: 22,
            username: "deploy",
            authMethod: "password",
            credentialRef: "ssh-1",
          },
          {
            id: "ssh-2",
            name: "Backup",
            host: "backup.example.com",
            port: 22,
            username: "deploy",
            authMethod: "password",
            credentialRef: "ssh-2",
          },
        ],
      },
    }
    render(<SshHosts />)

    await act(async () => {
      fireEvent.change(screen.getAllByLabelText("fields.name")[0], {
        target: { value: "Staging" },
      })
      fireEvent.change(screen.getAllByLabelText("fields.host")[0], {
        target: { value: "staging.example.com" },
      })
      fireEvent.change(screen.getAllByLabelText("fields.username")[0], {
        target: { value: "operator" },
      })
      fireEvent.change(screen.getAllByLabelText("fields.port")[0], {
        target: { value: "2222" },
      })
    })

    expect(saveSettings).toHaveBeenCalledTimes(4)
    expect(saveSettings).toHaveBeenCalledWith({
      terminal: expect.objectContaining({
        sshHosts: expect.arrayContaining([expect.objectContaining({ port: 2222 })]),
      }),
    })
  })

  it("connects with an unencrypted private key without saving a credential", async () => {
    settings = {
      terminal: {
        sshHosts: [
          {
            id: "ssh-1",
            name: "Production",
            host: "prod.example.com",
            port: 22,
            username: "deploy",
            authMethod: "privateKey",
            privateKeyPath: "~/.ssh/id_ed25519",
          },
        ],
      },
    }
    render(<SshHosts />)
    const keyPath = screen.getByLabelText("fields.privateKeyPath")
    expect(keyPath).toHaveValue("~/.ssh/id_ed25519")
    await act(async () => {
      fireEvent.change(keyPath, { target: { value: "~/.ssh/id_rsa" } })
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId("ssh-host-connect-ssh-1"))
    })
    expect(saveCredential).not.toHaveBeenCalled()
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({ authMethod: "privateKey" }),
        projectId: "project-1",
      })
    )
  })

  it("stores a private-key passphrase separately from host metadata", async () => {
    settings = {
      terminal: {
        sshHosts: [
          {
            id: "ssh-1",
            name: "Production",
            host: "prod.example.com",
            port: 22,
            username: "deploy",
            authMethod: "privateKey",
            privateKeyPath: "~/.ssh/id_ed25519",
          },
        ],
      },
    }
    render(<SshHosts />)
    fireEvent.change(screen.getByTestId("ssh-host-secret-ssh-1"), {
      target: { value: "key phrase" },
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId("ssh-host-connect-ssh-1"))
    })
    expect(saveCredential).toHaveBeenCalledWith("ssh-1", { passphrase: "key phrase" })
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({ credentialRef: "ssh-1" }),
      })
    )
  })

  it("requires a password when no credential has been stored", async () => {
    settings = {
      terminal: {
        sshHosts: [
          {
            id: "ssh-1",
            name: "Production",
            host: "prod.example.com",
            port: 22,
            username: "deploy",
            authMethod: "password",
          },
        ],
      },
    }
    render(<SshHosts />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("ssh-host-connect-ssh-1"))
    })
    expect(connect).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith("toasts.credentialRequired")
  })

  it("reports returned and thrown connection failures", async () => {
    settings = {
      terminal: {
        sshHosts: [
          {
            id: "ssh-1",
            name: "Production",
            host: "prod.example.com",
            port: 22,
            username: "deploy",
            authMethod: "password",
            credentialRef: "ssh-1",
          },
        ],
      },
    }
    const { unmount } = render(<SshHosts />)
    connect.mockResolvedValueOnce({ kind: "error", message: "rejected" })
    await act(async () => {
      fireEvent.click(screen.getByTestId("ssh-host-connect-ssh-1"))
    })
    expect(toastError).toHaveBeenCalledWith("toasts.connectFailed", {
      description: "rejected",
    })
    unmount()

    render(<SshHosts />)
    connect.mockRejectedValueOnce("offline")
    await act(async () => {
      fireEvent.click(screen.getByTestId("ssh-host-connect-ssh-1"))
    })
    expect(toastError).toHaveBeenCalledWith("toasts.connectFailed", {
      description: "offline",
    })
  })

  it("keeps the host when credential removal fails", async () => {
    settings = {
      terminal: {
        sshHosts: [
          {
            id: "ssh-1",
            name: "Production",
            host: "prod.example.com",
            port: 22,
            username: "deploy",
            authMethod: "password",
            credentialRef: "ssh-1",
          },
        ],
      },
    }
    clearCredential.mockRejectedValueOnce(new Error("keyring unavailable"))
    render(<SshHosts />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("ssh-host-remove-ssh-1"))
    })
    expect(saveSettings).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith("toasts.removeFailed", {
      description: "keyring unavailable",
    })
  })

  it("debounces desktop host-profile sync and cancels pending sync on unmount", async () => {
    jest.useFakeTimers()
    settings = {
      terminal: {
        profiles: [{ id: "default", shell: "/bin/zsh" }],
        enableShellIntegration: true,
        forceUtf8: true,
        sandboxed: false,
        sshHosts: [],
      },
    }
    const { unmount } = render(<SshHosts />)

    await act(async () => {
      fireEvent.click(screen.getByTestId("ssh-hosts-add"))
      await Promise.resolve()
    })
    act(() => jest.advanceTimersByTime(199))
    expect(mockSyncHostProfiles).not.toHaveBeenCalled()
    await act(async () => {
      jest.advanceTimersByTime(1)
      await Promise.resolve()
    })
    expect(mockSyncHostProfiles).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        enableShellIntegration: true,
        forceUtf8: true,
        sandboxed: false,
        sshProfiles: [expect.objectContaining({ id: "ssh-1" })],
      })
    )

    await act(async () => {
      fireEvent.click(screen.getByTestId("ssh-hosts-add"))
      await Promise.resolve()
    })
    unmount()
    act(() => jest.advanceTimersByTime(250))
    expect(mockSyncHostProfiles).toHaveBeenCalledTimes(1)
    jest.useRealTimers()
  })

  it("skips host-profile sync outside Tauri and reports native sync failures", async () => {
    jest.useFakeTimers()
    mockTauri = false
    const first = render(<SshHosts />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("ssh-hosts-add"))
      await Promise.resolve()
      jest.advanceTimersByTime(250)
    })
    expect(mockSyncHostProfiles).not.toHaveBeenCalled()
    first.unmount()

    mockTauri = true
    mockSyncHostProfiles.mockRejectedValueOnce(new Error("host unavailable"))
    render(<SshHosts />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("ssh-hosts-add"))
      await Promise.resolve()
      jest.advanceTimersByTime(250)
      await Promise.resolve()
    })
    expect(toastError).toHaveBeenCalledWith("toasts.syncFailed", {
      description: "host unavailable",
    })
    jest.useRealTimers()
  })
})
