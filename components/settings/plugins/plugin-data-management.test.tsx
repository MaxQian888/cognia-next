import "fake-indexeddb/auto"
import React from "react"
import { render, screen } from "@testing-library/react"
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

jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: jest.fn(),
}))

// Mock next-intl so we don't need a provider in unit tests.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && typeof vars.pluginId === "string") return `${key}:${vars.pluginId}`
    return key
  },
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useLiveQuery } = require("dexie-react-hooks")

describe("PluginDataManagement", () => {
  it("shows the all-plugins empty state when no plugins have registered tables", () => {
    useLiveQuery.mockReturnValue([])
    render(<PluginDataManagement />)
    expect(screen.getByText("emptyForAll")).toBeInTheDocument()
    expect(screen.queryByText("emptyForPlugin")).not.toBeInTheDocument()
  })

  it("shows the single-plugin empty state when pluginId is set but no row returns", () => {
    useLiveQuery.mockReturnValue([])
    render(<PluginDataManagement pluginId="github-delivery" />)
    expect(screen.getByText("emptyForPlugin")).toBeInTheDocument()
    expect(screen.queryByText("emptyForAll")).not.toBeInTheDocument()
  })

  it("renders a card for each plugin meta row (list mode)", () => {
    useLiveQuery.mockReturnValue([
      {
        pluginId: "github-delivery",
        tableNames: ["github-delivery:repos", "github-delivery:events"],
        dexieVersion: 28,
        appliedAt: Date.now(),
      },
      {
        pluginId: "another-plugin",
        tableNames: ["another-plugin:foo"],
        dexieVersion: 28,
        appliedAt: Date.now(),
      },
    ])
    render(<PluginDataManagement />)
    expect(screen.getByTestId("plugin-data-management-list")).toBeInTheDocument()
    expect(screen.getByText("github-delivery")).toBeInTheDocument()
    expect(screen.getByText("github-delivery:repos")).toBeInTheDocument()
    expect(screen.getByText("github-delivery:events")).toBeInTheDocument()
    expect(screen.getByText("another-plugin")).toBeInTheDocument()
  })

  it("uses the single-mode testid when pluginId is provided", () => {
    useLiveQuery.mockReturnValue([
      {
        pluginId: "github-delivery",
        tableNames: ["github-delivery:repos"],
        dexieVersion: 28,
        appliedAt: Date.now(),
      },
    ])
    render(<PluginDataManagement pluginId="github-delivery" />)
    expect(screen.getByTestId("plugin-data-management-single")).toBeInTheDocument()
    expect(screen.queryByTestId("plugin-data-management-list")).not.toBeInTheDocument()
    expect(screen.getByText("github-delivery")).toBeInTheDocument()
  })

  it("renders a Delete data button for each plugin", () => {
    useLiveQuery.mockReturnValue([
      {
        pluginId: "github-delivery",
        tableNames: ["github-delivery:repos"],
        dexieVersion: 28,
        appliedAt: Date.now(),
      },
    ])
    render(<PluginDataManagement />)
    expect(screen.getByTestId("delete-data-github-delivery")).toBeInTheDocument()
    expect(screen.getByText("deleteButton")).toBeInTheDocument()
  })

  it("renders the all-plugins empty state when registrations are undefined (loading)", () => {
    useLiveQuery.mockReturnValue(undefined)
    render(<PluginDataManagement />)
    expect(screen.getByText("emptyForAll")).toBeInTheDocument()
  })
})
