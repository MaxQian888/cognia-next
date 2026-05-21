/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

jest.mock("../plugin-devtools-panel", () => ({
  PluginDevtoolsPanel: () => <div data-testid="plugin-devtools-panel-stub" />,
}))
jest.mock("../plugin-point-diagnostics-panel", () => ({
  PluginPointDiagnosticsPanel: () => <div data-testid="plugin-point-diagnostics-stub" />,
}))

import { PluginDevtoolsPane } from "./plugin-devtools-pane"

describe("PluginDevtoolsPane", () => {
  it("renders the devtools panel and the extension-point diagnostics stack", () => {
    render(<PluginDevtoolsPane />)
    expect(screen.getByTestId("plugin-devtools-pane")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-devtools-panel-stub")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-point-diagnostics-stub")).toBeInTheDocument()
  })
})
