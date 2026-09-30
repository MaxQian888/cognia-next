jest.mock("@web/content/generated/product-videos.json", () => ({
  renderedAt: "2026-09-30T00:00:00.000Z",
  videos: {
    "hero-loop-en": {
      src: "/video/hero-loop-en.0123abcd.mp4",
      poster: "/video/hero-loop-en.0123abcd.jpg",
      width: 1600,
      height: 1000,
      bytes: 1_800_000,
      durationS: 10,
      hasAudio: false,
    },
  },
}))

import { findVideo, renderedAt, videoKey } from "./product-videos"

describe("product videos", () => {
  it("keys a film by id and locale", () => {
    expect(videoKey("product-film", "zh")).toBe("product-film-zh")
  })

  it("returns a rendered film", () => {
    expect(findVideo("hero-loop", "en")).toMatchObject({
      src: "/video/hero-loop-en.0123abcd.mp4",
      width: 1600,
      hasAudio: false,
    })
  })

  it("answers null for a film that was not rendered, so the caller keeps its fallback", () => {
    expect(findVideo("hero-loop", "zh")).toBeNull()
    expect(findVideo("product-film", "en")).toBeNull()
  })

  it("reports when the committed films were rendered", () => {
    expect(renderedAt()).toBe("2026-09-30T00:00:00.000Z")
  })
})
