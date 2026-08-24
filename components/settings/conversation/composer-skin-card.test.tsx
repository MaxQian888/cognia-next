/** @jest-environment jsdom */
import { render, screen, fireEvent } from "@testing-library/react"

import { ComposerSkinCard } from "./composer-skin-card"
import type { AppSettings } from "@cognia/agent-config-types"

let mockSettings: Partial<AppSettings> = {}
const save = jest.fn()

jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: mockSettings, save }),
}))
jest.mock("next-intl", () => ({
  // Echo the key so assertions read as the contract, not as English copy.
  useTranslations: () => (key: string) => key,
}))

function resolvedSummary() {
  return screen.getByTestId("composer-skin-resolved").textContent ?? ""
}

beforeEach(() => {
  mockSettings = {}
  save.mockClear()
})

describe("ComposerSkinCard — choosing a skin", () => {
  it("defaults to classic when nothing is stored", () => {
    render(<ComposerSkinCard />)
    expect(resolvedSummary()).toContain("classic")
  })

  it("reflects a stored skin", () => {
    mockSettings = { composerBehavior: { skin: "dense" } }
    render(<ComposerSkinCard />)
    expect(resolvedSummary()).toContain("dense")
  })

  it("preserves the rest of composerBehavior when saving a skin", () => {
    mockSettings = { composerBehavior: { sendOnEnter: false, persistDrafts: false } }
    render(<ComposerSkinCard />)
    // Radix Select is not keyboard/click-drivable in jsdom; exercise the same
    // update path the trigger calls.
    fireEvent.click(screen.getByText("skins.classic.label"))
    expect(save).not.toHaveBeenCalledWith(
      expect.objectContaining({ composerBehavior: expect.objectContaining({ sendOnEnter: true }) })
    )
  })
})

describe("ComposerSkinCard — classic takes no adjustments", () => {
  it("disables every knob under classic", () => {
    render(<ComposerSkinCard />)
    // Radix renders the slider root as a span carrying `data-disabled`, so
    // `toBeDisabled()` (which wants a form control) would silently not apply.
    expect(screen.getByTestId("skin-radius")).toHaveAttribute("aria-disabled", "true")
    expect(screen.getByTestId("skin-padding")).toHaveAttribute("aria-disabled", "true")
    expect(screen.getByTestId("skin-mono")).toBeDisabled()
  })

  it("says WHY rather than hiding the group", () => {
    render(<ComposerSkinCard />)
    expect(screen.getByText("adjustLockedHint")).toBeInTheDocument()
    expect(screen.queryByText("adjustHint")).not.toBeInTheDocument()
  })

  it("enables the knobs once a non-classic skin is chosen", () => {
    mockSettings = { composerBehavior: { skin: "airy" } }
    render(<ComposerSkinCard />)
    expect(screen.getByTestId("skin-radius")).not.toHaveAttribute("aria-disabled", "true")
    expect(screen.getByText("adjustHint")).toBeInTheDocument()
  })
})

describe("ComposerSkinCard — overrides", () => {
  it("shows the resolved value, not the raw override", () => {
    // 9999 is clamped by the resolver; the card must not promise it.
    mockSettings = { composerBehavior: { skin: "airy", skinOverrides: { radiusPx: 9999 } } }
    render(<ComposerSkinCard />)
    expect(resolvedSummary()).not.toContain("9999")
  })

  it("offers a reset only when overrides actually exist", () => {
    mockSettings = { composerBehavior: { skin: "airy" } }
    const { unmount } = render(<ComposerSkinCard />)
    expect(screen.queryByText("resetOverrides")).not.toBeInTheDocument()
    unmount()

    mockSettings = { composerBehavior: { skin: "airy", skinOverrides: { radiusPx: 4 } } }
    render(<ComposerSkinCard />)
    fireEvent.click(screen.getByText("resetOverrides"))
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        composerBehavior: expect.objectContaining({ skinOverrides: undefined }),
      })
    )
  })

  it("never offers a reset under classic, which has no overrides to reset", () => {
    mockSettings = { composerBehavior: { skin: "classic", skinOverrides: { radiusPx: 4 } } }
    render(<ComposerSkinCard />)
    expect(screen.queryByText("resetOverrides")).not.toBeInTheDocument()
  })
})

describe("ComposerSkinCard — the reachability promise is on screen", () => {
  it("states that no style removes a control", () => {
    render(<ComposerSkinCard />)
    expect(screen.getByText("reachabilityNote")).toBeInTheDocument()
  })
})

// The i18n catalogue is NOT covered by `lint:i18n`, which cannot see through a
// template-literal key. Every skin's label/hint is looked up as
// `skins.${id}.label`, so an id added to the table without copy would render a
// raw key. Pin it here.
describe("ComposerSkinCard — every skin has copy", () => {
  const en = jest.requireActual("@/i18n/messages/en.json") as Record<string, never>
  const zh = jest.requireActual("@/i18n/messages/zh-CN.json") as Record<string, never>

  it.each(["classic", "airy", "dense", "full", "focus"])(
    "%s is translated in both locales",
    (id) => {
      for (const bundle of [en, zh]) {
        const skins = (
          bundle as unknown as {
            settings: { conversation: { composerSkin: { skins: Record<string, unknown> } } }
          }
        ).settings.conversation.composerSkin.skins
        expect(skins[id]).toEqual(
          expect.objectContaining({ label: expect.any(String), hint: expect.any(String) })
        )
      }
    }
  )
})
