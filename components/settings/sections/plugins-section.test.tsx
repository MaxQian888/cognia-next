/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && typeof vars.count === "number") return `${key}:${vars.count}`
    return key
  },
}))

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, ...props }: { children: React.ReactNode }) => <a {...props}>{children}</a>,
}))

const mockPlugins = [
  {
    id: "plugin_a",
    name: "Alpha plugin",
    version: "1.0.0",
    status: "enabled",
    source: "builtin",
    type: "frontend",
    enabled: true,
    capabilities: ["tools", "commands"],
    path: "builtin://alpha",
    manifest: { permissions: ["clipboard:read"], updateAvailable: true },
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: "plugin_b",
    name: "Beta plugin",
    version: "0.5.0",
    status: "error",
    source: "marketplace",
    type: "frontend",
    enabled: false,
    capabilities: ["themes"],
    path: "/usr/plugins/beta",
    manifest: { permissions: ["network:fetch"] },
    error: "load failed",
    createdAt: 2,
    updatedAt: 2,
  },
]

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockPlugins,
}))

jest.mock("@/lib/db/plugins", () => ({
  listPlugins: jest.fn(() => Promise.resolve(mockPlugins)),
}))

import { PluginsSection } from "./plugins-section"

describe("PluginsSection (workspace launcher)", () => {
  it("renders the section title", () => {
    render(<PluginsSection />)
    expect(screen.getByText("title")).toBeInTheDocument()
  })

  it("shows status badges driven by the mocked plugins (enabled / updates / errored)", () => {
    render(<PluginsSection />)
    // enabled=1, updates=1 (plugin_a.updateAvailable), errored=1
    expect(screen.getByText(/badgeEnabled:1/)).toBeInTheDocument()
    expect(screen.getByText(/badgeUpdates:1/)).toBeInTheDocument()
    expect(screen.getByText(/badgeError:1/)).toBeInTheDocument()
  })

  it("links the primary button to the library workspace", () => {
    render(<PluginsSection />)
    const link = screen.getByText("openWorkspace").closest("a")
    expect(link).toHaveAttribute("href", "/plugins?section=library")
  })

  it("links the governance button to the governance permissions view", () => {
    render(<PluginsSection />)
    const link = screen.getByText("manageGovernance").closest("a")
    expect(link).toHaveAttribute("href", "/plugins?section=governance&gov=permissions")
  })

  it("does not render the removed jump-board cards or policy controls", () => {
    render(<PluginsSection />)
    expect(screen.queryByText("installedCard.title")).not.toBeInTheDocument()
    expect(screen.queryByText("marketplaceCard.title")).not.toBeInTheDocument()
    expect(screen.queryByRole("switch")).not.toBeInTheDocument()
  })

  it("calls onClose when a workspace link is activated", () => {
    const onClose = jest.fn()
    render(<PluginsSection onClose={onClose} />)
    screen.getByText("openWorkspace").closest("a")?.click()
    expect(onClose).toHaveBeenCalled()
  })
})
