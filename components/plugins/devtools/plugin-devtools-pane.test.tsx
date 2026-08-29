/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

jest.mock("./plugin-dev-session-workbench", () => ({
  PluginDevSessionWorkbench: () => <div data-testid="plugin-dev-session-workbench-stub" />,
}))

import { PluginDevtoolsPane } from "./plugin-devtools-pane"

describe("PluginDevtoolsPane", () => {
  it("renders the unified Dev Session workbench", () => {
    render(<PluginDevtoolsPane />)
    expect(screen.getByTestId("plugin-devtools-pane")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-dev-session-workbench-stub")).toBeInTheDocument()
  })
})
