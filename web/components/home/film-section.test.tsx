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
import { FilmSection } from "./film-section"

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

describe("FilmSection", () => {
  it("is the film anchor, with its heading and index tag", () => {
    const { container } = render(
      <FilmSection copy={en.home.film} footage={en.footage} locale="en" video={FILM} index={2} />
    )
    expect(container.querySelector("section#film")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: en.home.film.title })).toBeInTheDocument()
    expect(container.querySelector('[data-slot="section-index"]')).toHaveTextContent("02")
  })

  it("renders the film player with its label, provenance and play affordance", () => {
    const { container } = render(
      <FilmSection copy={en.home.film} footage={en.footage} locale="en" video={FILM} />
    )
    expect(container.querySelector('[data-video="film"] video')).toHaveAttribute(
      "aria-label",
      en.home.film.videoLabel
    )
    expect(screen.getByText(en.footage.recordingNote)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: en.home.film.playLabel })).toBeInTheDocument()
  })

  it("labels the caption track in the page's language", () => {
    const { container } = render(
      <FilmSection copy={zh.home.film} footage={zh.footage} locale="zh" video={FILM} />
    )
    const track = container.querySelector("track")
    expect(track).toHaveAttribute("srclang", "zh-CN")
    expect(track).toHaveAttribute("label", zh.home.film.captionsLabel)
    expect(screen.getByRole("button", { name: zh.home.film.playLabel })).toBeInTheDocument()
  })
})
