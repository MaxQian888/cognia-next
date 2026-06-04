import { getSkin, registerSkin, listSkinIds, DEFAULT_SKIN_ID } from "./registry"
import type { PetSkin } from "@/types/pet"

describe("skin registry", () => {
  it("returns the svg skin by default and for unknown ids", () => {
    expect(getSkin(undefined).id).toBe(DEFAULT_SKIN_ID)
    expect(getSkin("does-not-exist").id).toBe(DEFAULT_SKIN_ID)
    expect(getSkin("svg").id).toBe("svg")
  })

  it("ships the svg and live2d skins", () => {
    expect(listSkinIds()).toEqual(expect.arrayContaining(["svg", "live2d"]))
    expect(getSkin("live2d").id).toBe("live2d")
  })

  it("registers and lists a new skin", () => {
    const fake: PetSkin = { id: "fake-skin", render: () => null }
    registerSkin(fake)
    expect(getSkin("fake-skin")).toBe(fake)
    expect(listSkinIds()).toContain("fake-skin")
    expect(listSkinIds()).toContain("svg")
  })
})
