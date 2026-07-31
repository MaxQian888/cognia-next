/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import MobileWorkflowsSettingsPage from "./page"
import { useSettingsPatch } from "@/hooks/use-settings-patch"
import { useSettingsStore } from "@/stores/settings"

jest.mock("@/hooks/use-settings-patch")
jest.mock("@/stores/settings", () => ({ useSettingsStore: jest.fn() }))

const updateMock = jest.fn(async () => undefined)

const mockSettings = (settings: Record<string, unknown> | undefined) =>
  (useSettingsStore as unknown as jest.Mock).mockImplementation(
    (selector: (s: { settings: unknown }) => unknown) => selector({ settings })
  )

// Radix Select relies on DOM APIs jsdom doesn't implement.
beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {}
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
})

beforeEach(() => {
  jest.clearAllMocks()
  ;(useSettingsPatch as jest.Mock).mockReturnValue(updateMock)
  mockSettings({ workflowEditorPerformanceTier: "balanced" })
})

describe("MobileWorkflowsSettingsPage", () => {
  it("renders the shell with the performance-tier control", () => {
    render(<MobileWorkflowsSettingsPage />)
    expect(screen.getByTestId("mobile-workflows-settings-page")).toBeInTheDocument()
    expect(screen.getByTestId("workflow-perf-tier")).toBeInTheDocument()
  })

  it("reflects the persisted tier", () => {
    render(<MobileWorkflowsSettingsPage />)
    expect(screen.getByTestId("workflow-perf-tier")).toHaveTextContent("Balanced")
  })

  it("falls back to Auto when the tier is unset or invalid", () => {
    mockSettings({})
    render(<MobileWorkflowsSettingsPage />)
    expect(screen.getByTestId("workflow-perf-tier")).toHaveTextContent("Auto")
  })

  it("writes the chosen tier through the patch hook", async () => {
    render(<MobileWorkflowsSettingsPage />)
    fireEvent.click(screen.getByTestId("workflow-perf-tier"))
    const option = await screen.findByRole("option", { name: "Reduced" })
    fireEvent.click(option)
    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith({ workflowEditorPerformanceTier: "reduced" })
    )
  })
})
