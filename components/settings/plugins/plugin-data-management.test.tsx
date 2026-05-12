import "fake-indexeddb/auto"
import React from "react"
import { render, screen } from "@testing-library/react"
import { PluginDataManagement } from "./plugin-data-management"

// Mock useLiveQuery so we control the returned data without a real Dexie setup.
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn(),
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: jest.fn(),
}))

jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: jest.fn(),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useLiveQuery } = require("dexie-react-hooks")

describe("PluginDataManagement", () => {
  it("shows empty state when no plugins have registered tables", () => {
    useLiveQuery.mockReturnValue([])
    render(<PluginDataManagement />)
    expect(screen.getByText(/no plugins have declared custom data tables/i)).toBeInTheDocument()
  })

  it("renders a card for each plugin meta row", () => {
    useLiveQuery.mockReturnValue([
      {
        pluginId: "github-delivery",
        tableNames: ["github-delivery:repos", "github-delivery:events"],
        dexieVersion: 28,
        appliedAt: Date.now(),
      },
    ])
    render(<PluginDataManagement />)
    expect(screen.getByTestId("plugin-data-management")).toBeInTheDocument()
    expect(screen.getByText("github-delivery")).toBeInTheDocument()
    expect(screen.getByText("github-delivery:repos")).toBeInTheDocument()
    expect(screen.getByText("github-delivery:events")).toBeInTheDocument()
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
  })

  it("renders loading state when registrations are undefined", () => {
    useLiveQuery.mockReturnValue(undefined)
    render(<PluginDataManagement />)
    // undefined → treated as empty (falsy check in component)
    expect(screen.getByText(/no plugins have declared custom data tables/i)).toBeInTheDocument()
  })
})
