/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
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
