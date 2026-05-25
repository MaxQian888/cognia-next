/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { PluginSourceBadge } from "./plugin-source-badge"

describe("PluginSourceBadge", () => {
  it("renders the localized source label and a source-scoped testid", () => {
    render(<PluginSourceBadge source="builtin" />)
    expect(screen.getByText("builtin")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-source-badge-builtin")).toBeInTheDocument()
  })

  it("forwards className", () => {
    render(<PluginSourceBadge source="builtin" className="custom-cls" />)
    expect(screen.getByTestId("plugin-source-badge-builtin")).toHaveClass("custom-cls")
  })
})
