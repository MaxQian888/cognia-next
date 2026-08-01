/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

import { DockPanelUnavailable } from "./dock-panel-unavailable"

describe("DockPanelUnavailable", () => {
  it("explains a disabled plugin and promises the panel comes back", () => {
    render(<DockPanelUnavailable name="Notes" reason="plugin" />)
    expect(screen.getByTestId("dock-panel-unavailable")).toHaveAttribute("data-reason", "plugin")
    expect(screen.getByText(/^pluginUnavailable:/)).toBeInTheDocument()
    expect(screen.getByText("pluginUnavailableHint")).toBeInTheDocument()
  })

  it("explains a revoked permission without the plugin hint", () => {
    render(<DockPanelUnavailable name="Notes" reason="permission" />)
    expect(screen.getByText(/^permissionRevoked:/)).toBeInTheDocument()
    expect(screen.queryByText("pluginUnavailableHint")).toBeNull()
  })

  it("offers a retry only when one was supplied", () => {
    const onRetry = jest.fn()
    const { rerender } = render(
      <DockPanelUnavailable name="Notes" reason="crashed" onRetry={onRetry} />
    )
    fireEvent.click(screen.getByRole("button", { name: "panelCrashedRetry" }))
    expect(onRetry).toHaveBeenCalled()

    rerender(<DockPanelUnavailable name="Notes" reason="crashed" />)
    expect(screen.queryByRole("button")).toBeNull()
  })
})
