/** @jest-environment jsdom */

import {
  clearLockScreenPreferences,
  DEFAULT_MIRRORED_PREFERENCES,
  readLockScreenPreferences,
  writeLockScreenPreferences,
} from "./lock-screen-preferences"
import { DEFAULT_LOCK_SCREEN } from "@/types/appearance/lock-screen"

beforeEach(() => {
  localStorage.clear()
})

describe("lock screen preference mirror", () => {
  it("returns the defaults when nothing has been written", () => {
    expect(readLockScreenPreferences()).toEqual(DEFAULT_MIRRORED_PREFERENCES)
  })

  it("round-trips what was written", () => {
    writeLockScreenPreferences({
      settings: { ...DEFAULT_LOCK_SCREEN, backdrop: "wallpaper", dim: 0.7, clock: "timeAndDate" },
      activeWallpaperId: "wp-1",
    })
    const read = readLockScreenPreferences()
    expect(read.settings.backdrop).toBe("wallpaper")
    expect(read.settings.dim).toBe(0.7)
    expect(read.activeWallpaperId).toBe("wp-1")
  })

  it("fills in fields a older build never wrote", () => {
    localStorage.setItem(
      "cognia.lock-screen.appearance.v1",
      JSON.stringify({ settings: { backdrop: "solid" } })
    )
    const read = readLockScreenPreferences()
    expect(read.settings.backdrop).toBe("solid")
    expect(read.settings.dim).toBe(DEFAULT_LOCK_SCREEN.dim)
    expect(read.settings.showAvatar).toBe(DEFAULT_LOCK_SCREEN.showAvatar)
  })

  it("refuses an unrecognised backdrop rather than rendering nothing", () => {
    // `backdrop` picks which branch renders. An unknown value would fall
    // through every case and leave the lock screen with no backdrop at all.
    localStorage.setItem(
      "cognia.lock-screen.appearance.v1",
      JSON.stringify({ settings: { backdrop: "hologram" } })
    )
    expect(readLockScreenPreferences().settings.backdrop).toBe(DEFAULT_LOCK_SCREEN.backdrop)
  })

  it("degrades to the defaults on malformed JSON", () => {
    // A lock screen that cannot render is far worse than a plain one.
    localStorage.setItem("cognia.lock-screen.appearance.v1", "{not json")
    expect(readLockScreenPreferences()).toEqual(DEFAULT_MIRRORED_PREFERENCES)
  })

  it("ignores a non-string wallpaper id", () => {
    localStorage.setItem(
      "cognia.lock-screen.appearance.v1",
      JSON.stringify({ settings: {}, activeWallpaperId: 42 })
    )
    expect(readLockScreenPreferences().activeWallpaperId).toBeNull()
  })

  it("clears the mirror", () => {
    writeLockScreenPreferences({ settings: DEFAULT_LOCK_SCREEN, activeWallpaperId: "wp-1" })
    clearLockScreenPreferences()
    expect(readLockScreenPreferences()).toEqual(DEFAULT_MIRRORED_PREFERENCES)
  })

  it("survives storage that throws on read", () => {
    const original = Storage.prototype.getItem
    Storage.prototype.getItem = () => {
      throw new Error("blocked")
    }
    try {
      expect(readLockScreenPreferences()).toEqual(DEFAULT_MIRRORED_PREFERENCES)
    } finally {
      Storage.prototype.getItem = original
    }
  })

  it("survives storage that throws on write", () => {
    // A full quota costs the customisation, never the lock screen.
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new Error("quota")
    }
    try {
      expect(() =>
        writeLockScreenPreferences({ settings: DEFAULT_LOCK_SCREEN, activeWallpaperId: null })
      ).not.toThrow()
    } finally {
      Storage.prototype.setItem = original
    }
  })

  it("survives a clear that throws", () => {
    const original = Storage.prototype.removeItem
    Storage.prototype.removeItem = () => {
      throw new Error("blocked")
    }
    try {
      expect(() => clearLockScreenPreferences()).not.toThrow()
    } finally {
      Storage.prototype.removeItem = original
    }
  })
})
