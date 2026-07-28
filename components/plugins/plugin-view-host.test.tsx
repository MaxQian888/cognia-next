/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { PluginViewHost } from "./plugin-view-host"
import type { ResolvedPluginView } from "@/types/plugin/plugin-view"
import type { ResolvedPluginWebview } from "@/types/plugin/plugin-webview"

jest.mock("./plugin-tree-view-host", () => ({
  PluginTreeViewHost: () => <span>tree body</span>,
}))
jest.mock("./plugin-custom-view-host", () => ({
  PluginCustomViewHost: () => <span>custom body</span>,
}))
jest.mock("./plugin-webview-host", () => ({
  PluginWebviewHost: () => <span>webview body</span>,
}))

describe("PluginViewHost", () => {
  it.each([
    [
      "tree",
      {
        kind: "tree",
        pluginId: "acme.views",
        viewId: "outline",
        containerId: "acme.views:main",
        provider: { getChildren: () => [] },
      } satisfies ResolvedPluginView,
      "tree body",
    ],
    [
      "custom",
      {
        kind: "react",
        pluginId: "acme.views",
        viewId: "details",
        containerId: "acme.views:main",
        component: () => null,
      } satisfies ResolvedPluginView,
      "custom body",
    ],
    [
      "webview",
      {
        pluginId: "acme.views",
        viewId: "preview",
        containerId: "acme.views:main",
        surface: "panel",
        srcDoc: "<p>preview</p>",
      } satisfies ResolvedPluginWebview,
      "webview body",
    ],
  ])("wraps a %s view in one panel surface", (kind, entry, expected) => {
    const { container } = render(<PluginViewHost entry={entry} />)

    expect(screen.getByText(expected)).toBeInTheDocument()
    expect(container.querySelectorAll('[data-plugin-root="acme.views"]')).toHaveLength(
      kind === "webview" ? 0 : 1
    )
    expect(container.querySelector("[data-plugin-form-factor]")).toHaveAttribute(
      "data-plugin-form-factor",
      "panel"
    )
  })
})
