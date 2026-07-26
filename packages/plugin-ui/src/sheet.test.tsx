import type * as React from "react"
import { render, screen } from "@testing-library/react"
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
