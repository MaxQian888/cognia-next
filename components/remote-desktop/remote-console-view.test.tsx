import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))
jest.mock("@/lib/tauri/transport-instance", () => ({ localTransport: { call: jest.fn() } }))
jest.mock("@/lib/remote-host/management-channel", () => ({ withManagementChannel: jest.fn() }))

import { RemoteDesktopError } from "@/lib/remote-desktop/host-client"
import type { RemoteDesktopBinding, RemoteDesktopTarget } from "@/lib/remote-desktop/types"

import { RemoteConsoleView, type RemoteConsoleWebviewApi } from "./remote-console-view"

const binding: RemoteDesktopBinding = {
  id: "gw",
  providerId: "cognia-remote-desktop-web-console.guacamole",
  access: "web-console",
  adapter: "none",
  priority: 0,
  enabled: true,
  endpoint: { host: "gw.lan", port: 443, pinnedIp: "10.0.0.5", class: "private", confirmedAt: 1 },
  console: { url: "https://gw.lan/#/client/x", profile: "guacamole" },
  viewOnly: false,
  config: null,
  hasControlCredential: false,
  hasViewCredential: false,
}

const target: RemoteDesktopTarget = {
  id: "t",
  name: "Office",
  bindings: [binding],
  createdAt: 1,
  updatedAt: 1,
}

function webview(): jest.Mocked<RemoteConsoleWebviewApi> {
  return {
    open: jest.fn().mockResolvedValue(undefined),
    setBounds: jest.fn().mockResolvedValue(undefined),
    setVisible: jest.fn().mockResolvedValue(undefined),
    reload: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  }
}

beforeEach(() => push.mockReset())

describe("RemoteConsoleView", () => {
  it("asks the Host where to go, embeds the console and closes it on leave", async () => {
    const api = webview()
    const launch = jest.fn().mockResolvedValue({
      kind: "web-console",
      url: "https://gw.lan/#/client/x",
      profile: "guacamole",
    })
    const { unmount } = render(
      <RemoteConsoleView
        host={{ kind: "remote", hostRef: "companion:h" }}
        hostLabel="Studio Mac"
        target={target}
        binding={binding}
        launch={launch}
        webview={api}
      />
    )
    expect(await screen.findByText("Console open")).toBeInTheDocument()
    expect(launch).toHaveBeenCalledWith(
      { kind: "remote", hostRef: "companion:h" },
      { targetId: "t", bindingId: "gw" }
    )
    expect(api.open).toHaveBeenCalledWith("https://gw.lan/#/client/x", expect.any(Object))
    expect(screen.getByText("Permissions managed by the provider")).toBeInTheDocument()
    expect(screen.getByText("Through Studio Mac")).toBeInTheDocument()
    expect(screen.getByText("gw.lan")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Reload" }))
    expect(api.reload).toHaveBeenCalled()
    // A hidden window parks the native layer, and showing it again restores it.
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true })
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await waitFor(() => expect(api.setVisible).toHaveBeenLastCalledWith(false, expect.any(Object)))
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true })
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await waitFor(() => expect(api.setVisible).toHaveBeenLastCalledWith(true, expect.any(Object)))
    await userEvent.click(screen.getByRole("button", { name: "Close" }))
    expect(push).toHaveBeenCalledWith("/devices")
    unmount()
    expect(api.close).toHaveBeenCalled()
  })

  it("shows a Host refusal and never opens the webview", async () => {
    const api = webview()
    const launch = jest
      .fn()
      .mockRejectedValue(new RemoteDesktopError("remote_desktop_endpoint_changed"))
    render(
      <RemoteConsoleView
        host={{ kind: "local" }}
        target={target}
        binding={binding}
        launch={launch}
        webview={api}
      />
    )
    expect(await screen.findByText(/now resolves to a different address/)).toBeInTheDocument()
    expect(screen.getByText("Could not open the console")).toBeInTheDocument()
    expect(api.open).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Reload" })).toBeDisabled()
  })

  it("closes a console that finished opening after the page went away", async () => {
    const api = webview()
    let finish: () => void = () => undefined
    api.open.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      })
    )
    const launch = jest.fn().mockResolvedValue({
      kind: "web-console",
      url: "https://gw.lan/#/client/x",
      profile: "guacamole",
    })
    const { unmount } = render(
      <RemoteConsoleView
        host={{ kind: "local" }}
        target={target}
        binding={binding}
        launch={launch}
        webview={api}
      />
    )
    await waitFor(() => expect(api.open).toHaveBeenCalled())
    unmount()
    await act(async () => {
      finish()
    })
    expect(api.close).toHaveBeenCalledTimes(2)
  })
})
