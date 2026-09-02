/** @jest-environment jsdom */

import { fireEvent, render, screen, within } from "@testing-library/react"

import { WallpaperRotationCard } from "./wallpaper-rotation-card"
import { DEFAULT_WALLPAPER_ROTATION } from "@/types/appearance/wallpaper-rotation"
import type { Wallpaper } from "@/types/appearance"

jest.mock("next-intl", () => ({
  // Echo the key so assertions read as the contract rather than as copy, and
  // append interpolations so plural-bearing keys stay distinguishable.
  useTranslations: (namespace: string) => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${namespace}.${key}:${JSON.stringify(values)}` : `${namespace}.${key}`
    return t
  },
}))

let reducedMotion = false
jest.mock("@/lib/appearance/reduced-motion", () => ({
  prefersReducedMotion: () => reducedMotion,
}))

function image(id: string, name = id): Wallpaper {
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

function color(id: string): Wallpaper {
  return {
    id,
    name: id,
    kind: "color",
    source: { kind: "color", value: "#123456" },
    builtin: true,
    createdAt: 0,
  }
}

const gallery = [image("wp-1", "Dawn"), image("wp-2", "Dusk"), color("flat")]

function renderCard(
  rotation: Partial<typeof DEFAULT_WALLPAPER_ROTATION> = {},
  options: { scrimActive?: boolean; gallery?: Wallpaper[] } = {}
) {
  const onChange = jest.fn()
  render(
    <WallpaperRotationCard
      rotation={{ ...DEFAULT_WALLPAPER_ROTATION, enabled: true, ...rotation }}
      gallery={options.gallery ?? gallery}
      scrimActive={options.scrimActive ?? false}
      onChange={onChange}
    />
  )
  return { onChange }
}

beforeEach(() => {
  reducedMotion = false
})

describe("WallpaperRotationCard", () => {
  it("toggles rotation on and off", () => {
    const { onChange } = renderCard({ enabled: false })
    fireEvent.click(screen.getByTestId("wallpaper-rotation-enable"))
    expect(onChange).toHaveBeenCalledWith({ enabled: true })
  })

  it("warns when there is nothing to rotate to", () => {
    renderCard({}, { gallery: [image("only")] })
    expect(screen.getByText(/needsTwo/)).toBeInTheDocument()
  })

  it("does not warn once a second rotatable wallpaper exists", () => {
    renderCard()
    expect(screen.queryByText(/needsTwo/)).not.toBeInTheDocument()
  })

  it("counts only rotatable wallpapers, ignoring solid colours", () => {
    // The colour swatch in the fixture must not appear as a playlist chip.
    renderCard()
    const playlist = screen.getByTestId("rotation-playlist")
    expect(within(playlist).queryByTestId("rotation-playlist-flat")).not.toBeInTheDocument()
    expect(within(playlist).getByTestId("rotation-playlist-wp-1")).toBeInTheDocument()
  })

  it("hides the interval control unless the trigger is a timer", () => {
    // Asking "how often" under "each time the app starts" is a question with
    // no answer, so the control is absent rather than present and inert.
    renderCard({ trigger: "launch" })
    expect(screen.queryByTestId("rotation-interval")).not.toBeInTheDocument()
  })

  it("shows the interval control for the timer trigger", () => {
    renderCard({ trigger: "interval" })
    expect(screen.getByTestId("rotation-interval")).toBeInTheDocument()
  })

  it("shows the slide direction only for the slide transition", () => {
    renderCard({ transition: "crossfade" })
    expect(screen.queryByTestId("rotation-direction")).not.toBeInTheDocument()
  })

  it("reveals the slide direction when slide is picked", () => {
    renderCard({ transition: "slide" })
    expect(screen.getByTestId("rotation-direction")).toBeInTheDocument()
  })

  it("hides duration and easing for the instant transition", () => {
    renderCard({ transition: "none" })
    expect(screen.queryByTestId("rotation-duration")).not.toBeInTheDocument()
    expect(screen.queryByTestId("rotation-easing")).not.toBeInTheDocument()
  })

  it("explains a reduced-motion downgrade instead of silently cutting", () => {
    reducedMotion = true
    renderCard({ transition: "kenBurns" })
    expect(screen.getByTestId("rotation-degraded")).toHaveTextContent("degraded.reduced-motion")
  })

  it("explains a scrim downgrade", () => {
    renderCard({ transition: "crossfade" }, { scrimActive: true })
    expect(screen.getByTestId("rotation-degraded")).toHaveTextContent("degraded.scrim")
  })

  it("says nothing when the chosen transition survives intact", () => {
    renderCard({ transition: "crossfade" })
    expect(screen.queryByTestId("rotation-degraded")).not.toBeInTheDocument()
  })

  it("treats an empty playlist as every wallpaper being selected", () => {
    renderCard({ playlist: [] })
    expect(screen.getByTestId("rotation-playlist-wp-1")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByTestId("rotation-playlist-wp-2")).toHaveAttribute("aria-pressed", "true")
  })

  it("materialises the implicit list before removing the first chip", () => {
    // Without this, clicking a chip while the playlist is empty would compute
    // `[].filter(...)` and read as a no-op that leaves everything selected.
    const { onChange } = renderCard({ playlist: [] })
    fireEvent.click(screen.getByTestId("rotation-playlist-wp-1"))
    expect(onChange).toHaveBeenCalledWith({ playlist: ["wp-2"] })
  })

  it("adds a wallpaper back to an explicit playlist", () => {
    const { onChange } = renderCard({ playlist: ["wp-2"] })
    fireEvent.click(screen.getByTestId("rotation-playlist-wp-1"))
    expect(onChange).toHaveBeenCalledWith({ playlist: ["wp-2", "wp-1"] })
  })

  it("offers a way back to the implicit everything", () => {
    const { onChange } = renderCard({ playlist: ["wp-1"] })
    fireEvent.click(screen.getByTestId("rotation-playlist-reset"))
    expect(onChange).toHaveBeenCalledWith({ playlist: [] })
  })

  it("hides the reset while the playlist is already everything", () => {
    renderCard({ playlist: [] })
    expect(screen.queryByTestId("rotation-playlist-reset")).not.toBeInTheDocument()
  })

  it("reports an empty explicit selection as going nowhere", () => {
    renderCard({ playlist: [] })
    expect(screen.getByText(/playlistAllHint/)).toBeInTheDocument()

    render(
      <WallpaperRotationCard
        rotation={{ ...DEFAULT_WALLPAPER_ROTATION, enabled: true, playlist: ["missing"] }}
        gallery={gallery}
        scrimActive={false}
        onChange={jest.fn()}
      />
    )
    // A playlist naming only deleted wallpapers resolves to a pool of zero.
    expect(screen.getByText(/playlistSomeHint.*"count":0/)).toBeInTheDocument()
  })

  it("forwards the pause and reduced-motion toggles", () => {
    const { onChange } = renderCard({ pauseWhenHidden: true, respectReducedMotion: true })
    fireEvent.click(screen.getByTestId("rotation-pause-hidden"))
    expect(onChange).toHaveBeenCalledWith({ pauseWhenHidden: false })

    fireEvent.click(screen.getByTestId("rotation-reduced-motion"))
    expect(onChange).toHaveBeenCalledWith({ respectReducedMotion: false })
  })

  it("marks the section disabled so the applier and the UI agree", () => {
    renderCard({ enabled: false })
    expect(screen.getByTestId("wallpaper-rotation")).toHaveAttribute("data-enabled", "false")
  })
})
