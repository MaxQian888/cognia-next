/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { PluginRow } from "@/lib/db/plugin-types"

let mockPlugin: PluginRow | undefined

// Resolves the permission descriptions against the split source so the test
// sees the localized sentence, while every other key echoes itself.
jest.mock("next-intl", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const permissions = require("@/i18n/messages/en/plugins/permissions.json") as {
    descriptions: Record<string, string>
  }
  return {
    useTranslations: (namespace?: string) => {
      const t = (key: string) =>
        namespace === "plugins.permissions.descriptions"
          ? (permissions.descriptions[key] ?? key)
          : key
      ;(t as unknown as { has: (k: string) => boolean }).has = (key: string) =>
        namespace === "plugins.permissions.descriptions" && key in permissions.descriptions
      return t
    },
    // Audit rows format their time through next-intl.
    useFormatter: () => ({ dateTime: (v: Date | number) => new Date(v).toISOString() }),
    useLocale: () => "en",
  }
})

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
    engines: { node: ">=26.0.0" },
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

  // Revoke-all drops every grant (the manifest-declared ones included) with no
  // undo, so it asks first.
  it("revokeAll asks for confirmation, then empties the plugin's grants", async () => {
    const user = userEvent.setup()
    const guard = getPermissionGuard()
    guard.registerPlugin("p_review", ["clipboard:read"])
    render(<PluginPermissionReview />)
    await user.click(screen.getByRole("button", { name: "revokeAll" }))
    expect(guard.getPluginPermissions("p_review")).not.toEqual([])
    const confirm = await screen.findByRole("alertdialog")
    expect(confirm).toHaveTextContent("revokeAllConfirmTitle")
    await user.click(within(confirm).getByRole("button", { name: "revokeAll" }))
    expect(guard.getPluginPermissions("p_review")).toEqual([])
  })

  it("cancelling the revoke-all confirmation keeps the grants", async () => {
    const user = userEvent.setup()
    const guard = getPermissionGuard()
    guard.registerPlugin("p_review", ["clipboard:read"])
    render(<PluginPermissionReview />)
    await user.click(screen.getByRole("button", { name: "revokeAll" }))
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "cancel" })
    )
    expect(guard.getPluginPermissions("p_review")).not.toEqual([])
  })

  it("shows the localized description and labels the sensitive marker", () => {
    render(<PluginPermissionReview />)
    expect(screen.getByText("Read from the clipboard")).toBeInTheDocument()
    const shellRow = screen.getByText("shell:execute").closest("tr") as HTMLElement
    expect(within(shellRow).getByRole("img", { name: "dangerousAria" })).toBeInTheDocument()
  })

  it("keeps the dialog within the viewport while allowing a wider desktop layout", () => {
    render(<PluginPermissionReview />)
    const dialog = screen.getByRole("dialog")
    expect(dialog.className).toContain("w-[calc(100%-2rem)]")
    expect(dialog.className).toContain("sm:max-w-3xl")
  })

  it("moves manifest and optional state into the permission summary instead of wide columns", () => {
    render(<PluginPermissionReview />)
    expect(screen.queryByRole("columnheader", { name: "colDeclared" })).not.toBeInTheDocument()
    expect(screen.queryByRole("columnheader", { name: "colOptional" })).not.toBeInTheDocument()
    expect(screen.getAllByText("colDeclared")).not.toHaveLength(0)
    expect(screen.getAllByText("colOptional")).not.toHaveLength(0)
  })

  it("uses stacked permission rows below the small breakpoint", () => {
    render(<PluginPermissionReview />)
    const permissionRow = screen.getByText("clipboard:read").closest("tr")
    expect(permissionRow?.className).toContain("grid")
    expect(permissionRow?.className).toContain("sm:table-row")
  })

  it("shows unsupported native Node permissions without allowing a grant", () => {
    render(<PluginPermissionReview />)
    const networkRow = screen.getByText("network:fetch").closest("tr")
    expect(networkRow).not.toBeNull()
    const row = within(networkRow as HTMLElement)
    expect(row.getByText("nodeNetworkUnavailable")).toBeInTheDocument()
    expect(row.getByRole("button", { name: "grant" })).toBeDisabled()
    expect(row.getByRole("combobox", { name: "colTier" })).toBeDisabled()
  })

  it("does not present an unavailable Node permission as effectively granted", () => {
    getPermissionGuard().registerPlugin("p_review", ["network:fetch"])
    render(<PluginPermissionReview />)
    const networkRow = screen.getByText("network:fetch").closest("tr")
    expect(networkRow).not.toBeNull()
    const row = within(networkRow as HTMLElement)
    expect(row.queryByLabelText("colGranted")).not.toBeInTheDocument()
    expect(row.getByRole("button", { name: "revoke" })).toBeEnabled()
  })
})
