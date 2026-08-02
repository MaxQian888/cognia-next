/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import type { AppSettings } from "@cognia/agent-config-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string, values?: Record<string, unknown>) =>
    values ? `${k}:${JSON.stringify(values)}` : k,
  useLocale: () => "en",
}))

jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: jest.fn(() => ({ reduce: false, durationScale: 1 })),
}))

jest.mock("@/lib/appearance/cursor/use-cursor-accent", () => ({
  useCursorAccentColor: jest.fn(() => "#7c3aed"),
}))

const save = jest.fn()
const storeState: { settings: Partial<AppSettings> } = { settings: {} }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: jest.fn((selector: (s: unknown) => unknown) =>
    selector({ settings: storeState.settings, save })
  ),
}))

import { CursorTab } from "./cursor-tab"
import { DEFAULT_CURSOR, SYSTEM_CURSOR_PACK_ID, type CursorSettings } from "@/types/appearance"

function setCursor(cursor: Partial<CursorSettings>) {
  storeState.settings = { cursor: { ...DEFAULT_CURSOR, ...cursor } }
}

/** The single patch the tab wrote. */
function patch(): CursorSettings {
  return (save.mock.calls[0][0] as { cursor: CursorSettings }).cursor
}

beforeEach(() => {
  save.mockReset()
  storeState.settings = {}
})

describe("CursorTab", () => {
  it("starts off, with the pack picker hidden", () => {
    render(<CursorTab />)
    expect(screen.getByLabelText("enabledLabel")).not.toBeChecked()
    expect(screen.queryByText("families.anime")).toBeNull()
  })

  it("moves off the system sentinel in the same write that enables the art", () => {
    // Enabling while still pointed at "system" would change nothing visible,
    // which reads as a broken switch.
    render(<CursorTab />)
    fireEvent.click(screen.getByLabelText("enabledLabel"))
    expect(patch().enabled).toBe(true)
    expect(patch().packId).not.toBe(SYSTEM_CURSOR_PACK_ID)
  })

  it("keeps an already-chosen pack when re-enabling", () => {
    setCursor({ enabled: false, packId: "sakura" })
    render(<CursorTab />)
    fireEvent.click(screen.getByLabelText("enabledLabel"))
    expect(patch().packId).toBe("sakura")
  })

  it("shows the pack picker and the role preview once enabled", () => {
    setCursor({ enabled: true, packId: "mahou" })
    render(<CursorTab />)
    expect(screen.getByText("families.anime")).toBeInTheDocument()
    expect(screen.getByTestId("cursor-role-preview")).toBeInTheDocument()
  })

  it("writes the chosen pack", () => {
    setCursor({ enabled: true, packId: "aero" })
    render(<CursorTab />)
    fireEvent.click(screen.getByText("Katana"))
    expect(patch().packId).toBe("katana")
  })

  it("explains the empty preview when the system cursor is selected", () => {
    setCursor({ enabled: true, packId: SYSTEM_CURSOR_PACK_ID })
    render(<CursorTab />)
    expect(screen.getByText("systemSelectedHint")).toBeInTheDocument()
    expect(screen.queryByTestId("cursor-role-preview")).toBeNull()
  })

  it("writes the pointer size slider", () => {
    setCursor({ enabled: true, packId: "aero", size: 1 })
    render(<CursorTab />)
    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" })
    expect(patch().size).toBe(1.25)
  })

  it("writes the pointer color mode", () => {
    setCursor({ enabled: true, packId: "aero", colorMode: "pack" })
    render(<CursorTab />)
    fireEvent.click(screen.getByRole("combobox"))
    fireEvent.click(screen.getByRole("option", { name: "colorModes.accent" }))
    expect(patch().colorMode).toBe("accent")
  })

  it("reveals the pointer color picker only in custom mode", () => {
    setCursor({ enabled: true, packId: "aero", colorMode: "pack" })
    const { unmount } = render(<CursorTab />)
    expect(screen.queryByLabelText("customColorLabel")).toBeNull()
    unmount()

    setCursor({ enabled: true, packId: "aero", colorMode: "custom" })
    render(<CursorTab />)
    fireEvent.change(screen.getByLabelText("customColorLabel"), {
      target: { value: "#00b894" },
    })
    expect(patch().customColor).toBe("#00b894")
  })

  it("keeps the effect card reachable even while the pointer art is off", () => {
    // The two are independent: sakura petals over the system cursor is a valid
    // configuration, and hiding the effect behind the art switch would deny it.
    render(<CursorTab />)
    expect(screen.getByText("kinds.petals")).toBeInTheDocument()
  })

  it("writes an effect change without disturbing the art settings", () => {
    setCursor({ enabled: true, packId: "sakura", size: 1.5 })
    render(<CursorTab />)
    fireEvent.click(screen.getByText("kinds.petals"))
    expect(patch()).toEqual(
      expect.objectContaining({
        enabled: true,
        packId: "sakura",
        size: 1.5,
        effect: expect.objectContaining({ kind: "petals" }),
      })
    )
  })
})
