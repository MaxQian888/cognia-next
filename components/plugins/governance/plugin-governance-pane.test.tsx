/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("../detail/plugin-permissions-tab", () => ({
  PluginPermissionsTab: () => <div data-testid="governance-permissions" />,
}))
jest.mock("../detail/plugin-scheduled-jobs", () => ({
  PluginScheduledJobs: () => <div data-testid="governance-scheduled" />,
}))
jest.mock("../detail/plugin-analytics", () => ({
  PluginAnalytics: () => <div data-testid="governance-analytics" />,
}))
jest.mock("./plugin-audit-log", () => ({
  PluginAuditLog: () => <div data-testid="governance-audit" />,
}))

import { usePluginsStore } from "@/stores/plugins"
import { PluginGovernancePane } from "./plugin-governance-pane"

beforeEach(() => {
  usePluginsStore.setState({ governanceView: "permissions" })
})

describe("PluginGovernancePane", () => {
  it.each([
    ["permissions", "governance-permissions"],
    ["scheduled", "governance-scheduled"],
    ["analytics", "governance-analytics"],
    ["audit", "governance-audit"],
  ] as const)("delegates to the %s child when governanceView=%s", (view, testid) => {
    usePluginsStore.setState({ governanceView: view })
    render(<PluginGovernancePane />)
    expect(screen.getByTestId(testid)).toBeInTheDocument()
  })

  it("exposes the active view via data-view for integration assertions", () => {
    usePluginsStore.setState({ governanceView: "audit" })
    const { container } = render(<PluginGovernancePane />)
    expect(
      container.querySelector('[data-testid="plugin-governance-pane"]')?.getAttribute("data-view")
    ).toBe("audit")
  })
})
