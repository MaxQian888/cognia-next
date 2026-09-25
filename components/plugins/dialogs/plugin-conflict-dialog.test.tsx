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

  // A long conflict report used to grow the dialog past a phone screen and
  // push Abort / Continue out of reach. The content is capped at the dynamic
  // viewport; the severity summary and list share one scroller between a
  // fixed header and footer.
  it("bounds DialogContent to the viewport with one scroll body", () => {
    usePluginsStore.setState({
      conflictDialogTarget: {
        pluginId: "plugin_a",
        conflicts: Array.from({ length: 30 }, (_, i) => ({
          severity: "medium" as const,
          message: `Conflict ${i}`,
          relatedPluginId: `com.example.an-extremely-long-related-plugin-identifier-${i}`,
        })),
      },
    })
    render(<PluginConflictDialog />)
    const dialog = screen.getByRole("dialog")
    expect(dialog).toHaveClass("flex", "flex-col", "max-h-[85dvh]")
    const body = screen.getByTestId("plugin-conflict-dialog-body")
    expect(body).toHaveClass("min-h-0", "flex-1", "overflow-y-auto")
    expect(body).toHaveTextContent("mediumCount:30")
    expect(body.querySelector("[data-slot='scroll-area']")).toBeNull()
    expect(dialog.querySelector("[data-slot='dialog-header']")).toHaveClass("shrink-0")
    expect(dialog.querySelector("[data-slot='dialog-footer']")).toHaveClass("shrink-0")
    expect(screen.getByText(/related-plugin-identifier-0$/)).toHaveClass("break-all")
    expect(screen.getByRole("heading", { name: "title:plugin_a" })).toHaveClass("break-words")
  })
})
