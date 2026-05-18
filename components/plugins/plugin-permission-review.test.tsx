/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import type { PluginRow } from "@/lib/db/plugin-types"

let mockPlugin: PluginRow | undefined

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockPlugin,
}))

jest.mock("@/lib/db/plugins", () => ({
  getPlugin: jest.fn(() => Promise.resolve(mockPlugin)),
}))

import { resetPermissionGuard, getPermissionGuard } from "@/lib/plugin/security/permission-guard"
import { PluginPermissionReview } from "./plugin-permission-review"
import { usePluginsStore } from "@/stores/plugins"

const targetPlugin: PluginRow = {
  id: "p_review",
  name: "Review Plugin",
  version: "1.0.0",
  status: "enabled",
  source: "marketplace",
  type: "frontend",
  enabled: true,
  capabilities: [],
  path: "/p/review",
  manifest: {
    id: "p_review",
    permissions: ["clipboard:read", "shell:execute"],
    optionalPermissions: ["network:fetch"],
  },
  createdAt: 1,
  updatedAt: 1,
}

beforeEach(() => {
  mockPlugin = targetPlugin
  resetPermissionGuard()
  usePluginsStore.setState({ permissionReviewTarget: { pluginId: "p_review" } })
})

describe("PluginPermissionReview", () => {
  it("does not render when permissionReviewTarget is null", () => {
    usePluginsStore.setState({ permissionReviewTarget: null })
    render(<PluginPermissionReview />)
    expect(screen.queryByText("colPermission")).not.toBeInTheDocument()
  })

  it("renders the table with declared + optional permissions", () => {
    render(<PluginPermissionReview />)
    expect(screen.getByText("colPermission")).toBeInTheDocument()
    expect(screen.getByText("clipboard:read")).toBeInTheDocument()
    expect(screen.getByText("shell:execute")).toBeInTheDocument()
    expect(screen.getByText("network:fetch")).toBeInTheDocument()
  })

  it("clicking grant button persists the grant in the guard", () => {
    render(<PluginPermissionReview />)
    const grantButtons = screen.getAllByText("grant")
    fireEvent.click(grantButtons[0])
    const guard = getPermissionGuard()
    expect(guard.getPluginPermissions("p_review").length).toBeGreaterThan(0)
  })

  it("revokeAll empties the plugin's grants", () => {
    const guard = getPermissionGuard()
    guard.registerPlugin("p_review", ["clipboard:read"])
    render(<PluginPermissionReview />)
    fireEvent.click(screen.getByText("revokeAll"))
    expect(guard.getPluginPermissions("p_review")).toEqual([])
  })

  it("applies mobile-first w-[95vw] width to DialogContent", () => {
    render(<PluginPermissionReview />)
    const dialog = screen.getByRole("dialog")
    expect(dialog.className).toContain("w-[95vw]")
  })

  it("hides Declared and Optional columns on narrow viewports via hidden md:table-cell", () => {
    render(<PluginPermissionReview />)
    const declaredHeader = screen.getByText("colDeclared").closest("th")
    const optionalHeader = screen.getByText("colOptional").closest("th")
    expect(declaredHeader?.className).toContain("hidden")
    expect(declaredHeader?.className).toContain("md:table-cell")
    expect(optionalHeader?.className).toContain("hidden")
    expect(optionalHeader?.className).toContain("md:table-cell")
  })
})
