/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

jest.mock("./plugin-dev-session-workbench", () => ({
  PluginDevSessionWorkbench: () => <div data-testid="plugin-dev-session-workbench-stub" />,
}))

jest.mock("./hot-reload-diagnostics", () => ({
  HotReloadDiagnostics: () => <div data-testid="hot-reload-diagnostics-stub" />,
}))

import { PluginDevtoolsPane } from "./plugin-devtools-pane"

describe("PluginDevtoolsPane", () => {
  it("renders the unified Dev Session workbench", () => {
    render(<PluginDevtoolsPane />)
    expect(screen.getByTestId("plugin-devtools-pane")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-dev-session-workbench-stub")).toBeInTheDocument()
  })

  // `CliBridgeEventsBridge` has been filling `hot-reload-history-store` on
  // every install / uninstall / hot-reload, while the panel that reads it had
  // no production importer. The events were recorded and never shown.
  it("renders the hot-reload history the CLI bridge has been recording", () => {
    render(<PluginDevtoolsPane />)
    expect(screen.getByTestId("hot-reload-diagnostics-stub")).toBeInTheDocument()
  })
})
