import "fake-indexeddb/auto"
import React from "react"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PluginDataManagement } from "./plugin-data-management"

// Mock useLiveQuery so we control the returned data without a real Dexie setup.
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn(),
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: jest.fn(() => ({
    pluginDexieMeta: {
      toArray: jest.fn(),
      where: jest.fn(() => ({
        equals: jest.fn(() => ({ toArray: jest.fn() })),
      })),
    },
  })),
}))

jest.mock("@/lib/plugin/dexie/bridge", () => ({
  clearPluginTables: jest.fn(),
}))

jest.mock("@/lib/plugin/core/mirrored-client", () => ({
  isMirroredPluginClient: jest.fn(() => false),
}))

// The purge must never reach the uninstall authority.
jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: jest.fn(() => ({ uninstallPlugin: jest.fn() })),
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

// Mock next-intl so we don't need a provider in unit tests.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import { clearPluginTables } from "@/lib/plugin/dexie/bridge"
import { isMirroredPluginClient } from "@/lib/plugin/core/mirrored-client"
import { getPluginManager } from "@/lib/plugin/core/manager"

const useLiveQueryMock = useLiveQuery as jest.Mock
const clearPluginTablesMock = clearPluginTables as jest.Mock
const isMirroredMock = isMirroredPluginClient as jest.Mock

const githubMeta = {
  pluginId: "github-delivery",
  tableNames: ["github-delivery:repos", "github-delivery:events"],
  dexieVersion: 28,
  appliedAt: 1,
}

beforeEach(() => {
  jest.clearAllMocks()
  isMirroredMock.mockReturnValue(false)
})

async function confirmDelete(pluginId: string) {
  const user = userEvent.setup()
  await user.click(screen.getByTestId(`delete-data-${pluginId}`))
  const dialog = await screen.findByRole("alertdialog")
  await user.click(within(dialog).getByRole("button", { name: "deleteDialog.confirm" }))
}

describe("PluginDataManagement", () => {
  it("shows the all-plugins empty state when no plugins have registered tables", () => {
    useLiveQueryMock.mockReturnValue([])
    render(<PluginDataManagement />)
    expect(screen.getByText("emptyForAll")).toBeInTheDocument()
    expect(screen.queryByText("emptyForPlugin")).not.toBeInTheDocument()
  })

  it("shows the single-plugin empty state when pluginId is set but no row returns", () => {
    useLiveQueryMock.mockReturnValue([])
    render(<PluginDataManagement pluginId="github-delivery" />)
    expect(screen.getByText("emptyForPlugin")).toBeInTheDocument()
    expect(screen.queryByText("emptyForAll")).not.toBeInTheDocument()
  })

  it("renders the empty state as plain text, not a box", () => {
    useLiveQueryMock.mockReturnValue([])
    const { container } = render(<PluginDataManagement pluginId="github-delivery" />)
    expect(container.querySelector("[data-slot='card']")).toBeNull()
    expect(container.querySelector(".border-dashed")).toBeNull()
  })

  it("renders one divided row per plugin meta row (list mode) with logical table names", () => {
    useLiveQueryMock.mockReturnValue([
      githubMeta,
      {
        pluginId: "another-plugin",
        tableNames: ["another-plugin:foo"],
        dexieVersion: 28,
        appliedAt: 1,
      },
    ])
    render(<PluginDataManagement />)
    expect(screen.getByTestId("plugin-data-management-list")).toBeInTheDocument()
    expect(screen.getByText("github-delivery")).toBeInTheDocument()
    expect(screen.getByText("repos")).toHaveAttribute("title", "github-delivery:repos")
    expect(screen.getByText("events")).toBeInTheDocument()
    expect(screen.getByText("another-plugin")).toBeInTheDocument()
    expect(screen.getByText('tableCount:{"count":2}')).toBeInTheDocument()
  })

  it("uses the single-mode testid and omits the repeated plugin id", () => {
    useLiveQueryMock.mockReturnValue([githubMeta])
    render(<PluginDataManagement pluginId="github-delivery" />)
    expect(screen.getByTestId("plugin-data-management-single")).toBeInTheDocument()
    expect(screen.queryByTestId("plugin-data-management-list")).not.toBeInTheDocument()
    expect(screen.queryByText("github-delivery")).not.toBeInTheDocument()
    expect(screen.getByText("repos")).toBeInTheDocument()
  })

  it("gives the Delete data button a phone-sized hit area", () => {
    useLiveQueryMock.mockReturnValue([githubMeta])
    render(<PluginDataManagement />)
    const button = screen.getByTestId("delete-data-github-delivery")
    expect(button).toHaveTextContent("deleteButton")
    expect(button).toHaveClass("pointer-coarse:h-10")
  })

  it("asks first, then clears the tables without uninstalling the plugin", async () => {
    useLiveQueryMock.mockReturnValue([githubMeta])
    clearPluginTablesMock.mockResolvedValue(githubMeta.tableNames)
    render(<PluginDataManagement pluginId="github-delivery" />)

    await confirmDelete("github-delivery")

    await waitFor(() => expect(clearPluginTablesMock).toHaveBeenCalledTimes(1))
    expect(clearPluginTablesMock.mock.calls[0][1]).toBe("github-delivery")
    expect(getPluginManager).not.toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith('purged:{"pluginId":"github-delivery","count":2}')
  })

  it("does nothing when the confirmation is cancelled", async () => {
    useLiveQueryMock.mockReturnValue([githubMeta])
    render(<PluginDataManagement pluginId="github-delivery" />)
    const user = userEvent.setup()
    await user.click(screen.getByTestId("delete-data-github-delivery"))
    const dialog = await screen.findByRole("alertdialog")
    await user.click(within(dialog).getByRole("button", { name: "deleteDialog.cancel" }))
    expect(clearPluginTablesMock).not.toHaveBeenCalled()
  })

  it("toasts the failure with its reason instead of only logging it", async () => {
    useLiveQueryMock.mockReturnValue([githubMeta])
    clearPluginTablesMock.mockRejectedValue(new Error("QuotaExceededError"))
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {})
    render(<PluginDataManagement pluginId="github-delivery" />)

    await confirmDelete("github-delivery")

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('purgeFailed:{"pluginId":"github-delivery"}', {
        description: "QuotaExceededError",
      })
    )
    expect(toast.success).not.toHaveBeenCalled()
    // The button settles back to idle so the user can retry.
    await waitFor(() =>
      expect(screen.getByTestId("delete-data-github-delivery")).not.toBeDisabled()
    )
    consoleError.mockRestore()
  })

  it("refuses on a mirrored client and says why inline", () => {
    isMirroredMock.mockReturnValue(true)
    useLiveQueryMock.mockReturnValue([githubMeta])
    render(<PluginDataManagement pluginId="github-delivery" />)
    expect(screen.getByTestId("plugin-data-management-blocked")).toHaveTextContent(
      "mirroredBlocked"
    )
    expect(screen.getByTestId("delete-data-github-delivery")).toBeDisabled()
  })

  it("shows a placeholder, not the empty state, while registrations load", () => {
    useLiveQueryMock.mockReturnValue(undefined)
    render(<PluginDataManagement />)
    expect(screen.getByTestId("plugin-data-management-loading")).toHaveAttribute(
      "aria-busy",
      "true"
    )
    expect(screen.queryByText("emptyForAll")).not.toBeInTheDocument()
  })
})
