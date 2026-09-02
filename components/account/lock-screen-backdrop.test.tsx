/** @jest-environment jsdom */

import { act, render, screen } from "@testing-library/react"

import { LockScreenBackdrop } from "./lock-screen-backdrop"
import { DEFAULT_LOCK_SCREEN, type LockScreenSettings } from "@/types/appearance/lock-screen"
import type { Wallpaper } from "@/types/appearance"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useFormatter: () => ({
    dateTime: (value: Date, options: Record<string, unknown>) =>
      options.weekday
        ? `DATE(${value.getDate()})`
        : `TIME(${value.getHours()})@${String(options.timeZone ?? "unset")}`,
  }),
}))

const resolveSourceToCss = jest.fn(async () => "url(wallpaper.png)")
jest.mock("@/lib/appearance/wallpaper-storage", () => ({
  resolveSourceToCss: (...a: unknown[]) => resolveSourceToCss(...a),
}))

jest.mock("@/lib/appearance/presets", () => ({
  withBuiltinPresets: (list: Wallpaper[]) => list,
}))

let reducedMotion = false
jest.mock("@/lib/appearance/reduced-motion", () => ({
  prefersReducedMotion: () => reducedMotion,
}))

const wallpaper: Wallpaper = {
  id: "wp-1",
  name: "Aurora",
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

async function renderBackdrop(
  settings: Partial<LockScreenSettings> = {},
  props: { activeWallpaperId?: string | null; wallpapers?: Wallpaper[]; now?: Date } = {}
) {
  await act(async () => {
    render(
      <LockScreenBackdrop
        settings={{ ...DEFAULT_LOCK_SCREEN, ...settings }}
        activeWallpaperId={props.activeWallpaperId ?? null}
        wallpapers={props.wallpapers ?? [wallpaper]}
        now={props.now ?? new Date(2026, 8, 3, 9, 30)}
      />
    )
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  reducedMotion = false
  resolveSourceToCss.mockResolvedValue("url(wallpaper.png)")
})

describe("LockScreenBackdrop", () => {
  it("paints nothing but the theme by default", async () => {
    await renderBackdrop()
    expect(screen.getByTestId("lock-screen-backdrop")).toHaveAttribute("data-backdrop", "theme")
    expect(screen.queryByTestId("lock-screen-backdrop-image")).not.toBeInTheDocument()
    expect(screen.queryByTestId("lock-screen-clock")).not.toBeInTheDocument()
  })

  it("shows the app's current wallpaper", async () => {
    await renderBackdrop({ backdrop: "wallpaper" }, { activeWallpaperId: "wp-1" })
    expect(screen.getByTestId("lock-screen-backdrop-image")).toBeInTheDocument()
  })

  it("shows a pinned wallpaper independently of the app's", async () => {
    await renderBackdrop(
      { backdrop: "pinned", pinnedWallpaperId: "wp-1" },
      { activeWallpaperId: null }
    )
    expect(screen.getByTestId("lock-screen-backdrop-image")).toBeInTheDocument()
  })

  it("falls back to the theme when the pinned wallpaper was deleted", async () => {
    // Being unable to see the unlock card is never an acceptable outcome of a
    // decoration setting.
    await renderBackdrop({ backdrop: "pinned", pinnedWallpaperId: "gone" })
    expect(screen.queryByTestId("lock-screen-backdrop-image")).not.toBeInTheDocument()
  })

  it("falls back to the theme when the image cannot be resolved", async () => {
    resolveSourceToCss.mockRejectedValue(new Error("missing blob"))
    await renderBackdrop({ backdrop: "wallpaper" }, { activeWallpaperId: "wp-1" })
    expect(screen.queryByTestId("lock-screen-backdrop-image")).not.toBeInTheDocument()
  })

  it("always dims an image backdrop", async () => {
    // The dim is what keeps a password field legible on a bright photograph.
    await renderBackdrop({ backdrop: "wallpaper", dim: 0.6 }, { activeWallpaperId: "wp-1" })
    expect(screen.getByTestId("lock-screen-backdrop-dim")).toHaveStyle({ opacity: "0.6" })
  })

  it("clamps an out-of-range dim rather than trusting it", async () => {
    await renderBackdrop({ backdrop: "solid", dim: 5 })
    expect(screen.getByTestId("lock-screen-backdrop-dim")).toHaveStyle({ opacity: "1" })
  })

  it("renders a solid colour backdrop", async () => {
    await renderBackdrop({ backdrop: "solid", solidColor: "#123456" })
    expect(screen.getByTestId("lock-screen-backdrop")).toHaveAttribute("data-backdrop", "solid")
    expect(screen.getByTestId("lock-screen-backdrop-dim")).toBeInTheDocument()
  })

  it("shows the time when asked", async () => {
    await renderBackdrop({ clock: "time" })
    expect(screen.getByTestId("lock-screen-time")).toHaveTextContent("TIME(9)")
    expect(screen.queryByTestId("lock-screen-date")).not.toBeInTheDocument()
  })

  it("pins the clock to the device timezone, so it cannot disagree with the greeting", async () => {
    // Before this, an app-level timezone could render "Good morning" above
    // 01:41 AM, because the greeting reads local hours and the clock did not.
    await renderBackdrop({ clock: "time", greeting: "timeOfDay" })
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(screen.getByTestId("lock-screen-time")).toHaveTextContent(`@${zone}`)
    expect(screen.getByTestId("lock-screen-greeting")).toHaveTextContent("greeting.morning")
  })

  it("adds the date for the fuller clock", async () => {
    await renderBackdrop({ clock: "timeAndDate" })
    expect(screen.getByTestId("lock-screen-date")).toHaveTextContent("DATE(3)")
  })

  it("greets by time of day", async () => {
    await renderBackdrop({ greeting: "timeOfDay" }, { now: new Date(2026, 8, 3, 9, 0) })
    expect(screen.getByTestId("lock-screen-greeting")).toHaveTextContent("greeting.morning")

    await renderBackdrop({ greeting: "timeOfDay" }, { now: new Date(2026, 8, 3, 23, 0) })
    expect(screen.getAllByTestId("lock-screen-greeting").at(-1)).toHaveTextContent("greeting.night")
  })

  it("renders a custom greeting as text", async () => {
    await renderBackdrop({ greeting: "custom", customGreeting: "<b>hi</b>" })
    const node = screen.getByTestId("lock-screen-greeting")
    expect(node).toHaveTextContent("<b>hi</b>")
    expect(node.querySelector("b")).toBeNull()
  })

  it("omits an empty custom greeting rather than leaving a gap", async () => {
    await renderBackdrop({ greeting: "custom", customGreeting: "   " })
    expect(screen.queryByTestId("lock-screen-greeting")).not.toBeInTheDocument()
  })

  it("runs the aurora layer when asked", async () => {
    await renderBackdrop({ motion: "aurora" })
    expect(screen.getByTestId("lock-screen-backdrop-aurora")).toBeInTheDocument()
    expect(screen.getByTestId("lock-screen-backdrop")).toHaveAttribute("data-motion", "aurora")
  })

  it("stills the motion when the system asks for less", async () => {
    reducedMotion = true
    await renderBackdrop({ motion: "aurora" })
    expect(screen.queryByTestId("lock-screen-backdrop-aurora")).not.toBeInTheDocument()
    expect(screen.getByTestId("lock-screen-backdrop")).toHaveAttribute("data-motion", "none")
  })

  it("honours an explicit opt-out of the system motion hint", async () => {
    // Wanting an animated lock screen on a machine set to reduce motion is a
    // legitimate choice, and it is a separate answer from wanting aurora.
    reducedMotion = true
    await renderBackdrop({ motion: "aurora", respectSystemMotion: false })
    expect(screen.getByTestId("lock-screen-backdrop-aurora")).toBeInTheDocument()
  })

  it("does not resolve a wallpaper for a backdrop that has none", async () => {
    await renderBackdrop({ backdrop: "solid" })
    expect(resolveSourceToCss).not.toHaveBeenCalled()
  })
})
