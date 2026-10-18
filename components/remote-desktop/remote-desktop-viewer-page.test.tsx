import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

let search = new URLSearchParams("target=t1&binding=b1&mode=control")
jest.mock("next/navigation", () => ({ useSearchParams: () => search }))
let tauri = true
jest.mock("@/lib/tauri", () => ({ isTauri: () => tauri, transport: { call: jest.fn() } }))

import {
  __resetRemoteDesktopProvidersForTests,
  registerRemoteDesktopProvider,
  type RemoteDesktopViewerProps,
} from "@/lib/remote-desktop/provider-registry"
import type { RemoteDesktopTarget } from "@/lib/remote-desktop/types"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"

import { RemoteDesktopViewerPage } from "./remote-desktop-viewer-page"

const viewerSpy = jest.fn<void, [RemoteDesktopViewerProps]>()
function FakeViewer(props: RemoteDesktopViewerProps) {
  viewerSpy(props)
  return (
    <div data-testid="fake-viewer">
      {typeof props.connection === "string" ? props.connection : "channel"}
    </div>
  )
}
const viewerProps = () => viewerSpy.mock.calls.at(-1)?.[0]

const target: RemoteDesktopTarget = {
  id: "t1",
  name: "Studio",
  bindings: [
    {
      id: "b1",
      providerId: "cognia-remote-desktop-vnc.vnc",
      adapter: "vnc",
      priority: 0,
      enabled: true,
      endpoint: {
        host: "nas.local",
        port: 5900,
        pinnedIp: "192.168.1.20",
        class: "private",
        confirmedAt: 1,
      },
      viewOnly: true,
      config: null,
      hasControlCredential: true,
      hasViewCredential: true,
    },
  ],
  createdAt: 1,
  updatedAt: 1,
}

function session(sessionId: string, mode: "view" | "control") {
  return {
    sessionId,
    transport: "loopback" as const,
    url: `ws://127.0.0.1:1/rd/${sessionId}`,
    mode,
    expiresAt: 1,
  }
}

beforeEach(() => {
  search = new URLSearchParams("target=t1&binding=b1&mode=control")
  tauri = true
  viewerSpy.mockClear()
  registerRemoteDesktopProvider({
    providerId: "cognia-remote-desktop-vnc.vnc",
    pluginId: "cognia-remote-desktop-vnc",
    firstParty: true,
    definition: {
      id: "vnc",
      name: "VNC",
      integrationMode: "embedded",
      adapter: "vnc",
      defaultPort: 5900,
      capabilities: { viewOnlyPassword: true },
      viewer: { kind: "react", component: FakeViewer },
    },
  })
})
afterEach(() => __resetRemoteDesktopProvidersForTests())

const list = async () => [target]

describe("RemoteDesktopViewerPage", () => {
  it("opens a control session and hands the viewer its URL", async () => {
    const open = jest.fn().mockResolvedValue(session("s1", "control"))
    render(
      <RemoteDesktopViewerPage
        targetsDeps={{ list }}
        sessionDeps={{ open, renew: jest.fn(), close: jest.fn().mockResolvedValue(undefined) }}
      />
    )
    expect(await screen.findByTestId("fake-viewer")).toHaveTextContent("ws://127.0.0.1:1/rd/s1")
    expect(open).toHaveBeenCalledWith(
      { kind: "local" },
      { targetId: "t1", bindingId: "b1", mode: "control", takeover: false }
    )
    expect(screen.getByText("In control")).toBeInTheDocument()
    act(() => viewerProps()?.onStatus("connected"))
    expect(screen.getByRole("status")).toHaveTextContent("Connected")
  })

  it("asks before taking over, and can fall back to view only", async () => {
    const open = jest
      .fn()
      .mockRejectedValueOnce(new Error("remote_desktop_control_busy"))
      .mockResolvedValueOnce(session("s2", "view"))
      .mockResolvedValueOnce(session("s3", "control"))
    const close = jest.fn().mockResolvedValue(undefined)
    render(
      <RemoteDesktopViewerPage
        targetsDeps={{ list }}
        sessionDeps={{ open, renew: jest.fn(), close }}
      />
    )
    expect(await screen.findByText("Someone else is in control. Take over?")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "View only" }))
    expect(await screen.findByText("Viewing")).toBeInTheDocument()
    expect(screen.getByText(/The server enforces view-only/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Take control" }))
    await waitFor(() =>
      expect(open).toHaveBeenLastCalledWith(
        { kind: "local" },
        expect.objectContaining({ mode: "control" })
      )
    )
    expect(close).toHaveBeenCalledWith({ kind: "local" }, "s2")
  })

  it("states why a session ended and reconnects", async () => {
    const open = jest
      .fn()
      .mockResolvedValueOnce(session("s1", "control"))
      .mockResolvedValueOnce(session("s4", "control"))
    render(
      <RemoteDesktopViewerPage
        targetsDeps={{ list }}
        sessionDeps={{ open, renew: jest.fn(), close: jest.fn().mockResolvedValue(undefined) }}
      />
    )
    await screen.findByTestId("fake-viewer")
    act(() => viewerProps()?.onError("remote_desktop_auth_failed"))
    expect(await screen.findByText(/The server rejected the password/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: /Reconnect/ }))
    expect(await screen.findByTestId("fake-viewer")).toHaveTextContent("s4")
  })

  it("opens a paired Host's target off the desktop and hands the viewer its channel", async () => {
    tauri = false
    search = new URLSearchParams("target=t1&binding=b1&mode=control&host=h1")
    useRemoteHostStore.setState({
      hosts: [{ id: "h1", label: "Studio Mac" } as never],
    })
    const listOn = jest.fn().mockResolvedValue([target])
    const channel = { readyState: "open" } as never
    const openStream = jest.fn().mockResolvedValue({ connection: channel, close: jest.fn() })
    const open = jest.fn().mockResolvedValue({
      sessionId: "s9",
      transport: "companion",
      mode: "control",
      expiresAt: 1,
    })
    render(
      <RemoteDesktopViewerPage
        targetsDeps={{ list: listOn }}
        sessionDeps={{
          open,
          openStream,
          renew: jest.fn(),
          close: jest.fn().mockResolvedValue(undefined),
        }}
      />
    )
    expect(await screen.findByTestId("fake-viewer")).toHaveTextContent("channel")
    expect(listOn).toHaveBeenCalledWith({ kind: "remote", hostRef: "h1" })
    expect(open).toHaveBeenCalledWith(
      { kind: "remote", hostRef: "h1" },
      expect.objectContaining({ targetId: "t1", bindingId: "b1" })
    )
    expect(viewerProps()?.connection).toBe(channel)
    expect(screen.getByText("Through Studio Mac")).toBeInTheDocument()
    useRemoteHostStore.setState({ hosts: [] })
  })

  it("explains each reason it cannot open", async () => {
    tauri = false
    const { unmount } = render(<RemoteDesktopViewerPage targetsDeps={{ list }} />)
    expect(
      screen.getByText(
        "This link names a remote desktop on a desktop's own Host. Open it from that Host in Devices."
      )
    ).toBeInTheDocument()
    unmount()
    tauri = true
    search = new URLSearchParams("")
    const second = render(<RemoteDesktopViewerPage targetsDeps={{ list }} />)
    expect(screen.getByText("This link does not name a remote desktop.")).toBeInTheDocument()
    second.unmount()
    search = new URLSearchParams("target=gone&binding=b1")
    const third = render(<RemoteDesktopViewerPage targetsDeps={{ list }} />)
    expect(await screen.findByText("This remote desktop no longer exists.")).toBeInTheDocument()
    third.unmount()
    __resetRemoteDesktopProvidersForTests()
    search = new URLSearchParams("target=t1&binding=b1")
    render(<RemoteDesktopViewerPage targetsDeps={{ list }} />)
    expect(
      await screen.findByText("The provider for this remote desktop is not installed or enabled.")
    ).toBeInTheDocument()
  })
})
