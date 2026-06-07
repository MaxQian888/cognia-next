/**
 * Tests for the Behavior card (Settings → Automation → Overview).
 * `desktop.settingsGet/settingsSet` are mocked; the next-intl jest mock
 * resolves real English strings so queries use accessible names.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const settingsGet = jest.fn()
const settingsSet = jest.fn()
jest.mock("@/lib/automation/client", () => {
  const actual =
    jest.requireActual<typeof import("@/lib/automation/client")>("@/lib/automation/client")
  return {
    ...actual,
    desktop: {
      settingsGet: (...a: unknown[]) => settingsGet(...a),
      settingsSet: (...a: unknown[]) => settingsSet(...a),
    },
  }
})

import { defaultAutomationSettings } from "@/lib/automation/client"
import { BehaviorCard } from "./behavior-card"

beforeEach(() => {
  settingsGet.mockReset().mockResolvedValue(defaultAutomationSettings())
  settingsSet.mockReset().mockResolvedValue(undefined)
})

describe("BehaviorCard", () => {
  it("renders defaults: scaling off, dedup on, threshold 200", async () => {
    render(<BehaviorCard />)
    const scaling = await screen.findByRole("switch", { name: /downscale screenshots/i })
    expect(scaling).not.toBeChecked()
    expect(screen.getByRole("switch", { name: /skip unchanged screenshots/i })).toBeChecked()
    expect(screen.getByLabelText(/paste threshold/i)).toHaveValue(200)
    // Dimension inputs only appear once scaling is enabled.
    expect(screen.queryByLabelText(/max width/i)).not.toBeInTheDocument()
  })

  it("enabling scaling persists the full settings blob and reveals dimensions", async () => {
    render(<BehaviorCard />)
    const scaling = await screen.findByRole("switch", { name: /downscale screenshots/i })
    fireEvent.click(scaling)
    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledWith(
        expect.objectContaining({
          screenshotScaling: { enabled: true, maxWidth: 1280, maxHeight: 800 },
        })
      )
    )
    expect(await screen.findByLabelText(/max width/i)).toHaveValue(1280)
    expect(screen.getByLabelText(/max height/i)).toHaveValue(800)
  })

  it("dimension inputs clamp to their ranges and persist", async () => {
    settingsGet.mockResolvedValue({
      ...defaultAutomationSettings(),
      screenshotScaling: { enabled: true, maxWidth: 1280, maxHeight: 800 },
    })
    render(<BehaviorCard />)
    const width = await screen.findByLabelText(/max width/i)
    fireEvent.change(width, { target: { value: "9999" } })
    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledWith(
        expect.objectContaining({
          screenshotScaling: expect.objectContaining({ maxWidth: 3840 }),
        })
      )
    )
    const height = await screen.findByLabelText(/max height/i)
    fireEvent.change(height, { target: { value: "100" } })
    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledWith(
        expect.objectContaining({
          screenshotScaling: expect.objectContaining({ maxHeight: 240 }),
        })
      )
    )
  })

  it("toggling dedup persists", async () => {
    render(<BehaviorCard />)
    const dedup = await screen.findByRole("switch", { name: /skip unchanged screenshots/i })
    fireEvent.click(dedup)
    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledWith(expect.objectContaining({ screenshotDedup: false }))
    )
  })

  it("changing the paste threshold clamps to >= 0 and persists", async () => {
    render(<BehaviorCard />)
    const input = await screen.findByLabelText(/paste threshold/i)
    fireEvent.change(input, { target: { value: "-5" } })
    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledWith(expect.objectContaining({ pasteThresholdChars: 0 }))
    )
  })

  it("shows the load error inline when settingsGet rejects", async () => {
    settingsGet.mockRejectedValueOnce(new Error("UNSUPPORTED_PLATFORM"))
    render(<BehaviorCard />)
    expect(await screen.findByText(/UNSUPPORTED_PLATFORM/)).toBeInTheDocument()
  })

  it("stringifies non-Error load failures", async () => {
    settingsGet.mockRejectedValueOnce("raw-failure")
    render(<BehaviorCard />)
    expect(await screen.findByText(/raw-failure/)).toBeInTheDocument()
  })

  it("clearing a dimension input falls back to its default", async () => {
    settingsGet.mockResolvedValue({
      ...defaultAutomationSettings(),
      screenshotScaling: { enabled: true, maxWidth: 1280, maxHeight: 800 },
    })
    render(<BehaviorCard />)
    const width = await screen.findByLabelText(/max width/i)
    fireEvent.change(width, { target: { value: "" } })
    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledWith(
        expect.objectContaining({
          screenshotScaling: expect.objectContaining({ maxWidth: 1280 }),
        })
      )
    )
    const threshold = screen.getByLabelText(/paste threshold/i)
    fireEvent.change(threshold, { target: { value: "" } })
    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledWith(expect.objectContaining({ pasteThresholdChars: 0 }))
    )
  })

  it("shows a save error inline when settingsSet rejects", async () => {
    settingsSet.mockRejectedValueOnce(new Error("KILL_SWITCH_ACTIVE"))
    render(<BehaviorCard />)
    const dedup = await screen.findByRole("switch", { name: /skip unchanged screenshots/i })
    fireEvent.click(dedup)
    expect(await screen.findByText(/KILL_SWITCH_ACTIVE/)).toBeInTheDocument()
  })
})
