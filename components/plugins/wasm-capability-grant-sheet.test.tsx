/**
 * @jest-environment jsdom
 */

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
    expect(screen.getByText(/Review permissions for Demo WASM Plugin/i)).toBeInTheDocument()
    expect(screen.getByText("Notifications")).toBeInTheDocument()
    expect(screen.getByText("Filesystem")).toBeInTheDocument()
    expect(screen.getByText("OS / Process")).toBeInTheDocument()
    expect(screen.getByText("Optional (off by default)")).toBeInTheDocument()
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
    const reqCheckbox = screen.getByRole("checkbox", { name: /Toggle notification/i })
    expect(reqCheckbox).toHaveAttribute("data-state", "checked")
    const optCheckbox = screen.getByRole("checkbox", { name: /Toggle clipboard:write/i })
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
    fireEvent.click(screen.getByRole("checkbox", { name: /Toggle filesystem:read/i }))
    fireEvent.click(screen.getByRole("checkbox", { name: /Toggle clipboard:write/i }))
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
    expect(screen.getByText(/sensitive capabilit/i)).toBeInTheDocument()
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
    expect(screen.getByText("Extra filesystem access")).toBeInTheDocument()
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
    expect(screen.getByText(/does not request any sensitive permissions/i)).toBeInTheDocument()
    // No dangerous warning card.
    expect(screen.queryByText(/sensitive capabilit/i)).not.toBeInTheDocument()
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
