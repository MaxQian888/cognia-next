/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
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
jest.mock("../components/agent-flow-card", () => ({
  AgentFlowCard: () => <div data-testid="agent-flow-card" />,
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
  it("renders density, radius, agent-flow, and usage-display sections", () => {
    render(<LayoutTab />)
    expect(screen.getByTestId("density-card")).toBeInTheDocument()
    expect(screen.getByTestId("agent-flow-card")).toBeInTheDocument()
    expect(screen.getByTestId("usage-display-card")).toBeInTheDocument()
    expect(screen.getByText("radius.sectionLabel")).toBeInTheDocument()
  })

  it("restores the default corner radius via the slider-row reset", () => {
    storeState.settings = { radius: { base: 1.2 } }
    render(<LayoutTab />)
    fireEvent.click(screen.getByLabelText("resetToDefault"))
    expect(save).toHaveBeenCalledWith({ radius: { base: 0.625 } })
  })
})
