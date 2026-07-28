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

  it("adds no wrapper element of its own", () => {
    // This host owns nothing but prop forwarding. Crash isolation and the
    // `@scope` anchor moved up to `PluginSurface` when the surface contracts
    // were unified, so `PluginViewHost` — not this component — is what stands
    // between a throwing plugin view and the app. Isolation is proven there:
    // "silently removes a crashed %s surface while reporting it" and "renders
    // an inline diagnostic for a crashed %s surface and retries successfully"
    // in `plugin-surface.test.tsx`, plus the per-kind wrapper assertions in
    // `plugin-view-host.test.tsx`.
    const View = () => <span>body</span>
    const { container } = render(<PluginCustomViewHost component={View} pluginId="p" viewId="v" />)

    expect(container.firstElementChild?.tagName).toBe("SPAN")
    expect(container.querySelector("[data-plugin-root]")).toBeNull()
  })
})
