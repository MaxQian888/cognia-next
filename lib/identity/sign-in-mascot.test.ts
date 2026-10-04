import { MASCOT_MOODS, mascotDataUri, mascotSvg } from "./sign-in-mascot"
import * as worker from "../../services/identity-server/src/pages/mascot"

describe("sign-in mascot (app and CLI copy)", () => {
  it("draws exactly what the identity Worker's pages draw", () => {
    expect(MASCOT_MOODS).toEqual(worker.MASCOT_MOODS)
    for (const mood of MASCOT_MOODS) expect(mascotSvg(mood)).toBe(worker.mascotSvg(mood))
  })

  it("encodes each mood as an image source that decodes back to the SVG", () => {
    for (const mood of MASCOT_MOODS) {
      const uri = mascotDataUri(mood)
      expect(uri.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true)
      expect(decodeURIComponent(uri.slice(uri.indexOf(",") + 1))).toBe(mascotSvg(mood))
      // Nothing an attribute or a CSS url() would trip over.
      expect(uri).not.toMatch(/["'<>#\s]/)
    }
  })
})
