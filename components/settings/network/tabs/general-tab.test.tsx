/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act } from "@testing-library/react"

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
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const networkProxyModule = require("@/stores/network-proxy") as {
  applyProxyToRust: jest.Mock
}
const applyProxyToRustMock = networkProxyModule.applyProxyToRust

import { NetworkGeneralTab } from "./general-tab"
import { DEFAULT_NETWORK_PROXY_SETTINGS } from "@/types/network/proxy"

beforeEach(() => {
  saveMock.mockClear()
  applyProxyToRustMock.mockClear()
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

  it("editing host writes the patch and pushes to Rust", async () => {
    mockedSettings = {
      networkProxy: { ...DEFAULT_NETWORK_PROXY_SETTINGS, mode: "manual" },
    }
    render(<NetworkGeneralTab />)
    const hostInput = screen.getByLabelText("form.host") as HTMLInputElement
    await act(async () => {
      fireEvent.change(hostInput, { target: { value: "127.0.0.1" } })
    })
    expect(saveMock).toHaveBeenCalled()
    const patch = saveMock.mock.calls[0][0]
    expect(patch.networkProxy.host).toBe("127.0.0.1")
    expect(applyProxyToRustMock).toHaveBeenCalled()
  })

  it("clamps port to 0..65535", async () => {
    mockedSettings = {
      networkProxy: { ...DEFAULT_NETWORK_PROXY_SETTINGS, mode: "manual" },
    }
    render(<NetworkGeneralTab />)
    const portInput = screen.getByLabelText("form.port") as HTMLInputElement
    await act(async () => {
      fireEvent.change(portInput, { target: { value: "999999" } })
    })
    const patch = saveMock.mock.calls[0][0]
    expect(patch.networkProxy.port).toBeLessThanOrEqual(65535)
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

  it("editing username triggers persist with the new value", async () => {
    mockedSettings = {
      networkProxy: { ...DEFAULT_NETWORK_PROXY_SETTINGS, mode: "manual" },
    }
    render(<NetworkGeneralTab />)
    const usernameInput = screen.getByLabelText("form.username") as HTMLInputElement
    await act(async () => {
      fireEvent.change(usernameInput, { target: { value: "alice" } })
    })
    expect(saveMock).toHaveBeenCalled()
    const patch = saveMock.mock.calls[0][0]
    expect(patch.networkProxy.username).toBe("alice")
  })
})
