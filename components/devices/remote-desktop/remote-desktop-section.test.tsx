import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))
const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
    warning: jest.fn(),
  },
}))
jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn() } }))

import {
  __resetRemoteDesktopProvidersForTests,
  registerRemoteDesktopProvider,
} from "@/lib/remote-desktop/provider-registry"
import {
  LOCAL_REMOTE_DESKTOP_HOST,
  type RemoteDesktopBinding,
  type RemoteDesktopTarget,
} from "@/lib/remote-desktop/types"

import { RemoteDesktopSection } from "./remote-desktop-section"

function binding(overrides: Partial<RemoteDesktopBinding> = {}): RemoteDesktopBinding {
  return {
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
    ...overrides,
  }
}

function target(overrides: Partial<RemoteDesktopTarget> = {}): RemoteDesktopTarget {
  return {
    id: "t1",
    name: "Studio",
    bindings: [binding()],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function registerVnc() {
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
      viewer: { kind: "react", component: () => null },
    },
  })
}

const LOCAL = LOCAL_REMOTE_DESKTOP_HOST

beforeEach(() => {
  push.mockReset()
  toastSuccess.mockReset()
  toastError.mockReset()
})
afterEach(() => __resetRemoteDesktopProvidersForTests())

describe("RemoteDesktopSection", () => {
  it("explains an empty list and offers to add one", async () => {
    registerVnc()
    render(<RemoteDesktopSection host={LOCAL} deps={{ list: async () => [] }} />)
    expect(await screen.findByText("No remote desktops yet")).toBeInTheDocument()
    expect(screen.getByText(/bypasses Cognia/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: /Add remote desktop/ }))
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
  })

  it("lists a target's facts and opens it in either mode", async () => {
    registerVnc()
    render(<RemoteDesktopSection host={LOCAL} deps={{ list: async () => [target()] }} />)
    expect(await screen.findByText("Studio")).toBeInTheDocument()
    expect(screen.getByText("nas.local:5900")).toHaveAttribute("title", "Pinned to 192.168.1.20")
    expect(screen.getByText("LAN")).toBeInTheDocument()
    expect(screen.getByText("View-only password")).toBeInTheDocument()
    expect(screen.getByText("Password stored")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "View only" }))
    expect(push).toHaveBeenLastCalledWith("/devices/remote-desktop?target=t1&binding=b1&mode=view")
    await userEvent.click(screen.getByRole("button", { name: /^Open$/ }))
    expect(push).toHaveBeenLastCalledWith(
      "/devices/remote-desktop?target=t1&binding=b1&mode=control"
    )
  })

  it("never offers view-only without a server-enforced view password", async () => {
    registerVnc()
    render(
      <RemoteDesktopSection
        host={LOCAL}
        deps={{
          list: async () => [
            target({
              bindings: [
                binding({
                  viewOnly: false,
                  hasViewCredential: false,
                  endpoint: {
                    host: "8.8.8.8",
                    port: 5900,
                    pinnedIp: "8.8.8.8",
                    class: "public",
                    confirmedAt: 1,
                  },
                }),
              ],
            }),
          ],
        }}
      />
    )
    expect(
      await screen.findByText("Full control only (cannot be made read-only)")
    ).toBeInTheDocument()
    expect(screen.getByText("Internet, unencrypted")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "View only" })).not.toBeInTheDocument()
  })

  it("disables opening when the provider is not installed", async () => {
    render(<RemoteDesktopSection host={LOCAL} deps={{ list: async () => [target()] }} />)
    expect(await screen.findByText("Provider not installed")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^Open$/ })).toBeDisabled()
  })

  it("deletes after confirmation", async () => {
    registerVnc()
    const remove = jest.fn().mockResolvedValue(undefined)
    const list = jest.fn().mockResolvedValueOnce([target()]).mockResolvedValue([])
    render(<RemoteDesktopSection host={LOCAL} deps={{ list, remove }} />)
    await userEvent.click(await screen.findByRole("button", { name: /Delete/ }))
    expect(await screen.findByText("Delete Studio?")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Delete" }))
    await waitFor(() => expect(remove).toHaveBeenCalledWith(LOCAL, "t1"))
    expect(toastSuccess).toHaveBeenCalledWith("Remote desktop deleted")
  })

  it("maps a Host refusal and retries", async () => {
    const list = jest
      .fn()
      .mockRejectedValueOnce(new Error("remote_desktop_storage_version"))
      .mockResolvedValue([])
    render(<RemoteDesktopSection host={LOCAL} deps={{ list }} />)
    expect(
      await screen.findByText("The remote desktop list was written by a newer version of Cognia.")
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(await screen.findByText("No remote desktops yet")).toBeInTheDocument()
  })
  it("lists a paired Host's targets with its name and opens them through that Host", async () => {
    registerVnc()
    const list = jest.fn().mockResolvedValue([])
    const host = { kind: "remote" as const, hostRef: "h1" }
    const { unmount } = render(
      <RemoteDesktopSection host={host} hostLabel="Studio Mac" deps={{ list }} />
    )
    expect(
      await screen.findByText(/Add a VNC server that Studio Mac can reach/)
    ).toBeInTheDocument()
    expect(list).toHaveBeenCalledWith(host)
    unmount()
    render(
      <RemoteDesktopSection
        host={host}
        hostLabel="Studio Mac"
        deps={{ list: async () => [target()] }}
      />
    )
    await userEvent.click(await screen.findByRole("button", { name: /^Open$/ }))
    expect(push).toHaveBeenLastCalledWith(
      "/devices/remote-desktop?target=t1&binding=b1&mode=control&host=h1"
    )
  })

  it("says the Host must be updated when it does not know the commands", async () => {
    registerVnc()
    render(
      <RemoteDesktopSection
        host={{ kind: "remote", hostRef: "h1" }}
        hostLabel="Studio Mac"
        deps={{ list: jest.fn().mockRejectedValue(new Error("remote_desktop_host_outdated")) }}
      />
    )
    expect(
      await screen.findByText(
        "Studio Mac cannot broker remote desktops yet. Update it to open them from here."
      )
    ).toBeInTheDocument()
  })

  it("opens web consoles and RustDesk as provider-managed bindings", async () => {
    registerRemoteDesktopProvider({
      providerId: "cognia-remote-desktop-web-console.guacamole",
      pluginId: "cognia-remote-desktop-web-console",
      firstParty: true,
      definition: {
        id: "guacamole",
        name: "Guacamole",
        integrationMode: "web-console",
        consoleProfile: "guacamole",
      },
    })
    registerRemoteDesktopProvider({
      providerId: "cognia-remote-desktop-rustdesk.rustdesk",
      pluginId: "cognia-remote-desktop-rustdesk",
      firstParty: true,
      definition: {
        id: "rustdesk",
        name: "RustDesk",
        integrationMode: "external-app",
        launcher: "rustdesk",
      },
    })
    const office = target({
      bindings: [
        binding({
          id: "gw",
          providerId: "cognia-remote-desktop-web-console.guacamole",
          access: "web-console",
          adapter: "none",
          viewOnly: false,
          hasControlCredential: false,
          hasViewCredential: false,
          console: { url: "https://gw.lan/#/client/x", profile: "guacamole" },
          endpoint: {
            host: "gw.lan",
            port: 443,
            pinnedIp: "10.0.0.5",
            class: "private",
            confirmedAt: 1,
          },
        }),
        binding({
          id: "rd",
          providerId: "cognia-remote-desktop-rustdesk.rustdesk",
          access: "external-app",
          adapter: "none",
          viewOnly: false,
          hasControlCredential: false,
          hasViewCredential: false,
          endpoint: null,
          launch: { launcher: "rustdesk", peerId: "123456789", server: "rd.lan" },
        }),
      ],
    })
    const launch = jest.fn().mockResolvedValue({
      kind: "external-app",
      launcher: "rustdesk",
      uri: "rustdesk://connection/new/123456789@rd.lan",
    })
    const openAppOnDesktop = jest.fn().mockResolvedValue(undefined)
    render(
      <RemoteDesktopSection
        host={LOCAL}
        deps={{ list: async () => [office] }}
        launchDeps={{ kind: "desktop", launch, openAppOnDesktop }}
      />
    )
    expect(await screen.findByText("gw.lan")).toBeInTheDocument()
    expect(screen.getByText("123456789 on rd.lan")).toBeInTheDocument()
    expect(screen.getAllByText("Permissions managed by the provider")).toHaveLength(2)
    expect(screen.queryByText("View-only password")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Open console" }))
    expect(push).toHaveBeenLastCalledWith(
      "/devices/remote-desktop?target=t1&binding=gw&mode=control"
    )
    await userEvent.click(screen.getByRole("button", { name: "Open in RustDesk" }))
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        "RustDesk was asked to connect. Cognia cannot tell whether it did."
      )
    )
    expect(openAppOnDesktop).toHaveBeenCalledWith("rustdesk://connection/new/123456789@rd.lan")
  })

  it("explains why a viewer cannot open what the Host withheld", async () => {
    registerRemoteDesktopProvider({
      providerId: "cognia-remote-desktop-rustdesk.rustdesk",
      pluginId: "cognia-remote-desktop-rustdesk",
      firstParty: true,
      definition: {
        id: "rustdesk",
        name: "RustDesk",
        integrationMode: "external-app",
        launcher: "rustdesk",
      },
    })
    const withheld = target({
      bindings: [
        binding({
          providerId: "cognia-remote-desktop-rustdesk.rustdesk",
          access: "external-app",
          adapter: "none",
          endpoint: null,
          launch: { launcher: "rustdesk" },
        }),
      ],
    })
    render(<RemoteDesktopSection host={LOCAL} deps={{ list: async () => [withheld] }} />)
    const open = await screen.findByRole("button", { name: "Open in RustDesk" })
    expect(open).toBeDisabled()
    expect(open).toHaveAttribute("title", expect.stringMatching(/needs control of the Host/))
  })
})
