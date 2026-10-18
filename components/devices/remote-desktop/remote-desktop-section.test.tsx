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
import type { RemoteDesktopBinding, RemoteDesktopTarget } from "@/lib/remote-desktop/types"

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

beforeEach(() => {
  push.mockReset()
  toastSuccess.mockReset()
  toastError.mockReset()
})
afterEach(() => __resetRemoteDesktopProvidersForTests())

describe("RemoteDesktopSection", () => {
  it("explains an empty list and offers to add one", async () => {
    registerVnc()
    render(<RemoteDesktopSection deps={{ list: async () => [] }} />)
    expect(await screen.findByText("No remote desktops yet")).toBeInTheDocument()
    expect(screen.getByText(/bypasses Cognia/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: /Add remote desktop/ }))
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
  })

  it("lists a target's facts and opens it in either mode", async () => {
    registerVnc()
    render(<RemoteDesktopSection deps={{ list: async () => [target()] }} />)
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
    render(<RemoteDesktopSection deps={{ list: async () => [target()] }} />)
    expect(await screen.findByText("Provider not installed")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^Open$/ })).toBeDisabled()
  })

  it("deletes after confirmation", async () => {
    registerVnc()
    const remove = jest.fn().mockResolvedValue(undefined)
    const list = jest.fn().mockResolvedValueOnce([target()]).mockResolvedValue([])
    render(<RemoteDesktopSection deps={{ list, remove }} />)
    await userEvent.click(await screen.findByRole("button", { name: /Delete/ }))
    expect(await screen.findByText("Delete Studio?")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Delete" }))
    await waitFor(() => expect(remove).toHaveBeenCalledWith("t1"))
    expect(toastSuccess).toHaveBeenCalledWith("Remote desktop deleted")
  })

  it("maps a Host refusal and retries", async () => {
    const list = jest
      .fn()
      .mockRejectedValueOnce(new Error("remote_desktop_storage_version"))
      .mockResolvedValue([])
    render(<RemoteDesktopSection deps={{ list }} />)
    expect(
      await screen.findByText("The remote desktop list was written by a newer version of Cognia.")
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(await screen.findByText("No remote desktops yet")).toBeInTheDocument()
  })
})
