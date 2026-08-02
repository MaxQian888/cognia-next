/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

import { CursorPackGrid, packPreviewUrl } from "./cursor-pack-grid"
import { CURSOR_PACKS, CURSOR_PACKS_BY_ID } from "@/lib/appearance/cursor/cursor-packs"
import { SYSTEM_CURSOR_PACK_ID } from "@/types/appearance"

const AERO = CURSOR_PACKS_BY_ID.get("aero")!

function renderGrid(overrides: Partial<React.ComponentProps<typeof CursorPackGrid>> = {}) {
  const onSelect = jest.fn()
  render(
    <CursorPackGrid
      activePackId={SYSTEM_CURSOR_PACK_ID}
      colorMode="pack"
      accentColor="#7c3aed"
      onSelect={onSelect}
      {...overrides}
    />
  )
  return { onSelect }
}

describe("packPreviewUrl", () => {
  it("renders the pack's default glyph as an inline SVG data URL", () => {
    const url = packPreviewUrl(AERO, "pack", undefined, "#7c3aed")
    expect(url.startsWith("data:image/svg+xml,")).toBe(true)
  })

  it("previews the tint that will actually be applied, not the pack's own colors", () => {
    const packMode = packPreviewUrl(AERO, "pack", undefined, "#7c3aed")
    const accentMode = packPreviewUrl(AERO, "accent", undefined, "#7c3aed")
    expect(accentMode).not.toBe(packMode)
    expect(packPreviewUrl(AERO, "custom", "#00b894", "#7c3aed")).not.toBe(accentMode)
  })
})

describe("CursorPackGrid", () => {
  it("offers the system entry plus every built-in pack", () => {
    renderGrid()
    expect(screen.getByText("systemPack")).toBeInTheDocument()
    for (const pack of CURSOR_PACKS) {
      expect(screen.getByText(pack.name)).toBeInTheDocument()
      expect(screen.getByTestId(`cursor-pack-preview-${pack.id}`)).toBeInTheDocument()
    }
  })

  it("groups the packs by family so the anime set reads as a set", () => {
    renderGrid()
    expect(screen.getByText("families.anime")).toBeInTheDocument()
    expect(screen.getByText("families.classic")).toBeInTheDocument()
    expect(screen.getByText("families.playful")).toBeInTheDocument()
  })

  it("marks exactly one card as pressed", () => {
    renderGrid({ activePackId: "sakura" })
    const pressed = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-pressed") === "true")
    expect(pressed).toHaveLength(1)
    expect(pressed[0]).toHaveTextContent("Sakura")
  })

  it("reports the chosen pack id", () => {
    const { onSelect } = renderGrid()
    fireEvent.click(screen.getByText("Neko"))
    expect(onSelect).toHaveBeenCalledWith("neko")
  })

  it("reports the system sentinel when the system card is chosen", () => {
    const { onSelect } = renderGrid({ activePackId: "aero" })
    fireEvent.click(screen.getByText("systemPack"))
    expect(onSelect).toHaveBeenCalledWith(SYSTEM_CURSOR_PACK_ID)
  })

  it("shows no glyph for the system entry — the OS cursor is not ours to draw", () => {
    renderGrid()
    expect(screen.getByText("systemPackHint")).toBeInTheDocument()
  })
})
