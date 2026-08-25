/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import type { AppSettings } from "@cognia/agent-config-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

const save = jest.fn()
const storeState: { settings: Partial<AppSettings> } = { settings: {} }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: jest.fn((selector: (s: unknown) => unknown) =>
    selector({ settings: storeState.settings, save })
  ),
}))

jest.mock("../components/density-card", () => ({
  DensityCard: () => <div data-testid="density-card" />,
}))
jest.mock("../components/message-display-card", () => ({
  MessageDisplayCard: () => <div data-testid="message-display-card" />,
}))
jest.mock("../components/usage-display-card", () => ({
  UsageDisplayCard: () => <div data-testid="usage-display-card" />,
}))

import { LayoutTab } from "./layout-tab"

beforeEach(() => {
  save.mockClear()
  storeState.settings = {}
})

describe("LayoutTab", () => {
  it("renders density, message-display, and usage-display sections", () => {
    render(<LayoutTab />)
    expect(screen.getByTestId("density-card")).toBeInTheDocument()
    expect(screen.getByTestId("message-display-card")).toBeInTheDocument()
    expect(screen.getByTestId("usage-display-card")).toBeInTheDocument()
  })

  // Corner radius moved to the Style panel (ADR-0148), where it reads as an
  // override on the active pack rather than a free-floating number. Two
  // controls writing `settings.radius` would let the panels disagree.
  it("no longer owns the corner-radius control", () => {
    render(<LayoutTab />)
    expect(screen.queryByText("radius.sectionLabel")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("resetToDefault")).not.toBeInTheDocument()
  })
})
