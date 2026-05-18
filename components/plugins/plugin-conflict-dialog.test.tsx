/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && typeof vars.count === "number") return `${key}:${vars.count}`
    if (vars && typeof vars.id === "string") return `${key}:${vars.id}`
    return key
  },
}))

import { PluginConflictDialog } from "./plugin-conflict-dialog"
import { usePluginsStore } from "@/stores/plugins"

beforeEach(() => {
  usePluginsStore.setState({ conflictDialogTarget: null })
})

describe("PluginConflictDialog", () => {
  it("renders nothing when no conflictDialogTarget is set", () => {
    const { container } = render(<PluginConflictDialog />)
    expect(container.querySelector("[role='dialog']")).toBeNull()
  })

  it("renders severity badges and conflict messages", () => {
    usePluginsStore.setState({
      conflictDialogTarget: {
        pluginId: "plugin_a",
        conflicts: [
          { severity: "high", message: "Version clash", relatedPluginId: "plugin_b" },
          { severity: "low", message: "Duplicate tool name" },
        ],
      },
    })
    render(<PluginConflictDialog />)
    expect(screen.getByText(/highCount:1/)).toBeInTheDocument()
    expect(screen.getByText(/lowCount:1/)).toBeInTheDocument()
    expect(screen.getByText("Version clash")).toBeInTheDocument()
    expect(screen.getByText("Duplicate tool name")).toBeInTheDocument()
  })

  it("abort clears the target", () => {
    usePluginsStore.setState({
      conflictDialogTarget: {
        pluginId: "plugin_a",
        conflicts: [{ severity: "low", message: "x" }],
      },
    })
    render(<PluginConflictDialog />)
    fireEvent.click(screen.getByText("abort"))
    expect(usePluginsStore.getState().conflictDialogTarget).toBeNull()
  })

  it("continue clears target and invokes onContinue with the pluginId", () => {
    usePluginsStore.setState({
      conflictDialogTarget: {
        pluginId: "plugin_a",
        conflicts: [{ severity: "low", message: "x" }],
      },
    })
    const onContinue = jest.fn()
    render(<PluginConflictDialog onContinue={onContinue} />)
    fireEvent.click(screen.getByText("continue"))
    expect(usePluginsStore.getState().conflictDialogTarget).toBeNull()
    expect(onContinue).toHaveBeenCalledWith("plugin_a")
  })

  it("applies mobile-first w-[95vw] width to DialogContent", () => {
    usePluginsStore.setState({
      conflictDialogTarget: {
        pluginId: "plugin_a",
        conflicts: [{ severity: "low", message: "x" }],
      },
    })
    render(<PluginConflictDialog />)
    const dialog = screen.getByRole("dialog")
    expect(dialog.className).toContain("w-[95vw]")
  })
})
