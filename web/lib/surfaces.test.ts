import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { SURFACE_GLYPH, surfaceRoute } from "./surfaces"

describe("surfaces", () => {
  it("has a mark for every station either locale renders", () => {
    for (const copy of [en, zh]) {
      for (const station of copy.surfaces.entryPoints.stations) {
        expect(SURFACE_GLYPH[station.key]).toBeDefined()
      }
    }
  })

  it("routes each station to the /surfaces block that carries its key as id", () => {
    expect(surfaceRoute("mobile")).toBe("/surfaces#mobile")
    for (const copy of [en, zh]) {
      const ids = copy.surfaces.sections.map((section) => section.id)
      for (const station of copy.surfaces.entryPoints.stations) {
        expect(ids).toContain(surfaceRoute(station.key).split("#")[1])
      }
    }
  })
})
