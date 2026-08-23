/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act, cleanup } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) => {
    if (params && Object.keys(params).length) {
      return `${key}:${JSON.stringify(params)}`
    }
    return key
  },
}))

const saveMock = jest.fn().mockResolvedValue(undefined)
let mockedSettings: Record<string, unknown> = {}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(
    selector: (s: { settings: typeof mockedSettings; save: typeof saveMock }) => T
  ) => selector({ settings: mockedSettings, save: saveMock }),
}))

jest.mock("@/stores/network-proxy", () => ({
  applyProxyToRust: jest.fn().mockResolvedValue(undefined),
  getProxyRuntimeStatus: jest
    .fn()
    .mockResolvedValue({ state: "ready", credentialConfigured: false }),
  updateProxyPassword: jest.fn().mockResolvedValue(true),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const networkProxyModule = require("@/stores/network-proxy") as {
  applyProxyToRust: jest.Mock
  getProxyRuntimeStatus: jest.Mock
  updateProxyPassword: jest.Mock
}
const applyProxyToRustMock = networkProxyModule.applyProxyToRust
const getProxyRuntimeStatusMock = networkProxyModule.getProxyRuntimeStatus
const updateProxyPasswordMock = networkProxyModule.updateProxyPassword

import { NetworkGeneralTab } from "./general-tab"
import { DEFAULT_NETWORK_PROXY_SETTINGS } from "@/types/network/proxy"

beforeEach(() => {
  saveMock.mockClear()
  applyProxyToRustMock.mockClear()
  getProxyRuntimeStatusMock
    .mockReset()
    .mockResolvedValue({ state: "ready", credentialConfigured: false })
  updateProxyPasswordMock.mockReset().mockResolvedValue(true)
  mockedSettings = {}
})

describe("NetworkGeneralTab", () => {
  it("renders the mode radio with three options", () => {
    render(<NetworkGeneralTab />)
    expect(screen.getByText("mode.off")).toBeInTheDocument()
    expect(screen.getByText("mode.manual")).toBeInTheDocument()
    expect(screen.getByText("mode.auto")).toBeInTheDocument()
  })

  it("disables host/port inputs when mode is off", () => {
    mockedSettings = { networkProxy: { ...DEFAULT_NETWORK_PROXY_SETTINGS, mode: "off" } }
    render(<NetworkGeneralTab />)
    const hostInput = screen.getByLabelText("form.host") as HTMLInputElement
    expect(hostInput.disabled).toBe(true)
  })

  it("enables host/port inputs when mode is manual", () => {
    mockedSettings = {
      networkProxy: { ...DEFAULT_NETWORK_PROXY_SETTINGS, mode: "manual" },
    }
    render(<NetworkGeneralTab />)
    const hostInput = screen.getByLabelText("form.host") as HTMLInputElement
    expect(hostInput.disabled).toBe(false)
  })

  it("commits host on blur and pushes to Rust (not on every keystroke)", async () => {
    mockedSettings = {
      networkProxy: { ...DEFAULT_NETWORK_PROXY_SETTINGS, mode: "manual" },
    }
    render(<NetworkGeneralTab />)
    const hostInput = screen.getByLabelText("form.host") as HTMLInputElement
    // Typing does NOT persist — the draft lives in local state.
    await act(async () => {
      fireEvent.change(hostInput, { target: { value: "127.0.0.1" } })
    })
    expect(saveMock).not.toHaveBeenCalled()
    // Blur commits the draft.
    await act(async () => {
      fireEvent.blur(hostInput)
    })
    expect(saveMock).toHaveBeenCalled()
    const patch = saveMock.mock.calls[0][0]
    expect(patch.networkProxy.host).toBe("127.0.0.1")
    expect(applyProxyToRustMock).toHaveBeenCalled()
  })

  it("commits host on Enter", async () => {
    mockedSettings = {
      networkProxy: { ...DEFAULT_NETWORK_PROXY_SETTINGS, mode: "manual" },
    }
    render(<NetworkGeneralTab />)
    const hostInput = screen.getByLabelText("form.host") as HTMLInputElement
    await act(async () => {
      fireEvent.change(hostInput, { target: { value: "10.0.0.9" } })
    })
    // Enter blurs the field, which commits.
    await act(async () => {
      fireEvent.keyDown(hostInput, { key: "Enter" })
      fireEvent.blur(hostInput)
    })
    expect(saveMock.mock.calls[0][0].networkProxy.host).toBe("10.0.0.9")
  })

  it("clamps port to 0..65535 on blur", async () => {
    mockedSettings = {
      networkProxy: { ...DEFAULT_NETWORK_PROXY_SETTINGS, mode: "manual" },
    }
    render(<NetworkGeneralTab />)
    const portInput = screen.getByLabelText("form.port") as HTMLInputElement
    await act(async () => {
      fireEvent.change(portInput, { target: { value: "999999" } })
      fireEvent.blur(portInput)
    })
    const patch = saveMock.mock.calls[0][0]
    expect(patch.networkProxy.port).toBeLessThanOrEqual(65535)
  })

  it("does not persist when a text field is blurred unchanged", async () => {
    mockedSettings = {
      networkProxy: { ...DEFAULT_NETWORK_PROXY_SETTINGS, mode: "manual", host: "1.2.3.4" },
    }
    render(<NetworkGeneralTab />)
    const hostInput = screen.getByLabelText("form.host") as HTMLInputElement
    await act(async () => {
      fireEvent.focus(hostInput)
      fireEvent.blur(hostInput)
    })
    expect(saveMock).not.toHaveBeenCalled()
  })

  it("adds a bypass entry on Enter", async () => {
    mockedSettings = {
      networkProxy: { ...DEFAULT_NETWORK_PROXY_SETTINGS, mode: "manual" },
    }
    render(<NetworkGeneralTab />)
    const bypassInput = screen.getByLabelText("form.bypass") as HTMLInputElement
    await act(async () => {
      fireEvent.change(bypassInput, { target: { value: ".internal" } })
    })
    await act(async () => {
      fireEvent.keyDown(bypassInput, { key: "Enter" })
    })
    expect(saveMock).toHaveBeenCalled()
    const patch = saveMock.mock.calls[saveMock.mock.calls.length - 1][0]
    expect(patch.networkProxy.bypass).toContain(".internal")
  })

  it("does not add a duplicate bypass entry", async () => {
    mockedSettings = {
      networkProxy: {
        ...DEFAULT_NETWORK_PROXY_SETTINGS,
        mode: "manual",
        bypass: ["localhost", ".internal"],
      },
    }
    render(<NetworkGeneralTab />)
    const bypassInput = screen.getByLabelText("form.bypass") as HTMLInputElement
    saveMock.mockClear()
    await act(async () => {
      fireEvent.change(bypassInput, { target: { value: ".internal" } })
    })
    saveMock.mockClear()
    await act(async () => {
      fireEvent.keyDown(bypassInput, { key: "Enter" })
    })
    // Save should not be called for the duplicate add path.
    expect(saveMock).not.toHaveBeenCalled()
  })

  it("toggling the proxyWebsockets switch persists the new value", async () => {
    mockedSettings = {
      networkProxy: {
        ...DEFAULT_NETWORK_PROXY_SETTINGS,
        mode: "manual",
        proxyWebsockets: true,
      },
    }
    render(<NetworkGeneralTab />)
    const wsSwitch = screen.getByLabelText("form.proxyWebsocketsLabel")
    await act(async () => {
      fireEvent.click(wsSwitch)
    })
    expect(saveMock).toHaveBeenCalled()
    const patch = saveMock.mock.calls[0][0]
    expect(patch.networkProxy.proxyWebsockets).toBe(false)
  })

  it("commits port on Enter", async () => {
    mockedSettings = {
      networkProxy: { ...DEFAULT_NETWORK_PROXY_SETTINGS, mode: "manual" },
    }
    render(<NetworkGeneralTab />)
    const portInput = screen.getByLabelText("form.port") as HTMLInputElement
    await act(async () => {
      fireEvent.change(portInput, { target: { value: "7890" } })
    })
    await act(async () => {
      fireEvent.keyDown(portInput, { key: "Enter" })
      fireEvent.blur(portInput)
    })
    expect(saveMock.mock.calls[0][0].networkProxy.port).toBe(7890)
  })

  it("replaces a password in keyring without persisting it in Dexie", async () => {
    mockedSettings = {
      networkProxy: { ...DEFAULT_NETWORK_PROXY_SETTINGS, mode: "manual" },
    }
    render(<NetworkGeneralTab />)
    const passwordInput = screen.getByLabelText("form.password") as HTMLInputElement
    await act(async () => {
      fireEvent.change(passwordInput, { target: { value: "s3cret" } })
      fireEvent.keyDown(passwordInput, { key: "Enter" })
      fireEvent.blur(passwordInput)
    })
    expect(updateProxyPasswordMock).toHaveBeenCalledWith({
      kind: "replace",
      value: "s3cret",
    })
    expect(JSON.stringify(saveMock.mock.calls)).not.toContain("s3cret")
  })

  it("keeps an existing credential until the explicit clear action is used", async () => {
    getProxyRuntimeStatusMock.mockResolvedValue({ state: "ready", credentialConfigured: true })
    mockedSettings = {
      networkProxy: { ...DEFAULT_NETWORK_PROXY_SETTINGS, mode: "manual" },
    }
    render(<NetworkGeneralTab />)

    await act(async () => undefined)
    const passwordInput = screen.getByLabelText("form.password") as HTMLInputElement
    await act(async () => {
      fireEvent.focus(passwordInput)
      fireEvent.blur(passwordInput)
    })
    expect(updateProxyPasswordMock).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "form.clearPassword" }))
    })
    expect(updateProxyPasswordMock).toHaveBeenCalledWith({ kind: "clear" })
  })

  it("a non-Enter keydown does not commit", async () => {
    mockedSettings = {
      networkProxy: { ...DEFAULT_NETWORK_PROXY_SETTINGS, mode: "manual" },
    }
    render(<NetworkGeneralTab />)
    const hostInput = screen.getByLabelText("form.host") as HTMLInputElement
    await act(async () => {
      fireEvent.change(hostInput, { target: { value: "9.9.9.9" } })
      fireEvent.keyDown(hostInput, { key: "a" })
    })
    expect(saveMock).not.toHaveBeenCalled()
  })

  it("selecting a mode persists it immediately", async () => {
    mockedSettings = {
      networkProxy: { ...DEFAULT_NETWORK_PROXY_SETTINGS, mode: "off" },
    }
    render(<NetworkGeneralTab />)
    await act(async () => {
      fireEvent.click(screen.getByText("mode.manual"))
    })
    expect(saveMock).toHaveBeenCalled()
    expect(saveMock.mock.calls[0][0].networkProxy.mode).toBe("manual")
  })

  it("removes a bypass entry when its badge is clicked", async () => {
    mockedSettings = {
      networkProxy: {
        ...DEFAULT_NETWORK_PROXY_SETTINGS,
        mode: "manual",
        bypass: ["localhost", ".internal"],
      },
    }
    render(<NetworkGeneralTab />)
    await act(async () => {
      fireEvent.click(screen.getByLabelText('form.removeBypass:{"entry":".internal"}'))
    })
    expect(saveMock).toHaveBeenCalled()
    expect(saveMock.mock.calls[0][0].networkProxy.bypass).not.toContain(".internal")
  })

  it("commits username on blur with the new value", async () => {
    mockedSettings = {
      networkProxy: { ...DEFAULT_NETWORK_PROXY_SETTINGS, mode: "manual" },
    }
    render(<NetworkGeneralTab />)
    const usernameInput = screen.getByLabelText("form.username") as HTMLInputElement
    await act(async () => {
      fireEvent.change(usernameInput, { target: { value: "alice" } })
      fireEvent.keyDown(usernameInput, { key: "Enter" })
      fireEvent.blur(usernameInput)
    })
    expect(saveMock).toHaveBeenCalled()
    const patch = saveMock.mock.calls[0][0]
    expect(patch.networkProxy.username).toBe("alice")
  })
})

describe("NetworkGeneralTab — host and port validation", () => {
  async function commitHost(value: string): Promise<HTMLInputElement> {
    mockedSettings = { networkProxy: { ...DEFAULT_NETWORK_PROXY_SETTINGS, mode: "manual" } }
    render(<NetworkGeneralTab />)
    const input = screen.getByLabelText("form.host") as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { value } })
      fireEvent.blur(input)
    })
    return input
  }

  it("names the specific mistake for each rejected host", async () => {
    // These were all accepted before, producing `http://http://proxy:8080` or
    // a double port, and surfacing much later as an opaque connect failure.
    for (const [value, reason] of [
      ["http://proxy.corp", "scheme"],
      ["user:pw@proxy.corp", "userinfo"],
      ["proxy.corp:8080", "port-in-host"],
      ["proxy.corp/path", "path"],
      ["proxy..corp", "malformed"],
    ] as const) {
      const input = await commitHost(value)
      expect(screen.getByRole("alert")).toHaveTextContent(`form.hostError.${reason}`)
      expect(input).toHaveAttribute("aria-invalid", "true")
      cleanup()
    }
  })

  it("accepts a plain host, an IPv4 literal and an IPv6 literal without complaint", async () => {
    for (const value of ["proxy.corp", "127.0.0.1", "::1", "[2001:db8::1]"]) {
      const input = await commitHost(value)
      expect(screen.queryByRole("alert")).toBeNull()
      expect(input).toHaveAttribute("aria-invalid", "false")
      cleanup()
    }
  })

  it("still persists a rejected host so the field never lies about what is stored", async () => {
    // Silently discarding the typed value would leave the input showing
    // something the app does not actually have.
    saveMock.mockClear()
    await commitHost("http://proxy.corp")
    expect(saveMock.mock.calls[0][0].networkProxy.host).toBe("http://proxy.corp")
  })

  it("clears the message once the host is corrected", async () => {
    mockedSettings = { networkProxy: { ...DEFAULT_NETWORK_PROXY_SETTINGS, mode: "manual" } }
    render(<NetworkGeneralTab />)
    const input = screen.getByLabelText("form.host") as HTMLInputElement

    await act(async () => {
      fireEvent.change(input, { target: { value: "http://proxy.corp" } })
      fireEvent.blur(input)
    })
    expect(screen.getByRole("alert")).toBeInTheDocument()

    await act(async () => {
      fireEvent.change(input, { target: { value: "proxy.corp" } })
      fireEvent.blur(input)
    })
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("flags an out-of-range port but treats an empty field as unset", async () => {
    mockedSettings = { networkProxy: { ...DEFAULT_NETWORK_PROXY_SETTINGS, mode: "manual" } }
    render(<NetworkGeneralTab />)
    const input = screen.getByLabelText("form.port") as HTMLInputElement

    await act(async () => {
      fireEvent.change(input, { target: { value: "0" } })
      fireEvent.blur(input)
    })
    expect(screen.getByRole("alert")).toHaveTextContent("form.portError")

    // Clearing the field is how a user unsets the port, not an error.
    await act(async () => {
      fireEvent.change(input, { target: { value: "" } })
      fireEvent.blur(input)
    })
    expect(screen.queryByRole("alert")).toBeNull()

    await act(async () => {
      fireEvent.change(input, { target: { value: "7890" } })
      fireEvent.blur(input)
    })
    expect(screen.queryByRole("alert")).toBeNull()
  })
})
