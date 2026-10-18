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
import type { RemoteDesktopTarget } from "@/lib/remote-desktop/types"

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
    expect(probe).toHaveBeenNthCalledWith(1, {
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
    expect(probe).toHaveBeenNthCalledWith(2, {
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
    expect(probe).toHaveBeenCalledWith({ kind: "saved", targetId: "t1", bindingId: "b1" })
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
        state={{ kind: "add" }}
        providers={[]}
        onClose={jest.fn()}
        onSave={jest.fn()}
      />
    )
    expect(screen.getByText(/Enable the VNC provider plugin/)).toBeInTheDocument()
  })
})
