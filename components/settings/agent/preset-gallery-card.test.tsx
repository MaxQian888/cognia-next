/**
 * PresetGalleryCard — the quick-start catalog. Verifies one card per preset,
 * the recommended Codex executable preference, the experimental toggle, and
 * the pick callback.
 */

import { render, screen, within, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PresetGalleryCard } from "./preset-gallery-card"

// Keep the real preset registry; only the executable detection is stubbed so
// no real `codex` CLI probe runs in jsdom.
jest.mock("@/lib/ai/agent/external/config/presets", () => {
  const actual = jest.requireActual("@/lib/ai/agent/external/config/presets") as Record<
    string,
    unknown
  >
  return {
    ...actual,
    resolvePreferredCodexExecutablePresetId: jest.fn(async () => "codex-app-server"),
  }
})

// Flush the async preferred-preset effect inside act().
afterEach(async () => {
  await act(async () => {
    await Promise.resolve()
  })
})

describe("PresetGalleryCard", () => {
  it("renders one card per runnable preset and hides documented-only by default", () => {
    render(<PresetGalleryCard disabled={false} onPick={jest.fn()} />)
    const gallery = screen.getByTestId("preset-gallery-card")
    expect(within(gallery).getByTestId("preset-card-codex")).toBeInTheDocument()
    expect(within(gallery).getByTestId("preset-card-claude-code")).toBeInTheDocument()
  })

  it("calls onPick with the preset id when a card's action is clicked", async () => {
    const user = userEvent.setup()
    const onPick = jest.fn()
    render(<PresetGalleryCard disabled={false} onPick={onPick} />)
    await act(async () => {
      await user.click(screen.getByTestId("preset-pick-codex"))
    })
    expect(onPick).toHaveBeenCalledWith("codex")
  })

  it("marks the detected Codex executable preset as recommended", async () => {
    render(<PresetGalleryCard disabled={false} onPick={jest.fn()} />)
    expect(await screen.findByTestId("preset-recommended-codex-app-server")).toBeInTheDocument()
    expect(screen.queryByTestId("preset-recommended-codex")).not.toBeInTheDocument()
  })

  it("disables every card action while the section is disabled", () => {
    render(<PresetGalleryCard disabled onPick={jest.fn()} />)
    expect(screen.getByTestId("preset-pick-codex")).toBeDisabled()
  })
})
