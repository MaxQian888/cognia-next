import {
  canResolveWallpaperHere,
  wallpaperBinding,
  wallpaperUnavailableReason,
} from "./wallpaper-availability"
import type { WallpaperSource } from "@/types/appearance"

const DISK: WallpaperSource = {
  kind: "image",
  storage: "disk",
  relPath: "abc.png",
  mime: "image/png",
  width: 10,
  height: 10,
}
const IDB: WallpaperSource = {
  kind: "image",
  storage: "indexeddb",
  blobKey: "abc",
  mime: "image/png",
  width: 10,
  height: 10,
}
const DATA_URL: WallpaperSource = {
  kind: "image",
  storage: "data-url",
  dataUrl: "data:image/png;base64,AA==",
  mime: "image/png",
  width: 10,
  height: 10,
}
const GRADIENT: WallpaperSource = { kind: "gradient", css: "linear-gradient(#000, #fff)" }
const COLOR: WallpaperSource = { kind: "color", value: "#1e293b" }

describe("wallpaperBinding", () => {
  it("classifies every source shape in the union", () => {
    // Not a formality: `WallpaperSource` has five members and the two that
    // carry a storage reference are the whole reason this module exists. A new
    // member added without a branch here would fall through to `undefined` and
    // silently read as "portable" at the call sites.
    const all: WallpaperSource[] = [DISK, IDB, DATA_URL, GRADIENT, COLOR]
    expect(all.map(wallpaperBinding)).toEqual([
      "host-filesystem",
      "local-blob-store",
      "portable",
      "portable",
      "portable",
    ])
  })
})

describe("canResolveWallpaperHere", () => {
  it("opens portable sources on either runtime", () => {
    for (const source of [DATA_URL, GRADIENT, COLOR]) {
      expect(canResolveWallpaperHere(source, true)).toBe(true)
      expect(canResolveWallpaperHere(source, false)).toBe(true)
    }
  })

  it("gives each device-bound kind to exactly one runtime", () => {
    // The asymmetry IS the bug: a phone can only write `indexeddb` and a
    // desktop can only write `disk`, so mirroring the array handed each one
    // precisely the kind it cannot open.
    expect(canResolveWallpaperHere(DISK, true)).toBe(true)
    expect(canResolveWallpaperHere(DISK, false)).toBe(false)
    expect(canResolveWallpaperHere(IDB, false)).toBe(true)
    expect(canResolveWallpaperHere(IDB, true)).toBe(false)
  })
})

describe("wallpaperUnavailableReason", () => {
  it("stays silent for anything this runtime can open", () => {
    expect(wallpaperUnavailableReason(GRADIENT, true)).toBeNull()
    expect(wallpaperUnavailableReason(COLOR, false)).toBeNull()
    expect(wallpaperUnavailableReason(DISK, true)).toBeNull()
    expect(wallpaperUnavailableReason(IDB, false)).toBeNull()
  })

  it("separates 'open it on the desktop' from 'stranded on another device'", () => {
    // A `disk` row seen on a phone is still openable — on the desktop app that
    // wrote it. An `indexeddb` row seen on the desktop is not openable
    // anywhere the user is likely to be looking, so the copy must not imply
    // it is one click away.
    expect(wallpaperUnavailableReason(DISK, false)).toBe("savedOnDesktop")
    expect(wallpaperUnavailableReason(IDB, true)).toBe("savedOnAnotherDevice")
  })
})
