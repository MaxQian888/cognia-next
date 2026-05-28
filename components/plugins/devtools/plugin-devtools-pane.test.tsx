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
jest.mock("./local-plugin-dropzone", () => ({
  LocalPluginDropzone: () => <div data-testid="local-plugin-dropzone-stub" />,
}))
jest.mock("./manifest-validator", () => ({
  ManifestValidator: () => <div data-testid="manifest-validator-stub" />,
}))
jest.mock("./hot-reload-diagnostics", () => ({
  HotReloadDiagnostics: () => <div data-testid="hot-reload-diagnostics-stub" />,
}))
jest.mock("./cognia-cli-status-card", () => ({
  CogniaCliStatusCard: () => <div data-testid="cognia-cli-status-card-stub" />,
}))

import { PluginDevtoolsPane } from "./plugin-devtools-pane"

describe("PluginDevtoolsPane", () => {
  it("renders the devtools panel and the extension-point diagnostics stack", () => {
    render(<PluginDevtoolsPane />)
    expect(screen.getByTestId("plugin-devtools-pane")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-devtools-panel-stub")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-point-diagnostics-stub")).toBeInTheDocument()
  })

  it("renders the local-load author surfaces (dropzone, validator, hot-reload)", () => {
    render(<PluginDevtoolsPane />)
    expect(screen.getByTestId("local-plugin-dropzone-stub")).toBeInTheDocument()
    expect(screen.getByTestId("manifest-validator-stub")).toBeInTheDocument()
    expect(screen.getByTestId("hot-reload-diagnostics-stub")).toBeInTheDocument()
  })

  it("renders the cognia CLI status card", () => {
    render(<PluginDevtoolsPane />)
    expect(screen.getByTestId("cognia-cli-status-card-stub")).toBeInTheDocument()
  })
})
