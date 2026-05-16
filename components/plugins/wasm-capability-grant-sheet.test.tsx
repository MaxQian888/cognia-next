/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { render, screen, fireEvent } from "@testing-library/react"
import { WasmCapabilityGrantSheet } from "./wasm-capability-grant-sheet"
import type { PluginManifest } from "@/types/plugin"

const baseManifest: PluginManifest = {
  id: "demo.wasm",
  name: "Demo WASM Plugin",
  version: "0.1.0",
  description: "A test plugin",
  type: "wasm",
  capabilities: [],
  wasmMain: "main.wasm",
  wasm: { apiVersion: "0.1.0" },
  permissions: ["notification", "filesystem:read", "process:spawn"],
  optionalPermissions: ["clipboard:write"],
  author: { name: "Alice", publicKey: "QUJD" }, // base64("ABC")
}

describe("WasmCapabilityGrantSheet", () => {
  it("renders requested permissions grouped by category", () => {
    render(
      <WasmCapabilityGrantSheet
        manifest={baseManifest}
        authorFingerprint="ed25519:9f:3a:11:22:33:44:55:66"
        open
        onOpenChange={() => {}}
        onConfirm={() => {}}
      />
    )
    expect(screen.getByText('title:{"name":"Demo WASM Plugin"}')).toBeInTheDocument()
    expect(screen.getByText("groups.notifications")).toBeInTheDocument()
    expect(screen.getByText("groups.filesystem")).toBeInTheDocument()
    expect(screen.getByText("groups.osProcess")).toBeInTheDocument()
    expect(screen.getByText("optionalPermissions")).toBeInTheDocument()
    expect(screen.getByText("ed25519:9f:3a:11:22:33:44:55:66")).toBeInTheDocument()
  })

  it("starts with required perms checked and optional unchecked", () => {
    render(
      <WasmCapabilityGrantSheet
        manifest={baseManifest}
        authorFingerprint=""
        open
        onOpenChange={() => {}}
        onConfirm={() => {}}
      />
    )
    const reqCheckbox = screen.getByRole("checkbox", {
      name: 'togglePermissionAriaLabel:{"permission":"notification"}',
    })
    expect(reqCheckbox).toHaveAttribute("data-state", "checked")
    const optCheckbox = screen.getByRole("checkbox", {
      name: 'togglePermissionAriaLabel:{"permission":"clipboard:write"}',
    })
    expect(optCheckbox).toHaveAttribute("data-state", "unchecked")
  })

  it("emits the user's selection when confirmed", () => {
    const onConfirm = jest.fn()
    render(
      <WasmCapabilityGrantSheet
        manifest={baseManifest}
        authorFingerprint=""
        open
        onOpenChange={() => {}}
        onConfirm={onConfirm}
      />
    )
    // Untick filesystem:read; tick clipboard:write.
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: 'togglePermissionAriaLabel:{"permission":"filesystem:read"}',
      })
    )
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: 'togglePermissionAriaLabel:{"permission":"clipboard:write"}',
      })
    )
    fireEvent.click(screen.getByTestId("wasm-grant-confirm"))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    const decision = onConfirm.mock.calls[0][0]
    expect(decision.pluginId).toBe("demo.wasm")
    expect(decision.grantedPermissions).toEqual(
      expect.arrayContaining(["notification", "process:spawn", "clipboard:write"])
    )
    expect(decision.grantedPermissions).not.toContain("filesystem:read")
  })

  it("surfaces the dangerous-permissions warning when sensitive caps are granted", () => {
    render(
      <WasmCapabilityGrantSheet
        manifest={baseManifest}
        authorFingerprint=""
        open
        onOpenChange={() => {}}
        onConfirm={() => {}}
      />
    )
    // baseManifest grants `process:spawn` by default → dangerous count = 1.
    expect(screen.getByText(/^dangerousWarning:/)).toBeInTheDocument()
  })

  it("renders preopens checklist when manifest declares fs.preopens", () => {
    const onConfirm = jest.fn()
    const manifest: PluginManifest = {
      ...baseManifest,
      permissions: ["filesystem:read"],
      optionalPermissions: [],
      wasm: { apiVersion: "0.1.0", fs: { preopens: ["~/Documents/cognia"] } },
    }
    render(
      <WasmCapabilityGrantSheet
        manifest={manifest}
        authorFingerprint=""
        open
        onOpenChange={() => {}}
        onConfirm={onConfirm}
      />
    )
    expect(screen.getByText("extraFilesystem")).toBeInTheDocument()
    expect(screen.getByText("~/Documents/cognia")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("wasm-grant-confirm"))
    expect(onConfirm.mock.calls[0][0].grantedPreopens).toEqual(["~/Documents/cognia"])
  })

  it("renders a 'no permissions' message when the manifest declares none", () => {
    const empty: PluginManifest = {
      ...baseManifest,
      permissions: [],
      optionalPermissions: [],
    }
    render(
      <WasmCapabilityGrantSheet
        manifest={empty}
        authorFingerprint=""
        open
        onOpenChange={() => {}}
        onConfirm={() => {}}
      />
    )
    expect(screen.getByText("noSensitivePermissions")).toBeInTheDocument()
    // No dangerous warning card.
    expect(screen.queryByText(/^dangerousWarning:/)).not.toBeInTheDocument()
  })

  it("calls onCancel and closes when the user backs out", () => {
    const onCancel = jest.fn()
    const onOpenChange = jest.fn()
    render(
      <WasmCapabilityGrantSheet
        manifest={baseManifest}
        authorFingerprint=""
        open
        onOpenChange={onOpenChange}
        onCancel={onCancel}
        onConfirm={() => {}}
      />
    )
    fireEvent.click(screen.getByTestId("wasm-grant-cancel"))
    expect(onCancel).toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
