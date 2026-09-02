import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"
import { SURFACE_BLOCKS, type SurfaceReach } from "@/lib/platform/surface-reach"
import type { HostProfile } from "@/lib/platform/capabilities"

import { commandAuthoringBlockKey, resolveCommandAuthoringReach } from "./command-authoring-reach"

describe("resolveCommandAuthoringReach", () => {
  it("lets a paired browser or phone author project commands", () => {
    for (const profile of ["cloud-companion", "mobile-companion"] as HostProfile[]) {
      const reach = resolveCommandAuthoringReach(profile)
      expect(reach.project.available).toBe(true)
      // The workspace filesystem crosses the pairing. The user's home directory
      // does not, and no pairing changes that.
      expect(reach.global).toEqual({ available: false, block: "needs-desktop-shell", remedy: null })
    }
  })

  it("gives a browser with nothing paired a remedy rather than a dead end", () => {
    const reach = resolveCommandAuthoringReach("web-standalone")
    expect(reach.project).toEqual({ available: false, block: "no-host", remedy: "/pair" })
    expect(reach.global).toEqual({ available: false, block: "no-host", remedy: "/pair" })
  })

  it("gives the desktop both scopes", () => {
    const reach = resolveCommandAuthoringReach("desktop")
    expect(reach.project.available).toBe(true)
    expect(reach.global.available).toBe(true)
  })

  it("does not mistake the headless brain for a desktop", () => {
    const reach = resolveCommandAuthoringReach("headless")
    expect(reach.project.available).toBe(true)
    expect(reach.global.available).toBe(false)
  })
})

/**
 * `commandAuthoringBlockKey` builds a translation key at runtime, and
 * `lint:i18n` only checks literal `t("…")` arguments. Without this the day a
 * `SurfaceBlock` is added is the day the UI renders a raw key.
 */
describe("commandAuthoringBlockKey", () => {
  const catalogue = (messages: Record<string, unknown>) =>
    (messages as { settings: { slashCommands: { authoring: Record<string, string> } } }).settings
      .slashCommands.authoring

  it("is null while the surface is available", () => {
    expect(commandAuthoringBlockKey({ available: true })).toBeNull()
  })

  it("names an existing key in both locales for every block the resolver can produce", () => {
    for (const block of SURFACE_BLOCKS) {
      const reach: SurfaceReach = { available: false, block }
      const key = commandAuthoringBlockKey(reach)
      expect(key).not.toBeNull()
      const leaf = key!.split(".")[1]
      expect(catalogue(enMessages)[leaf]).toBeTruthy()
      expect(catalogue(zhMessages)[leaf]).toBeTruthy()
    }
  })

  it("still resolves a key when the block is missing entirely", () => {
    const key = commandAuthoringBlockKey({ available: false })
    expect(catalogue(enMessages)[key!.split(".")[1]]).toBeTruthy()
  })
})
