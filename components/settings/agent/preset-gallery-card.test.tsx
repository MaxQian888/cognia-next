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
  it("offers Kimi Code with subscription guidance and the native preset action", async () => {
    const onPick = jest.fn()
    render(<PresetGalleryCard disabled={false} onPick={onPick} />)
    const card = screen.getByTestId("preset-card-kimi")
    expect(card).toHaveTextContent("Kimi subscription login")
    await userEvent.click(within(card).getByRole("button"))
    expect(onPick).toHaveBeenCalledWith("kimi")
  })

  it("offers Cline's native ACP preset with localized guidance", async () => {
    const onPick = jest.fn()
    render(<PresetGalleryCard disabled={false} onPick={onPick} />)
    const card = screen.getByTestId("preset-card-cline")
    expect(card).toHaveTextContent("Plan/Act")
    await userEvent.click(within(card).getByRole("button"))
    expect(onPick).toHaveBeenCalledWith("cline")
  })

  it("offers Qoder's native ACP preset with localized guidance", async () => {
    const onPick = jest.fn()
    render(<PresetGalleryCard disabled={false} onPick={onPick} />)
    const card = screen.getByTestId("preset-card-qoder")
    expect(card).toHaveTextContent("Qoder Personal Access Token")
    await userEvent.click(within(card).getByRole("button"))
    expect(onPick).toHaveBeenCalledWith("qoder")
  })

  it("offers Aider with localized guidance and routes its action to the existing editor", async () => {
    const onPick = jest.fn()
    render(<PresetGalleryCard disabled={false} onPick={onPick} />)
    const card = screen.getByTestId("preset-card-aider")
    expect(card).toHaveTextContent("Aider")
    expect(card).toHaveTextContent("Run the official Aider CLI")
    await userEvent.click(within(card).getByRole("button"))
    expect(onPick).toHaveBeenCalledWith("aider")
  })

  it("offers Goose with localized guidance and routes its action to the existing editor", async () => {
    const onPick = jest.fn()
    render(<PresetGalleryCard disabled={false} onPick={onPick} />)
    const card = screen.getByTestId("preset-card-goose")
    expect(card).toHaveTextContent("Goose")
    expect(card).toHaveTextContent("Run Goose over native ACP")
    await userEvent.click(within(card).getByRole("button"))
    expect(onPick).toHaveBeenCalledWith("goose")
  })

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
