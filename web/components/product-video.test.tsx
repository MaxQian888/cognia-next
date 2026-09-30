let reduced = false
let inView = true

jest.mock("motion/react", () => ({
  useReducedMotion: () => reduced,
  useInView: () => inView,
  motion: {
    div: ({ children, ...rest }: { children?: React.ReactNode }) => <div {...rest}>{children}</div>,
  },
}))

import { act, fireEvent, render, screen } from "@testing-library/react"
import type { ProductVideo as ProductVideoAsset } from "@web/lib/product-videos"
import { ProductVideo } from "./product-video"

const HERO: ProductVideoAsset = {
  src: "/video/hero-loop-en.abc.mp4",
  poster: "/video/hero-loop-en.abc.jpg",
  width: 1600,
  height: 1000,
  bytes: 1_000_000,
  durationS: 10,
  hasAudio: false,
}

const FILM: ProductVideoAsset = {
  src: "/video/product-film-en.def.mp4",
  poster: "/video/product-film-en.def.jpg",
  width: 1920,
  height: 1080,
  bytes: 6_000_000,
  durationS: 44,
  captions: "/video/product-film-en.def.vtt",
  hasAudio: true,
}

let play: jest.SpyInstance
let pause: jest.SpyInstance

beforeEach(() => {
  reduced = false
  inView = true
  play = jest.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined)
  pause = jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined)
})

afterEach(() => {
  jest.restoreAllMocks()
  Object.defineProperty(document, "hidden", { configurable: true, value: false })
})

function video(container: HTMLElement): HTMLVideoElement {
  const element = container.querySelector("video")
  if (!element) throw new Error("no video element")
  return element
}

describe("ProductVideo — ambient (hero loop)", () => {
  const renderAmbient = () =>
    render(
      <ProductVideo
        mode="ambient"
        video={HERO}
        label="The workspace running the release task"
        caption="The task this page follows."
        note="Recorded from the Cognia app running demo data."
      />
    )

  it("is a muted, looping, inline video with its poster and an accessible name", () => {
    const { container } = renderAmbient()
    const element = video(container)
    expect(element.muted).toBe(true)
    expect(element.loop).toBe(true)
    expect(element).toHaveAttribute("playsinline")
    expect(element).toHaveAttribute("poster", HERO.poster)
    expect(element).toHaveAttribute("src", HERO.src)
    expect(element).toHaveAttribute("aria-label", "The workspace running the release task")
    expect(element).not.toHaveAttribute("controls")
  })

  it("always says what it is", () => {
    renderAmbient()
    expect(screen.getByText("Recorded from the Cognia app running demo data.")).toBeInTheDocument()
    expect(screen.getByText("The task this page follows.")).toBeInTheDocument()
  })

  it("reserves the film's aspect ratio so the page does not shift", () => {
    const { container } = renderAmbient()
    const frame = video(container).parentElement as HTMLElement
    expect(frame.style.aspectRatio).toBe("1600 / 1000")
  })

  it("plays when hydrated, in view and motion is allowed", () => {
    const { container } = renderAmbient()
    expect(video(container)).toHaveAttribute("data-live", "true")
    expect(play).toHaveBeenCalled()
  })

  it("never plays under reduced motion, leaving the poster as the finished picture", () => {
    reduced = true
    const { container } = renderAmbient()
    expect(video(container)).toHaveAttribute("data-live", "false")
    expect(play).not.toHaveBeenCalled()
    expect(pause).toHaveBeenCalled()
  })

  it("does not play while scrolled out of view", () => {
    inView = false
    renderAmbient()
    expect(play).not.toHaveBeenCalled()
  })

  it("pauses when the tab is hidden and resumes when it returns", () => {
    renderAmbient()
    play.mockClear()
    Object.defineProperty(document, "hidden", { configurable: true, value: true })
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(pause).toHaveBeenCalled()
    expect(play).not.toHaveBeenCalled()
    Object.defineProperty(document, "hidden", { configurable: true, value: false })
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(play).toHaveBeenCalled()
  })

  it("keeps the poster when the browser refuses autoplay", async () => {
    play.mockRejectedValue(new Error("NotAllowedError"))
    const { container } = renderAmbient()
    await act(async () => {})
    expect(video(container)).toHaveAttribute("poster", HERO.poster)
  })

  it("stops listening for tab visibility when unmounted", () => {
    const remove = jest.spyOn(document, "removeEventListener")
    const { unmount } = renderAmbient()
    unmount()
    expect(remove).toHaveBeenCalledWith("visibilitychange", expect.any(Function))
  })
})

describe("ProductVideo — film (section player)", () => {
  const renderFilm = (asset: ProductVideoAsset = FILM) =>
    render(
      <ProductVideo
        mode="film"
        video={asset}
        label="Film: the release task"
        note="Recorded from the Cognia app running demo data."
        playLabel="Play the film"
        captionsLang="en"
        captionsLabel="English"
      />
    )

  it("never autoplays and loads nothing until asked", () => {
    const { container } = renderFilm()
    const element = video(container)
    expect(play).not.toHaveBeenCalled()
    expect(element).toHaveAttribute("preload", "none")
    expect(element).not.toHaveAttribute("controls")
    expect(element.muted).toBe(false)
  })

  it("starts on the play affordance and hands over to the native controls", () => {
    const { container } = renderFilm()
    fireEvent.click(screen.getByRole("button", { name: "Play the film" }))
    expect(play).toHaveBeenCalledTimes(1)
    expect(video(container)).toHaveAttribute("controls")
    expect(screen.queryByRole("button", { name: "Play the film" })).not.toBeInTheDocument()
  })

  it("brings the play affordance back if playback is refused", async () => {
    play.mockRejectedValue(new Error("NotAllowedError"))
    renderFilm()
    fireEvent.click(screen.getByRole("button", { name: "Play the film" }))
    await act(async () => {})
    expect(screen.getByRole("button", { name: "Play the film" })).toBeInTheDocument()
  })

  it("hides the affordance when playback starts some other way", () => {
    const { container } = renderFilm()
    fireEvent.play(video(container))
    expect(screen.queryByRole("button", { name: "Play the film" })).not.toBeInTheDocument()
  })

  it("carries the caption track in the page's language", () => {
    const { container } = renderFilm()
    const track = container.querySelector("track")
    expect(track).toHaveAttribute("kind", "captions")
    expect(track).toHaveAttribute("src", FILM.captions)
    expect(track).toHaveAttribute("srclang", "en")
    expect(track).toHaveAttribute("label", "English")
  })

  it("omits the track when the render has no captions", () => {
    const { container } = renderFilm({ ...FILM, captions: undefined })
    expect(container.querySelector("track")).toBeNull()
  })
})
