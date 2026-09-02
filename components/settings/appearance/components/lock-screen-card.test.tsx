/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"

import { LockScreenCard, LOW_DIM_THRESHOLD } from "./lock-screen-card"
import { DEFAULT_LOCK_SCREEN, type LockScreenSettings } from "@/types/appearance/lock-screen"
import type { Wallpaper } from "@/types/appearance"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

function image(id: string, name: string): Wallpaper {
  return {
    id,
    name,
    kind: "image",
    source: {
      kind: "image",
      storage: "data-url",
      dataUrl: "data:image/png;base64,xx",
      mime: "image/png",
      width: 4,
      height: 4,
    },
    builtin: false,
    createdAt: 0,
  }
}

const gallery = [image("wp-1", "Aurora"), image("wp-2", "Harbour")]

function renderCard(patch: Partial<LockScreenSettings> = {}, wallpapers = gallery) {
  const onChange = jest.fn()
  render(
    <LockScreenCard
      settings={{ ...DEFAULT_LOCK_SCREEN, ...patch }}
      gallery={wallpapers}
      onChange={onChange}
    />
  )
  return { onChange }
}

describe("LockScreenCard", () => {
  it("hides the image controls for a backdrop with no image", () => {
    renderCard({ backdrop: "theme" })
    expect(screen.queryByTestId("lock-image-controls")).not.toBeInTheDocument()
  })

  it("shows blur and dim for an image backdrop", () => {
    renderCard({ backdrop: "wallpaper" })
    expect(screen.getByTestId("lock-blur")).toBeInTheDocument()
    expect(screen.getByTestId("lock-dim")).toBeInTheDocument()
  })

  it("offers a wallpaper picker only for the pinned backdrop", () => {
    renderCard({ backdrop: "wallpaper" })
    expect(screen.queryByTestId("lock-pinned")).not.toBeInTheDocument()
  })

  it("shows the picker when a specific wallpaper is chosen", () => {
    renderCard({ backdrop: "pinned" })
    expect(screen.getByTestId("lock-pinned")).toBeInTheDocument()
  })

  it("says so when there is nothing to pin", () => {
    renderCard({ backdrop: "pinned" }, [])
    expect(screen.getByText("pinnedEmpty")).toBeInTheDocument()
  })

  it("offers a colour input only for the solid backdrop", () => {
    renderCard({ backdrop: "solid" })
    expect(screen.getByTestId("lock-solid-color")).toBeInTheDocument()
  })

  it("warns when the dim is too low to keep the card readable", () => {
    // The failure case the dim exists to prevent: a bright photograph behind
    // a password field.
    renderCard({ backdrop: "wallpaper", dim: LOW_DIM_THRESHOLD - 0.05 })
    const hint = screen.getByTestId("lock-dim-hint")
    expect(hint).toHaveTextContent("dimTooLow")
    expect(hint).toHaveAttribute("role", "status")
  })

  it("does not warn at a safe dim", () => {
    renderCard({ backdrop: "wallpaper", dim: 0.5 })
    expect(screen.getByTestId("lock-dim-hint")).toHaveTextContent("dimHint")
  })

  it("never warns about dim on a backdrop with no image", () => {
    renderCard({ backdrop: "theme", dim: 0 })
    expect(screen.queryByTestId("lock-dim-hint")).not.toBeInTheDocument()
  })

  it("hides the hour format until there is a clock", () => {
    renderCard({ clock: "none" })
    expect(screen.queryByTestId("lock-hour-cycle")).not.toBeInTheDocument()
  })

  it("shows the hour format once a clock is on", () => {
    renderCard({ clock: "time" })
    expect(screen.getByTestId("lock-hour-cycle")).toBeInTheDocument()
  })

  it("shows the custom greeting field only for custom text", () => {
    renderCard({ greeting: "timeOfDay" })
    expect(screen.queryByTestId("lock-custom-greeting")).not.toBeInTheDocument()
  })

  it("normalises a custom greeting as it is typed", () => {
    const { onChange } = renderCard({ greeting: "custom" })
    fireEvent.change(screen.getByTestId("lock-custom-greeting"), {
      target: { value: "   welcome back   " },
    })
    expect(onChange).toHaveBeenCalledWith({ customGreeting: "welcome back" })
  })

  it("hides the motion opt-out while motion is off", () => {
    // "Respect reduced motion" is meaningless with no motion to reduce.
    renderCard({ motion: "none" })
    expect(screen.queryByTestId("lock-respect-motion")).not.toBeInTheDocument()
  })

  it("offers the motion opt-out once motion is on", () => {
    renderCard({ motion: "aurora" })
    expect(screen.getByTestId("lock-respect-motion")).toBeInTheDocument()
  })

  it("forwards the avatar toggle", () => {
    const { onChange } = renderCard({ showAvatar: true })
    fireEvent.click(screen.getByTestId("lock-show-avatar"))
    expect(onChange).toHaveBeenCalledWith({ showAvatar: false })
  })
})
