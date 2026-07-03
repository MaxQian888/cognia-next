/** @jest-environment jsdom */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { InboundTab } from "./inbound-tab"
import { isTauri } from "@/lib/tauri"
import { remoteControlGetToken, remoteControlRotateToken } from "@/lib/tauri/remote-control"
import { useRemoteControlStore } from "@/stores/remote-control/store"
import { REMOTE_COMMAND_TARGETS } from "@/types/remote-control"

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))
jest.mock("@/lib/tauri/remote-control", () => ({
  remoteControlGetToken: jest.fn(),
  remoteControlRotateToken: jest.fn(),
  remoteControlSetSigningSecret: jest.fn(),
  remoteControlStart: jest.fn(),
  remoteControlStop: jest.fn(),
  remoteControlUpdateConfig: jest.fn(),
  remoteControlGetStatus: jest.fn(),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

const mockedIsTauri = isTauri as jest.MockedFunction<typeof isTauri>

Object.assign(navigator, {
  clipboard: { writeText: jest.fn(async () => {}) },
})

beforeEach(() => {
  jest.clearAllMocks()
  useRemoteControlStore.getState().reset()
})

describe("InboundTab — web", () => {
  it("renders the desktop-only notice and skips controls", () => {
    mockedIsTauri.mockReturnValue(false)
    render(<InboundTab />)
    expect(screen.getByText(/desktop runtime only|desktop-only/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/Enable inbound listener/i)).not.toBeInTheDocument()
  })
})

describe("InboundTab — desktop", () => {
  beforeEach(() => {
    mockedIsTauri.mockReturnValue(true)
  })

  it("disables enable switch and shows a hint until a token is generated", () => {
    useRemoteControlStore.setState({
      status: {
        inboundRunning: false,
        boundPort: null,
        lastCallAt: null,
        inboundCallsTotal: 0,
        hasInboundToken: false,
      },
    })
    render(<InboundTab />)
    const switchInput = screen.getByLabelText(/Enable inbound listener/i)
    expect(switchInput).toBeDisabled()
    expect(screen.getByRole("button", { name: /generate token/i })).toBeInTheDocument()
  })

  it("rotates the token and copies it on click", async () => {
    useRemoteControlStore.setState({
      status: {
        inboundRunning: false,
        boundPort: null,
        lastCallAt: null,
        inboundCallsTotal: 0,
        hasInboundToken: false,
      },
    })
    ;(remoteControlRotateToken as jest.Mock).mockResolvedValue("new-token")
    render(<InboundTab />)
    fireEvent.click(screen.getByRole("button", { name: /generate token/i }))
    await waitFor(() => expect(remoteControlRotateToken).toHaveBeenCalled())
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("new-token"))
  })

  it("validates allowlist entries through validateCidrOrIp", () => {
    useRemoteControlStore.setState({
      status: {
        inboundRunning: false,
        boundPort: null,
        lastCallAt: null,
        inboundCallsTotal: 0,
        hasInboundToken: true,
      },
    })
    render(<InboundTab />)
    const input = screen.getByPlaceholderText(/192.168.1.0\/24/) as HTMLInputElement
    fireEvent.change(input, { target: { value: "not-an-ip" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(screen.getByRole("alert")).toBeInTheDocument()
    // The store's allowlist still has the loopback default — invalid entries
    // never reach onAdd.
    expect(useRemoteControlStore.getState().config.inbound.allowlist).toEqual(["127.0.0.1/32"])
  })

  it("shows the non-loopback warning when the user adds a LAN entry", async () => {
    useRemoteControlStore.setState({
      status: {
        inboundRunning: false,
        boundPort: null,
        lastCallAt: null,
        inboundCallsTotal: 0,
        hasInboundToken: true,
      },
    })
    render(<InboundTab />)
    const input = screen.getByPlaceholderText(/192.168.1.0\/24/)
    fireEvent.change(input, { target: { value: "10.0.0.0/24" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(useRemoteControlStore.getState().config.inbound.allowlist).toContain("10.0.0.0/24")
    )
    expect(screen.getByText(/non-loopback/i)).toBeInTheDocument()
  })

  it("switches the token capability to read", async () => {
    useRemoteControlStore.setState({
      status: {
        inboundRunning: false,
        boundPort: null,
        lastCallAt: null,
        inboundCallsTotal: 0,
        hasInboundToken: true,
      },
    })
    render(<InboundTab />)
    expect(useRemoteControlStore.getState().config.inbound.capability).toBe("write")
    fireEvent.click(screen.getByRole("button", { name: /read only/i }))
    await waitFor(() =>
      expect(useRemoteControlStore.getState().config.inbound.capability).toBe("read")
    )
  })

  const withToken = () =>
    useRemoteControlStore.setState({
      status: {
        inboundRunning: false,
        boundPort: null,
        lastCallAt: null,
        inboundCallsTotal: 0,
        hasInboundToken: true,
      },
    })

  it("lists every command target route", () => {
    withToken()
    render(<InboundTab />)
    expect(screen.getByText(/commands\/workflow\.run/)).toBeInTheDocument()
    expect(screen.getByText(/commands\/plan\.run/)).toBeInTheDocument()
    // Sensitive targets carry a badge in the list.
    expect(screen.getByText(/commands\/chat\.send/)).toBeInTheDocument()
  })

  it("disables a command target through its permission switch", async () => {
    withToken()
    render(<InboundTab />)
    const sw = screen.getByLabelText(/allow workflow\.run/i)
    expect(sw).toBeChecked()
    fireEvent.click(sw)
    await waitFor(() =>
      expect(useRemoteControlStore.getState().config.inbound.disabledTargets).toContain(
        "workflow.run"
      )
    )
  })

  it("disables and re-enables every target via the bulk actions", async () => {
    withToken()
    render(<InboundTab />)
    fireEvent.click(screen.getByRole("button", { name: /disable all/i }))
    await waitFor(() =>
      expect(useRemoteControlStore.getState().config.inbound.disabledTargets).toHaveLength(
        REMOTE_COMMAND_TARGETS.length
      )
    )
    fireEvent.click(screen.getByRole("button", { name: /enable all/i }))
    await waitFor(() =>
      expect(useRemoteControlStore.getState().config.inbound.disabledTargets).toEqual([])
    )
  })

  it("copies a quickstart cURL snippet to the clipboard", async () => {
    withToken()
    render(<InboundTab />)
    fireEvent.click(screen.getAllByRole("button", { name: /copy snippet/i })[0])
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled())
    expect((navigator.clipboard.writeText as jest.Mock).mock.calls[0][0]).toContain(
      "/api/v1/health"
    )
  })

  it("toggles allowSensitiveTargets through updateInbound", async () => {
    useRemoteControlStore.setState({
      status: {
        inboundRunning: false,
        boundPort: null,
        lastCallAt: null,
        inboundCallsTotal: 0,
        hasInboundToken: true,
      },
    })
    render(<InboundTab />)
    expect(useRemoteControlStore.getState().config.inbound.allowSensitiveTargets).toBe(false)
    fireEvent.click(screen.getByLabelText(/allow sensitive targets/i))
    await waitFor(() =>
      expect(useRemoteControlStore.getState().config.inbound.allowSensitiveTargets).toBe(true)
    )
  })

  it("calls fetch with bearer header when testing the listener", async () => {
    ;(remoteControlGetToken as jest.Mock).mockResolvedValue("the-token")
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 })
    useRemoteControlStore.setState({
      status: {
        inboundRunning: true,
        boundPort: 47821,
        lastCallAt: null,
        inboundCallsTotal: 0,
        hasInboundToken: true,
      },
    })
    render(<InboundTab />)
    fireEvent.click(screen.getByRole("button", { name: /test inbound/i }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    const args = (fetch as jest.Mock).mock.calls[0]
    expect(args[0]).toContain("/api/v1/health")
    expect(args[1].headers.Authorization).toBe("Bearer the-token")
  })
})
