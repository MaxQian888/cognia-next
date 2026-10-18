import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const toastSuccess = jest.fn()
const toastWarning = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    warning: (...args: unknown[]) => toastWarning(...args),
    error: jest.fn(),
  },
}))
jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn() } }))

import { RemoteDesktopError } from "@/lib/remote-desktop/host-client"
import type { RemoteDesktopProviderRegistration } from "@/lib/remote-desktop/provider-registry"
import { LOCAL_REMOTE_DESKTOP_HOST, type RemoteDesktopTarget } from "@/lib/remote-desktop/types"

import { RemoteDesktopTargetDialog } from "./remote-desktop-target-dialog"

const vnc: RemoteDesktopProviderRegistration = {
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
}

const guacamole: RemoteDesktopProviderRegistration = {
  providerId: "cognia-remote-desktop-web-console.guacamole",
  pluginId: "cognia-remote-desktop-web-console",
  firstParty: true,
  definition: {
    id: "guacamole",
    name: "Guacamole",
    integrationMode: "web-console",
    consoleProfile: "guacamole",
    linkExample: "https://gateway.example.com/guacamole/#/client/…",
  },
}

const rustdesk: RemoteDesktopProviderRegistration = {
  providerId: "cognia-remote-desktop-rustdesk.rustdesk",
  pluginId: "cognia-remote-desktop-rustdesk",
  firstParty: true,
  definition: {
    id: "rustdesk",
    name: "RustDesk",
    integrationMode: "external-app",
    launcher: "rustdesk",
  },
}

const saved: RemoteDesktopTarget = {
  id: "t1",
  name: "Studio",
  bindings: [
    {
      id: "b1",
      providerId: vnc.providerId,
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
      viewOnly: false,
      config: null,
      hasControlCredential: true,
      hasViewCredential: false,
    },
  ],
  createdAt: 1,
  updatedAt: 1,
}

beforeEach(() => {
  toastSuccess.mockReset()
  toastWarning.mockReset()
})

describe("RemoteDesktopTargetDialog", () => {
  it("resolves, confirms, tests and saves a new target with its passwords", async () => {
    const probe = jest
      .fn()
      .mockResolvedValueOnce({ pinnedIp: "192.168.1.20", class: "private", connected: false })
      .mockResolvedValueOnce({
        pinnedIp: "192.168.1.20",
        class: "private",
        connected: true,
        rfb: {
          protocolVersion: "3.8",
          securityTypes: [2],
          supported: true,
          requiresPassword: true,
        },
      })
    const onSave = jest.fn().mockResolvedValue({ target: saved })
    const onClose = jest.fn()
    render(
      <RemoteDesktopTargetDialog
        host={LOCAL_REMOTE_DESKTOP_HOST}
        state={{ kind: "add" }}
        providers={[vnc]}
        onClose={onClose}
        onSave={onSave}
        probe={probe}
      />
    )
    const save = screen.getByRole("button", { name: "Save" })
    await userEvent.type(screen.getByLabelText("Name"), "Studio")
    await userEvent.type(screen.getByLabelText("Host or IP address"), "nas.local")
    expect(save).toBeDisabled()
    await userEvent.click(screen.getByRole("button", { name: "Check address" }))
    expect(probe).toHaveBeenNthCalledWith(1, LOCAL_REMOTE_DESKTOP_HOST, {
      kind: "draft",
      host: "nas.local",
      port: 5900,
      adapter: "vnc",
    })
    expect(
      await screen.findByText(/device on your local network \(192\.168\.1\.20\)/)
    ).toBeInTheDocument()
    // Testing connects, so it waits for the confirmation.
    expect(screen.getByRole("button", { name: "Test connection" })).toBeDisabled()
    await userEvent.click(screen.getByRole("checkbox"))
    await userEvent.click(screen.getByRole("button", { name: "Test connection" }))
    expect(probe).toHaveBeenNthCalledWith(2, LOCAL_REMOTE_DESKTOP_HOST, {
      kind: "draft",
      host: "nas.local",
      port: 5900,
      adapter: "vnc",
      confirm: true,
    })
    expect(await screen.findByText("3.8, security types 2")).toBeInTheDocument()
    expect(screen.getByText("The server requires a VNC password.")).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText("Password"), "hunter2")
    await userEvent.click(screen.getByRole("switch", { name: /separate view-only password/ }))
    await userEvent.type(screen.getByLabelText("View-only password"), "peek")
    await userEvent.click(save)
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const input = onSave.mock.calls[0][0]
    expect(input.draft).toEqual({
      name: "Studio",
      bindings: [
        {
          providerId: vnc.providerId,
          access: "bridge",
          adapter: "vnc",
          enabled: true,
          host: "nas.local",
          port: 5900,
          viewOnly: true,
          confirm: true,
        },
      ],
    })
    expect(input.control).toBe("hunter2")
    expect(input.view).toBe("peek")
    expect(input.bindingOf(saved)?.id).toBe("b1")
    expect(toastSuccess).toHaveBeenCalledWith("Remote desktop saved")
    expect(onClose).toHaveBeenCalled()
  })

  it("names unsupported security types and the internet risk", async () => {
    const probe = jest
      .fn()
      .mockResolvedValueOnce({ pinnedIp: "203.0.113.9", class: "public", connected: false })
      .mockResolvedValueOnce({
        pinnedIp: "203.0.113.9",
        class: "public",
        connected: true,
        rfb: {
          protocolVersion: "3.8",
          securityTypes: [18, 19],
          supported: false,
          requiresPassword: false,
        },
      })
    render(
      <RemoteDesktopTargetDialog
        host={LOCAL_REMOTE_DESKTOP_HOST}
        state={{ kind: "add" }}
        providers={[vnc]}
        onClose={jest.fn()}
        onSave={jest.fn()}
        probe={probe}
      />
    )
    await userEvent.type(screen.getByLabelText("Host or IP address"), "vnc.example.com")
    await userEvent.click(screen.getByRole("button", { name: "Check address" }))
    expect(await screen.findByText(/VNC traffic is not encrypted/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("checkbox"))
    await userEvent.click(screen.getByRole("button", { name: "Test connection" }))
    expect(
      await screen.findByText(
        "This server offers security types 18, 19. Cognia supports None (1) and VNC password (2) only."
      )
    ).toBeInTheDocument()
  })

  it("edits an unchanged endpoint without re-confirming, and can remove a password", async () => {
    const onSave = jest.fn().mockResolvedValue({ target: saved })
    const probe = jest
      .fn()
      .mockResolvedValue({ pinnedIp: "192.168.1.20", class: "private", connected: true })
    render(
      <RemoteDesktopTargetDialog
        host={LOCAL_REMOTE_DESKTOP_HOST}
        state={{ kind: "edit", target: saved, bindingId: "b1" }}
        providers={[vnc]}
        onClose={jest.fn()}
        onSave={onSave}
        probe={probe}
      />
    )
    expect(screen.queryByRole("button", { name: "Check address" })).not.toBeInTheDocument()
    expect(screen.getByLabelText("Password (optional)")).toHaveAttribute(
      "placeholder",
      "Leave blank to keep the stored password"
    )
    await userEvent.click(screen.getByRole("button", { name: "Test connection" }))
    expect(probe).toHaveBeenCalledWith(LOCAL_REMOTE_DESKTOP_HOST, {
      kind: "saved",
      targetId: "t1",
      bindingId: "b1",
    })
    await userEvent.click(screen.getByRole("button", { name: "Remove stored password" }))
    expect(screen.getByText("Will be removed on save")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const input = onSave.mock.calls[0][0]
    expect(input.draft.id).toBe("t1")
    expect(input.draft.bindings[0]).toMatchObject({ id: "b1", confirm: false })
    expect(input.control).toBeNull()
    expect(input.view).toBeUndefined()
  })

  it("asks to check again when the name moved before saving", async () => {
    const onSave = jest
      .fn()
      .mockRejectedValue(new Error("remote_desktop_endpoint_unconfirmed: private"))
    render(
      <RemoteDesktopTargetDialog
        host={LOCAL_REMOTE_DESKTOP_HOST}
        state={{ kind: "edit", target: saved, bindingId: "b1" }}
        providers={[vnc]}
        onClose={jest.fn()}
        onSave={onSave}
      />
    )
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(
      await screen.findByText("The address changed. Check it again before saving.")
    ).toBeInTheDocument()
  })

  it("warns when the target saved but a password did not", async () => {
    const onSave = jest.fn().mockResolvedValue({
      target: saved,
      credentialError: new RemoteDesktopError("remote_desktop_credential_unavailable"),
    })
    render(
      <RemoteDesktopTargetDialog
        host={LOCAL_REMOTE_DESKTOP_HOST}
        state={{ kind: "edit", target: saved, bindingId: "b1" }}
        providers={[vnc]}
        onClose={jest.fn()}
        onSave={onSave}
      />
    )
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(toastWarning).toHaveBeenCalledWith(
        "Saved, but the password could not be stored: This desktop's secret store is unavailable."
      )
    )
  })

  it("says how to get a provider when none is enabled", () => {
    render(
      <RemoteDesktopTargetDialog
        host={LOCAL_REMOTE_DESKTOP_HOST}
        state={{ kind: "add" }}
        providers={[]}
        onClose={jest.fn()}
        onSave={jest.fn()}
      />
    )
    expect(
      screen.getByText(/Enable the VNC, web console or RustDesk provider plugin/)
    ).toBeInTheDocument()
  })
  it("says a paired Host resolves and reaches the address", async () => {
    const host = { kind: "remote" as const, hostRef: "h1" }
    const probe = jest
      .fn()
      .mockResolvedValue({ pinnedIp: "192.168.1.20", class: "private", connected: false })
    render(
      <RemoteDesktopTargetDialog
        host={host}
        hostLabel="Studio Mac"
        state={{ kind: "add" }}
        providers={[vnc]}
        onClose={jest.fn()}
        onSave={jest.fn()}
        probe={probe}
      />
    )
    await userEvent.type(screen.getByLabelText("Host or IP address"), "nas.local")
    await userEvent.click(screen.getByRole("button", { name: "Check address" }))
    expect(probe).toHaveBeenCalledWith(host, expect.objectContaining({ host: "nas.local" }))
    expect(
      await screen.findByText(/device on Studio Mac's local network \(192\.168\.1\.20\)/)
    ).toBeInTheDocument()
  })

  it("checks a web console's link, confirms its host and saves no password", async () => {
    const probe = jest
      .fn()
      .mockResolvedValueOnce({ pinnedIp: "203.0.113.4", class: "public", connected: false })
    const onSave = jest.fn().mockResolvedValue({ target: saved })
    render(
      <RemoteDesktopTargetDialog
        host={LOCAL_REMOTE_DESKTOP_HOST}
        state={{ kind: "add" }}
        providers={[guacamole, vnc]}
        onClose={jest.fn()}
        onSave={onSave}
        probe={probe}
      />
    )
    expect(screen.queryByLabelText("Host or IP address")).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Password/)).not.toBeInTheDocument()
    expect(screen.getByText(/signs you in and decides what you may do/)).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText("Name"), "Office")
    const link = screen.getByLabelText("Console link")
    await userEvent.type(link, "https://gw.example.com/guacamole/")
    expect(screen.getByText(/isn't a link this console opens a machine with/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Check address" })).toBeDisabled()
    await userEvent.clear(link)
    await userEvent.type(link, "https://gw.example.com:8443/guacamole/#/client/abc")
    await userEvent.click(screen.getByRole("button", { name: "Check address" }))
    expect(probe).toHaveBeenCalledWith(LOCAL_REMOTE_DESKTOP_HOST, {
      kind: "draft",
      host: "gw.example.com",
      port: 8443,
      adapter: "none",
    })
    expect(
      await screen.findByText(/console is on the internet \(203\.0\.113\.4\)/)
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole("checkbox"))
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const input = onSave.mock.calls[0][0]
    expect(input.draft.bindings[0]).toEqual({
      providerId: guacamole.providerId,
      access: "web-console",
      adapter: "none",
      enabled: true,
      viewOnly: false,
      confirm: true,
      console: { url: "https://gw.example.com:8443/guacamole/#/client/abc", profile: "guacamole" },
    })
    expect(input.control).toBeUndefined()
    expect(input.view).toBeUndefined()
  })

  it("saves a RustDesk ID with its server and key and nothing to check", async () => {
    const probe = jest.fn()
    const onSave = jest.fn().mockResolvedValue({ target: saved })
    render(
      <RemoteDesktopTargetDialog
        host={LOCAL_REMOTE_DESKTOP_HOST}
        state={{ kind: "add" }}
        providers={[rustdesk]}
        onClose={jest.fn()}
        onSave={onSave}
        probe={probe}
      />
    )
    expect(screen.queryByRole("button", { name: "Check address" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Test connection" })).not.toBeInTheDocument()
    const save = screen.getByRole("button", { name: "Save" })
    await userEvent.type(screen.getByLabelText("Name"), "Mum's PC")
    expect(save).toBeDisabled()
    await userEvent.type(screen.getByLabelText("RustDesk ID"), "123 456 789")
    await userEvent.type(screen.getByLabelText("ID server (optional)"), "rd.example.com:21116")
    await userEvent.type(screen.getByLabelText("Server key (optional)"), "Ab+/=")
    await userEvent.click(save)
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0][0].draft.bindings[0]).toEqual({
      providerId: rustdesk.providerId,
      access: "external-app",
      adapter: "none",
      enabled: true,
      viewOnly: false,
      confirm: false,
      launch: {
        launcher: "rustdesk",
        peerId: "123456789",
        server: "rd.example.com:21116",
        key: "Ab+/=",
      },
    })
    expect(probe).not.toHaveBeenCalled()
  })
})
