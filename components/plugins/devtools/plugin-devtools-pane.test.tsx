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

jest.mock("./plugin-watch-card", () => ({
  PluginWatchCard: () => <div data-testid="plugin-watch-card-stub" />,
}))

jest.mock("./managed-ide/managed-ide-dev-mode-card", () => ({
  ManagedIdeDevModeCard: () => <div data-testid="managed-ide-dev-mode-card-stub" />,
}))

import { PluginDevtoolsPane } from "./plugin-devtools-pane"

describe("PluginDevtoolsPane", () => {
  it("renders the unified Dev Session workbench", () => {
    render(<PluginDevtoolsPane />)
    expect(screen.getByTestId("plugin-devtools-pane")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-dev-session-workbench-stub")).toBeInTheDocument()
  })

  it("renders the hot-reload history", () => {
    render(<PluginDevtoolsPane />)
    expect(screen.getByTestId("hot-reload-diagnostics-stub")).toBeInTheDocument()
  })

  // The watcher is a Tauri command holding a native `notify` handle. Nothing
  // else in the app mounts this control, so an unmounted card means the
  // in-app reload loop simply does not exist for the user.
  it("mounts the file-watch control", () => {
    render(<PluginDevtoolsPane />)
    expect(screen.getByTestId("plugin-watch-card-stub")).toBeInTheDocument()
  })

  // Managed IDE Dev Mode has no other mount: without this card the host
  // switch, the broker trace and permission simulation are unreachable.
  it("mounts the Managed IDE Dev Mode card", () => {
    render(<PluginDevtoolsPane />)
    expect(screen.getByTestId("managed-ide-dev-mode-card-stub")).toBeInTheDocument()
  })
})
