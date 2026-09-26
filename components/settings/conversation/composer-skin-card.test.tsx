/** @jest-environment jsdom */
import { act, render, screen, fireEvent } from "@testing-library/react"

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

// The pack supplies the DEFAULT skin (ADR-0148). A card that fell back to
// `classic` regardless reported a look nobody was seeing under Sharp — and
// greyed out the knobs that skin actually accepts.
describe("ComposerSkinCard — the active style pack supplies the default", () => {
  it("reports the pack's skin, not classic, when nothing is pinned", () => {
    mockSettings = { stylePack: { packId: "sharp" } }
    render(<ComposerSkinCard />)
    expect(resolvedSummary()).toContain("sharp")
    expect(resolvedSummary()).not.toContain("classic")
  })

  it("shows the pack skin's own hint and geometry", () => {
    mockSettings = { stylePack: { packId: "sharp" } }
    render(<ComposerSkinCard />)
    expect(screen.getByText("skins.sharp.hint")).toBeInTheDocument()
    // sharp is radius 0; classic's 16 would be the old lie.
    expect(resolvedSummary()).toContain(":0:")
  })

  it("leaves the knobs live under a non-classic pack default", () => {
    mockSettings = { stylePack: { packId: "sharp" } }
    render(<ComposerSkinCard />)
    expect(screen.getByTestId("skin-radius")).not.toHaveAttribute("aria-disabled", "true")
    expect(screen.getByText("adjustHint")).toBeInTheDocument()
  })

  it("lets an explicit choice beat the pack", () => {
    mockSettings = { composerBehavior: { skin: "airy" }, stylePack: { packId: "sharp" } }
    render(<ComposerSkinCard />)
    expect(resolvedSummary()).toContain("airy")
  })

  it("says the row is inherited only while nothing is pinned", () => {
    mockSettings = { stylePack: { packId: "sharp" } }
    const { unmount } = render(<ComposerSkinCard />)
    expect(screen.getByTestId("composer-skin-follows-pack")).toBeInTheDocument()
    unmount()

    mockSettings = { composerBehavior: { skin: "sharp" }, stylePack: { packId: "sharp" } }
    render(<ComposerSkinCard />)
    expect(screen.queryByTestId("composer-skin-follows-pack")).not.toBeInTheDocument()
  })

  it("treats a skin id this build does not know as inherited", () => {
    mockSettings = {
      composerBehavior: { skin: "from-the-future" as never },
      stylePack: { packId: "sharp" },
    }
    render(<ComposerSkinCard />)
    expect(resolvedSummary()).toContain("sharp")
    expect(screen.getByTestId("composer-skin-follows-pack")).toBeInTheDocument()
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

/**
 * Lets a real Radix slider be dragged in jsdom: pointer capture does not exist
 * there, and the track has no layout, so give it a width in pixels equal to
 * its range and each `clientX` lands on that value.
 */
function makeDraggable(root: HTMLElement, width: number): () => void {
  const proto = Element.prototype as unknown as Record<string, unknown>
  const saved = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"].map(
    (k) => [k, proto[k]] as const
  )
  proto.setPointerCapture = () => {}
  proto.releasePointerCapture = () => {}
  proto.hasPointerCapture = () => true
  root.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width, height: 8, right: width, bottom: 8, x: 0, y: 0 }) as DOMRect
  return () => saved.forEach(([k, v]) => (proto[k] = v))
}

describe("ComposerSkinCard — overrides", () => {
  it("saves a radius drag once, on release, not per frame", async () => {
    mockSettings = { composerBehavior: { skin: "airy", sendOnEnter: false } }
    render(<ComposerSkinCard />)
    const root = screen.getByTestId("skin-radius")
    const restore = makeDraggable(root, 32)
    try {
      fireEvent.pointerDown(root, { clientX: 4, pointerId: 1 })
      fireEvent.pointerMove(root, { clientX: 12, pointerId: 1 })
      fireEvent.pointerMove(root, { clientX: 20, pointerId: 1 })
      // Each frame used to be a save, and on a paired phone a queued update.
      expect(save).not.toHaveBeenCalled()
      await act(async () => {
        fireEvent.pointerUp(root, { clientX: 20, pointerId: 1 })
      })
    } finally {
      restore()
    }
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith({
      composerBehavior: { skin: "airy", sendOnEnter: false, skinOverrides: { radiusPx: 20 } },
    })
  })

  it("saves a padding keyboard step at once, to both axes", async () => {
    mockSettings = { composerBehavior: { skin: "airy", skinOverrides: { padXPx: 10, padYPx: 10 } } }
    render(<ComposerSkinCard />)
    const thumb = screen.getAllByRole("slider", { name: "paddingLabel" })[0]
    await act(async () => {
      fireEvent.keyDown(thumb, { key: "ArrowRight" })
    })
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0].composerBehavior.skinOverrides).toEqual({
      padXPx: 11,
      padYPx: 11,
    })
  })

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

  it("has copy for the follows-the-pack line in both locales", () => {
    for (const bundle of [en, zh]) {
      const skin = (
        bundle as unknown as {
          settings: { conversation: { composerSkin: Record<string, unknown> } }
        }
      ).settings.conversation.composerSkin
      expect(skin.followsPack).toEqual(expect.any(String))
    }
  })

  it.each(["classic", "airy", "dense", "full", "focus", "sharp"])(
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
