/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"

import { MobileSpotIcon, MOBILE_SPOT_ICON_NAMES } from "./mobile-spot-icon"
import manifest from "@/public/icons/cognia-mobile-spots/icon-manifest.json"
import { ME_ENTRIES } from "./me/me-entries"
import { SETTINGS_NAV } from "@/components/settings/settings-nav-config"
import { SIDEBAR_NAV_META } from "@/types/shell/sidebar"

describe("<MobileSpotIcon />", () => {
  it("keeps the asset manifest and component names in sync without duplicates", () => {
    expect(manifest.icons.map((icon) => icon.name)).toEqual([...MOBILE_SPOT_ICON_NAMES])
    expect(new Set(MOBILE_SPOT_ICON_NAMES).size).toBe(MOBILE_SPOT_ICON_NAMES.length)
  })

  it("selects exactly the verified WebP inventory with PNG fallback for the remaining icons", () => {
    expect(manifest.runtimeFormats.default).toBe("png")
    expect(new Set(manifest.runtimeFormats.webp).size).toBe(65)
    expect(
      MOBILE_SPOT_ICON_NAMES.filter((name) => !manifest.runtimeFormats.webp.includes(name))
    ).toHaveLength(16)
    expect([...manifest.runtimeFormats.webp].sort()).toEqual(
      readdirSync(path.join(process.cwd(), "public/icons/cognia-mobile-spots/webp"))
        .map((file) => file.replace(/\.webp$/, ""))
        .sort()
    )
    for (const name of manifest.runtimeFormats.webp) expect(MOBILE_SPOT_ICON_NAMES).toContain(name)
  })

  it.each(MOBILE_SPOT_ICON_NAMES)("renders the packaged preferred format for %s", (name) => {
    const format = manifest.runtimeFormats.webp.includes(name) ? "webp" : "png"
    const url = `/icons/cognia-mobile-spots/${format}/${name}.${format}`
    const bytes = readFileSync(path.join(process.cwd(), "public", url.slice(1)))
    if (format === "webp") {
      expect(bytes.subarray(0, 4).toString()).toBe("RIFF")
      expect(bytes.subarray(8, 12).toString()).toBe("WEBP")
    } else expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
    render(<MobileSpotIcon name={name} />)
    expect(screen.getByTestId(`mobile-spot-icon-${name}`)).toHaveAttribute("src", url)
  })

  it.each(MOBILE_SPOT_ICON_NAMES)("ships a real PNG for %s", (name) => {
    const bytes = readFileSync(
      path.join(process.cwd(), "public/icons/cognia-mobile-spots/png", `${name}.png`)
    )
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
    expect(bytes.readUInt32BE(16)).toBeGreaterThanOrEqual(256)
    expect(bytes.readUInt32BE(20)).toBe(bytes.readUInt32BE(16))
    // PNG IHDR color type 6 is RGBA; the UI must not get an opaque backdrop.
    expect(bytes[25]).toBe(6)
  })

  it.each([
    ["mobileEntries", ME_ENTRIES],
    ["desktopNavigation", SIDEBAR_NAV_META],
    ["desktopSettings", SETTINGS_NAV],
  ] as const)("covers every current %s entry with a registered asset", (group, entries) => {
    const mappings = manifest.coverage[group] as Record<string, string>
    expect(Object.keys(mappings).sort()).toEqual(entries.map((entry) => entry.id).sort())
    for (const entry of entries) {
      expect(MOBILE_SPOT_ICON_NAMES).toContain(mappings[entry.id])
    }
  })

  it("uses the documented mobile mappings in the live registry", () => {
    expect(Object.fromEntries(ME_ENTRIES.map((entry) => [entry.id, entry.spotIcon]))).toEqual(
      manifest.coverage.mobileEntries
    )
  })

  it("renders the requested transparent Cognia illustration as decorative media", () => {
    render(<MobileSpotIcon name="workflows" size={72} className="shrink-0" />)

    const image = screen.getByTestId("mobile-spot-icon-workflows")
    expect(image).toHaveAttribute("src", "/icons/cognia-mobile-spots/png/workflows.png")
    expect(image).toHaveAttribute("alt", "")
    expect(image).toHaveAttribute("aria-hidden", "true")
    expect(image).toHaveAttribute("width", "72")
    expect(image).toHaveAttribute("height", "72")
    expect(image).toHaveClass("shrink-0")
  })
})
