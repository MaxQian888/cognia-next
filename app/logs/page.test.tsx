/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("@/components/logging/diagnostics-workspace", () => ({
  DiagnosticsWorkspace: () => <div data-testid="diagnostics-workspace" />,
}))

import LogsPage from "./page"

describe("/logs page", () => {
  it("mounts the consolidated diagnostics workspace", () => {
    render(<LogsPage />)
    expect(screen.getByTestId("diagnostics-workspace")).toBeInTheDocument()
  })
})
