/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (namespace?: string) => {
    const t = (key: string, vars?: Record<string, unknown>) =>
      namespace === "plugins.permissions.descriptions"
        ? `desc:${key}`
        : vars
          ? `${key}:${JSON.stringify(vars)}`
          : key
    ;(t as unknown as { has: (k: string) => boolean }).has = () =>
      namespace === "plugins.permissions.descriptions"
    return t
  },
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

  // The dialog had no height cap: on a phone a long permission list pushed
  // Continue below the fold with nothing to scroll.
  it("caps the dialog height and scrolls only the step body", () => {
    render(
      <PluginPreInstallDialog target={permissionTarget} onContinue={() => {}} onCancel={() => {}} />
    )
    expect(screen.getByRole("dialog")).toHaveClass("max-h-[85dvh]", "flex", "flex-col")
    expect(screen.getByTestId("pre-install-step-body")).toHaveClass(
      "min-h-0",
      "flex-1",
      "overflow-y-auto"
    )
  })

  // It listed bare permission ids; now each reads like the review dialog.
  it("describes each permission and labels the sensitive ones", () => {
    render(
      <PluginPreInstallDialog
        target={{
          ...permissionTarget,
          permission: { pluginId: "p", declared: ["shell:execute"], optional: [] },
        }}
        onContinue={() => {}}
        onCancel={() => {}}
      />
    )
    expect(screen.getByText("desc:shell:execute")).toBeInTheDocument()
    expect(screen.getByRole("img", { name: "dangerousAria" })).toBeInTheDocument()
  })

  // The step had its own parser that only knew string / number / boolean, so
  // enums, nested objects and validation were silently lost before install.
  it("renders the config step with the full config-form renderer", () => {
    const onContinue = jest.fn()
    render(
      <PluginPreInstallDialog
        target={{
          ...configTarget,
          config: {
            pluginId: "p",
            configSchema: {
              type: "object",
              properties: {
                region: { type: "string", enum: ["eu", "us"], default: "us" },
                nested: { type: "object", properties: { depth: { type: "number", default: 3 } } },
                email: { type: "string", format: "email", default: "nope" },
              },
            },
          },
        }}
        onContinue={onContinue}
        onCancel={() => {}}
      />
    )
    expect(screen.getByLabelText("depth")).toBeInTheDocument()
    // Invalid email → Confirm is held, like Save in the detail pane.
    expect(screen.getByTestId("pre-install-config-confirm")).toBeDisabled()
    fireEvent.change(screen.getByLabelText("email"), { target: { value: "a@b.co" } })
    fireEvent.click(screen.getByTestId("pre-install-config-confirm"))
    expect(onContinue).toHaveBeenCalledWith({
      region: "us",
      nested: { depth: 3 },
      email: "a@b.co",
    })
  })
})
