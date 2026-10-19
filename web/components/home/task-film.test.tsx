jest.mock("motion/react", () => ({
  useReducedMotion: () => false,
  useInView: () => true,
  motion: {
    div: ({
      children,
      initial: _initial,
      whileInView: _whileInView,
      viewport: _viewport,
      transition: _transition,
      variants: _variants,
      ...rest
    }: {
      children?: React.ReactNode
      [prop: string]: unknown
    }) => <div {...rest}>{children}</div>,
  },
}))

import { render, screen } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import type { ProductVideo } from "@web/lib/product-videos"
import { TaskFilm } from "./task-film"

const FILM: ProductVideo = {
  src: "/video/product-film-en.abc.mp4",
  poster: "/video/product-film-en.abc.jpg",
  width: 1920,
  height: 1080,
  bytes: 6_000_000,
  durationS: 44,
  captions: "/video/product-film-en.abc.vtt",
  hasAudio: false,
}

describe("TaskFilm", () => {
  it("labels the film with the render's own length and says what it shows", () => {
    render(<TaskFilm copy={en.home.film} footage={en.footage} locale="en" video={FILM} />)
    expect(screen.getByText("Full recording · 44 s")).toBeInTheDocument()
    expect(screen.getByText(en.home.film.lead)).toBeInTheDocument()
    // No heading of its own: it opens the task section, whose heading it shares.
    expect(screen.queryByRole("heading")).toBeNull()
  })

  it("never autoplays: the poster carries a play control and the player is named", () => {
    const { container } = render(
      <TaskFilm copy={en.home.film} footage={en.footage} locale="en" video={FILM} />
    )
    const video = container.querySelector('[data-video="film"] video')
    expect(video).toHaveAttribute("aria-label", en.home.film.videoLabel)
    expect(video).not.toHaveAttribute("autoplay")
    expect(screen.getByRole("button", { name: en.home.film.playLabel })).toBeInTheDocument()
    expect(screen.getByText(en.footage.recordingNote)).toBeInTheDocument()
  })

  it("carries the caption track in the page's language", () => {
    const { container } = render(
      <TaskFilm copy={zh.home.film} footage={zh.footage} locale="zh" video={FILM} />
    )
    const track = container.querySelector("track")
    expect(track).toHaveAttribute("srclang", "zh-CN")
    expect(track).toHaveAttribute("label", zh.home.film.captionsLabel)
    expect(screen.getByText("完整录屏 · 44 秒")).toBeInTheDocument()
  })
})
