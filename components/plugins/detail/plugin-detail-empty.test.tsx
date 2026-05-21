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

const mockTotals = {
  total: 5,
  enabled: 3,
  errored: 1,
  loading: 0,
  updateAvailable: 2,
}

jest.mock("@/hooks/plugins", () => ({
  usePlugins: () => ({ totals: mockTotals }),
}))

import { PluginDetailEmpty } from "./plugin-detail-empty"

describe("PluginDetailEmpty", () => {
  it("renders the title and description from i18n", () => {
    render(<PluginDetailEmpty />)
    expect(screen.getByText("emptyTitle")).toBeInTheDocument()
    expect(screen.getByText("emptyDescription")).toBeInTheDocument()
  })

  it("renders all summary badges when counts are non-zero", () => {
    render(<PluginDetailEmpty />)
    expect(screen.getByText("summaryTotal:5")).toBeInTheDocument()
    expect(screen.getByText("summaryEnabled:3")).toBeInTheDocument()
    expect(screen.getByText("summaryUpdates:2")).toBeInTheDocument()
    expect(screen.getByText("summaryErrored:1")).toBeInTheDocument()
  })

  it("hides updates/errored badges when their counts are zero", () => {
    mockTotals.errored = 0
    mockTotals.updateAvailable = 0
    render(<PluginDetailEmpty />)
    expect(screen.queryByText(/summaryErrored/)).not.toBeInTheDocument()
    expect(screen.queryByText(/summaryUpdates/)).not.toBeInTheDocument()
  })
})
