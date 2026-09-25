import type * as React from "react"
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./sheet"

/**
 * Radix dialogs ignore `fireEvent.click` (their triggers gate on pointer-event
 * detail), so every open/close path here goes through userEvent — see the
 * repo's jest-gotchas note on Radix + RTL.
 */
function renderSheet(props: Partial<React.ComponentProps<typeof SheetContent>> = {}) {
  return render(
    <Sheet>
      <SheetTrigger>Open panel</SheetTrigger>
      <SheetContent {...props}>
        <SheetHeader>
          <SheetTitle>Deploy settings</SheetTitle>
          <SheetDescription>Choose a target environment.</SheetDescription>
        </SheetHeader>
        <SheetFooter>
          <SheetClose>Dismiss</SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

const root = () => document.documentElement
const originalMatchMedia = window.matchMedia

function stubOsReducedMotion(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
}

afterEach(() => {
  root().classList.remove("reduce-motion")
  root().removeAttribute("data-reduce-motion")
  root().removeAttribute("data-motion-respect")
  window.matchMedia = originalMatchMedia
})

async function openSheet(props: Partial<React.ComponentProps<typeof SheetContent>> = {}) {
  const user = userEvent.setup()
  renderSheet(props)
  await user.click(screen.getByRole("button", { name: "Open panel" }))
  return screen.findByRole("dialog")
}

const OPEN_TIMING = [
  "data-[state=open]:ease-out",
  "data-[state=open]:[animation-duration:calc(250ms*var(--motion-duration-scale,1))]",
]
const CLOSE_TIMING = [
  "data-[state=closed]:ease-in",
  "data-[state=closed]:[animation-duration:calc(200ms*var(--motion-duration-scale,1))]",
]

describe("Sheet", () => {
  it("stays closed until the trigger is activated, then names the dialog from its title", async () => {
    const user = userEvent.setup()
    renderSheet()

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Open panel" }))

    // Radix derives the accessible name from SheetTitle and the description
    // from SheetDescription — this asserts both wirings at once.
    const dialog = await screen.findByRole("dialog", { name: "Deploy settings" })
    expect(dialog).toHaveAttribute("data-slot", "sheet-content")
    expect(dialog).toHaveAccessibleDescription("Choose a target environment.")
  })

  it("closes again from the built-in close button", async () => {
    const user = userEvent.setup()
    renderSheet()

    await user.click(screen.getByRole("button", { name: "Open panel" }))
    await screen.findByRole("dialog")

    await user.click(screen.getByRole("button", { name: "Close" }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("closes from a caller-rendered SheetClose", async () => {
    const user = userEvent.setup()
    renderSheet()

    await user.click(screen.getByRole("button", { name: "Open panel" }))
    await screen.findByRole("dialog")

    await user.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  /**
   * The host's copy hard-codes "Close" in the sr-only span. A plugin cannot
   * reach the app's next-intl catalog, so the label has to be injectable or the
   * button is permanently English for every locale.
   */
  it("labels the close button from closeLabel, defaulting to Close", async () => {
    const user = userEvent.setup()
    const { unmount } = renderSheet()

    await user.click(screen.getByRole("button", { name: "Open panel" }))
    expect(await screen.findByRole("button", { name: "Close" })).toBeInTheDocument()
    unmount()

    renderSheet({ closeLabel: "关闭" })
    await user.click(screen.getByRole("button", { name: "Open panel" }))
    expect(await screen.findByRole("button", { name: "关闭" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument()
  })

  it("gives the close button a 36px target on a coarse pointer and a keyboard-only ring", async () => {
    const user = userEvent.setup()
    renderSheet()
    await user.click(screen.getByRole("button", { name: "Open panel" }))
    const close = await screen.findByRole("button", { name: "Close" })
    expect(close).toHaveClass("size-7", "pointer-coarse:size-9", "focus-visible:ring-2")
    expect(close.className).not.toMatch(/(^|\s)focus:ring-2/)
  })

  it("omits the close button when showCloseButton is false", async () => {
    const user = userEvent.setup()
    renderSheet({ showCloseButton: false })

    await user.click(screen.getByRole("button", { name: "Open panel" }))
    await screen.findByRole("dialog")

    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument()
    // The caller's own close affordance is untouched by the flag.
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument()
  })

  it("anchors to the right edge by default", async () => {
    const user = userEvent.setup()
    renderSheet()

    await user.click(screen.getByRole("button", { name: "Open panel" }))
    expect((await screen.findByRole("dialog")).className).toContain("right-0")
  })

  it.each([
    ["left", "left-0"],
    ["top", "top-0"],
    ["bottom", "bottom-0"],
  ] as const)("anchors to the %s edge when asked", async (side, anchor) => {
    const user = userEvent.setup()
    renderSheet({ side })

    await user.click(screen.getByRole("button", { name: "Open panel" }))
    expect((await screen.findByRole("dialog")).className).toContain(anchor)
  })

  it("reserves the home-indicator inset on a bottom sheet", async () => {
    const user = userEvent.setup()
    renderSheet({ side: "bottom" })

    await user.click(screen.getByRole("button", { name: "Open panel" }))
    // Bottom sheets sit flush against the screen edge — this inset is what
    // keeps a footer row tappable on a notched device.
    expect((await screen.findByRole("dialog")).className).toContain(
      "pb-[env(safe-area-inset-bottom)]"
    )
  })

  it("merges caller classes rather than appending a conflicting utility", async () => {
    const user = userEvent.setup()
    renderSheet({ className: "gap-8" })

    await user.click(screen.getByRole("button", { name: "Open panel" }))
    const dialog = await screen.findByRole("dialog")
    expect(dialog.className).toContain("gap-8")
    // cn() resolved gap-4 vs gap-8 instead of emitting both.
    expect(dialog.className).not.toContain("gap-4")
  })

  it("tags header and footer with their slots so a plugin can restyle them", async () => {
    const user = userEvent.setup()
    renderSheet()

    await user.click(screen.getByRole("button", { name: "Open panel" }))
    await screen.findByRole("dialog")

    expect(screen.getByText("Deploy settings").closest("[data-slot=sheet-header]")).not.toBeNull()
    expect(screen.getByRole("button", { name: "Dismiss" })).toHaveAttribute(
      "data-slot",
      "sheet-close"
    )
    expect(
      screen.getByRole("button", { name: "Dismiss" }).closest("[data-slot=sheet-footer]")
    ).not.toBeNull()
  })

  it("renders an overlay above the page while open", async () => {
    const user = userEvent.setup()
    renderSheet()

    await user.click(screen.getByRole("button", { name: "Open panel" }))
    await screen.findByRole("dialog")

    // The overlay is presentational (no role), so it is queried by slot — it is
    // the reason a plugin's sheet visually owns the whole window even though
    // the plugin itself is confined to one slot.
    expect(document.querySelector("[data-slot=sheet-overlay]")).not.toBeNull()
  })
})

/**
 * Timing is part of the plugin contract: a plugin's sheet opens beside the
 * host's own, and a slower one reads as lag. Open ≈250ms decelerating, close
 * ≈200ms, both through the host's speed variable so the user's setting holds.
 */
describe("Sheet motion", () => {
  it("opens in 250ms ease-out and closes in 200ms, scaled by the host speed", async () => {
    const tokens = (await openSheet()).className.split(/\s+/)
    for (const token of [...OPEN_TIMING, ...CLOSE_TIMING]) expect(tokens).toContain(token)
    // The old 500ms / 300ms pair must not linger alongside the new one.
    expect(tokens.join(" ")).not.toMatch(/500ms|300ms/)
  })

  it("times the overlay with the panel so the scrim and sheet land together", async () => {
    await openSheet()
    const overlay = document.querySelector("[data-slot=sheet-overlay]") as HTMLElement
    const tokens = overlay.className.split(/\s+/)
    for (const token of [...OPEN_TIMING, ...CLOSE_TIMING]) expect(tokens).toContain(token)
  })

  it("slides in from its edge when motion is allowed", async () => {
    const dialog = await openSheet({ side: "left" })
    expect(dialog.className).toContain("data-[state=open]:slide-in-from-left")
    expect(dialog.className).toContain("data-[state=closed]:slide-out-to-left")
    expect(dialog.className).not.toContain("fade-in-0")
  })

  it.each([
    ["the in-app class", () => root().classList.add("reduce-motion")],
    ["data-reduce-motion", () => root().setAttribute("data-reduce-motion", "true")],
    ["the OS hint", () => stubOsReducedMotion(true)],
  ])("fades instead of sliding under %s", async (_label, reduce) => {
    reduce()
    const dialog = await openSheet({ side: "bottom" })
    expect(dialog.className).not.toContain("slide-in-from-bottom")
    expect(dialog.className).not.toContain("slide-out-to-bottom")
    expect(dialog.className).toContain("data-[state=open]:fade-in-0")
    expect(dialog.className).toContain("data-[state=closed]:fade-out-0")
    // Anchoring is layout, not motion — it must not move with the preference.
    expect(dialog.className).toContain("bottom-0")
  })

  it('keeps the slide under the OS hint when data-motion-respect="off"', async () => {
    stubOsReducedMotion(true)
    root().setAttribute("data-motion-respect", "off")
    const dialog = await openSheet()
    expect(dialog.className).toContain("data-[state=open]:slide-in-from-right")
  })

  it("drops the slide when the setting flips while the sheet is open", async () => {
    const dialog = await openSheet()
    expect(dialog.className).toContain("slide-in-from-right")
    await act(async () => {
      root().classList.add("reduce-motion")
    })
    expect(dialog.className).not.toContain("slide-in-from-right")
    expect(dialog.className).toContain("data-[state=open]:fade-in-0")
  })
})
