/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { PluginCustomViewHost } from "./plugin-custom-view-host"
import type { PluginViewProps } from "@/types/plugin/plugin-view"

jest.mock("@/lib/plugin/utils/analytics", () => ({ trackPluginEvent: jest.fn() }))

describe("PluginCustomViewHost", () => {
  it("renders the plugin's component with its props", () => {
    const View = ({ pluginId, viewId }: PluginViewProps) => (
      <div>
        hello {pluginId}/{viewId}
      </div>
    )
    render(<PluginCustomViewHost component={View} pluginId="p" viewId="v" />)
    expect(screen.getByText("hello p/v")).toBeInTheDocument()
  })

  it("isolates a throwing view behind the error boundary", () => {
    const Boom = () => {
      throw new Error("kaboom")
    }
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    const { container } = render(<PluginCustomViewHost component={Boom} pluginId="p" viewId="v" />)
    // Boundary renders null on error — host survives.
    expect(container.textContent).toBe("")
    errSpy.mockRestore()
  })
})
