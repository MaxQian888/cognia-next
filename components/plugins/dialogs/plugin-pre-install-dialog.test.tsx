/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const mockOpenUrl = jest.fn()
jest.mock("@/lib/native/opener", () => ({
  openUrl: (...args: unknown[]) => mockOpenUrl(...args),
}))

import { PluginPreInstallDialog, type PreInstallTarget } from "./plugin-pre-install-dialog"

const conflictTarget: PreInstallTarget = {
  pluginId: "p",
  pluginName: "Plugin P",
  step: "conflict",
  stepNumber: 1,
  totalSteps: 3,
  conflict: {
    pluginId: "p",
    reasons: [
      { severity: "high", message: "Version clash" },
      { severity: "low", message: "Duplicate tool name" },
    ],
  },
}

const permissionTarget: PreInstallTarget = {
  pluginId: "p",
  pluginName: "Plugin P",
  step: "permission",
  stepNumber: 2,
  totalSteps: 3,
  permission: {
    pluginId: "p",
    declared: ["clipboard:read"],
    optional: ["network:fetch"],
  },
}

const configTarget: PreInstallTarget = {
  pluginId: "p",
  pluginName: "Plugin P",
  step: "config",
  stepNumber: 3,
  totalSteps: 3,
  config: {
    pluginId: "p",
    configSchema: {
      type: "object",
      properties: {
        token: { type: "string", default: "" },
        max: { type: "number", default: 5 },
        enabled: { type: "boolean", default: true },
      },
    },
  },
}

const binariesTarget: PreInstallTarget = {
  pluginId: "p",
  pluginName: "Plugin P",
  step: "binaries",
  stepNumber: 2,
  totalSteps: 4,
  binaries: {
    pluginId: "p",
    missing: [
      { name: "git", minVersion: "2.0.0", documentation: "https://git-scm.com" },
      { name: "cargo-component", detectedVersion: "cargo-component 0.0.1" },
    ],
  },
}

describe("PluginPreInstallDialog", () => {
  it("does not render content when target is null", () => {
    render(<PluginPreInstallDialog target={null} onContinue={() => {}} onCancel={() => {}} />)
    expect(screen.queryByTestId("plugin-pre-install-dialog")).not.toBeInTheDocument()
  })

  it("renders conflict step with reasons", () => {
    render(
      <PluginPreInstallDialog target={conflictTarget} onContinue={() => {}} onCancel={() => {}} />
    )
    expect(screen.getByTestId("pre-install-conflict-list")).toBeInTheDocument()
    expect(screen.getByText("Version clash")).toBeInTheDocument()
    expect(screen.getByText("Duplicate tool name")).toBeInTheDocument()
  })

  it("conflict next button calls onContinue without args", () => {
    const onContinue = jest.fn()
    render(
      <PluginPreInstallDialog target={conflictTarget} onContinue={onContinue} onCancel={() => {}} />
    )
    fireEvent.click(screen.getByTestId("pre-install-conflict-continue"))
    expect(onContinue).toHaveBeenCalledWith()
  })

  it("renders permission step with declared and optional perms", () => {
    render(
      <PluginPreInstallDialog target={permissionTarget} onContinue={() => {}} onCancel={() => {}} />
    )
    expect(screen.getByText("clipboard:read")).toBeInTheDocument()
    expect(screen.getByText("network:fetch")).toBeInTheDocument()
  })

  it("install_dialog_shows_inferred_permissions", () => {
    // For an Open VSX install, `permission.declared` is the union of what
    // `inferPermissions` walked out of the real downloaded bundle (see
    // openvsx-install-flow's aggregateManifest). The dialog's job is to show
    // every one of them, plus the notice that a VS Code extension is an
    // ordinary program — the permission list alone reads like a sandbox
    // manifest, which would imply a confinement cognia does not provide.
    const target: PreInstallTarget = {
      ...permissionTarget,
      permission: {
        pluginId: "esbenp.prettier-vscode",
        declared: ["filesystem:read", "filesystem:write", "process:spawn", "network:fetch"],
        optional: [],
      },
    }
    render(
      <PluginPreInstallDialog
        target={target}
        notice="Extensions run with real filesystem, network, and process access."
        onContinue={() => {}}
        onCancel={() => {}}
      />
    )

    for (const perm of ["filesystem:read", "filesystem:write", "process:spawn", "network:fetch"]) {
      expect(screen.getByText(perm)).toBeInTheDocument()
    }
    expect(screen.getByTestId("pre-install-permission-notice")).toHaveTextContent(
      "real filesystem, network, and process access"
    )
  })

  it("renders no notice when none is supplied, leaving the cognia chain unchanged", () => {
    render(
      <PluginPreInstallDialog target={permissionTarget} onContinue={() => {}} onCancel={() => {}} />
    )
    expect(screen.queryByTestId("pre-install-permission-notice")).not.toBeInTheDocument()
  })

  it("surfaces the network egress allowlist + reasoning in the permission step", () => {
    const target: PreInstallTarget = {
      ...permissionTarget,
      permission: {
        pluginId: "p",
        declared: ["network:fetch"],
        optional: [],
        networkAccess: {
          allowedDomains: ["api.github.com"],
          reasoning: "Talks to the GitHub API to open PRs.",
        },
      },
    }
    render(<PluginPreInstallDialog target={target} onContinue={() => {}} onCancel={() => {}} />)
    expect(screen.getByTestId("pre-install-network-access")).toBeInTheDocument()
    expect(screen.getByText("api.github.com")).toBeInTheDocument()
    expect(screen.getByText("Talks to the GitHub API to open PRs.")).toBeInTheDocument()
  })

  it("renders the binaries step listing each missing tool", () => {
    render(
      <PluginPreInstallDialog target={binariesTarget} onContinue={() => {}} onCancel={() => {}} />
    )
    expect(screen.getByTestId("pre-install-binaries-list")).toBeInTheDocument()
    expect(screen.getByText("git")).toBeInTheDocument()
    expect(screen.getByText("cargo-component")).toBeInTheDocument()
  })

  it("binaries retry button calls onContinue without args", () => {
    const onContinue = jest.fn()
    render(
      <PluginPreInstallDialog target={binariesTarget} onContinue={onContinue} onCancel={() => {}} />
    )
    fireEvent.click(screen.getByTestId("pre-install-binaries-continue"))
    expect(onContinue).toHaveBeenCalledWith()
  })

  it("binaries cancel button calls onCancel", () => {
    const onCancel = jest.fn()
    render(
      <PluginPreInstallDialog target={binariesTarget} onContinue={() => {}} onCancel={onCancel} />
    )
    fireEvent.click(screen.getByTestId("pre-install-binaries-cancel"))
    expect(onCancel).toHaveBeenCalled()
  })

  it("renders config step with parsed fields and submits values", () => {
    const onContinue = jest.fn()
    render(
      <PluginPreInstallDialog target={configTarget} onContinue={onContinue} onCancel={() => {}} />
    )
    expect(screen.getByTestId("pre-install-config-fields")).toBeInTheDocument()
    expect(screen.getByLabelText("token")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("pre-install-config-confirm"))
    expect(onContinue).toHaveBeenCalledWith(
      expect.objectContaining({ token: "", max: 5, enabled: true })
    )
  })

  it("cancel button triggers onCancel", () => {
    const onCancel = jest.fn()
    render(
      <PluginPreInstallDialog target={conflictTarget} onContinue={() => {}} onCancel={onCancel} />
    )
    fireEvent.click(screen.getAllByText("cancel")[0])
    expect(onCancel).toHaveBeenCalled()
  })

  it("applies mobile-first w-[95vw] width to DialogContent", () => {
    render(
      <PluginPreInstallDialog target={conflictTarget} onContinue={() => {}} onCancel={() => {}} />
    )
    const dialog = screen.getByRole("dialog")
    expect(dialog.className).toContain("w-[95vw]")
  })
})
