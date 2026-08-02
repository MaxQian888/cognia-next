import { act, render } from "@testing-library/react"
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"
import { CursorApplier, resolveCursorStyle } from "./cursor-applier"
import { CURSOR_ROOT_ATTR, CURSOR_STYLE_ELEMENT_ID } from "./cursor-css"
import { CURSOR_PACKS_BY_ID } from "./cursor-packs"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_CURSOR, type CursorSettings } from "@/types/appearance"

// The accent hook pulls in next-themes + the whole palette resolver; the
// applier's contract is "whatever accent it is handed reaches the art", so it
// is stubbed here and covered on its own in use-cursor-accent.test.tsx.
jest.mock("./use-cursor-accent", () => ({ useCursorAccentColor: jest.fn(() => "#7c3aed") }))

// Rasterization is the second, optional pass. Mocked per test so both the
// "engine gave us a PNG" and the "no canvas, keep the SVG" paths are real.
jest.mock("./render-cursor", () => ({
  ...jest.requireActual("./render-cursor"),
  rasterizeCursorSvg: jest.fn(async () => null),
}))

import { rasterizeCursorSvg } from "./render-cursor"

const rasterMock = rasterizeCursorSvg as jest.Mock

const baseSettings = {
  id: "singleton" as const,
  permissionMode: "default" as const,
  alwaysAllowTools: [],
  builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
}

function setCursor(cursor: Partial<CursorSettings> | undefined) {
  useSettingsStore.setState({
    settings: cursor
      ? { ...baseSettings, cursor: { ...DEFAULT_CURSOR, ...cursor } }
      : { ...baseSettings },
  })
}

function styleEl(): HTMLStyleElement | null {
  return document.getElementById(CURSOR_STYLE_ELEMENT_ID) as HTMLStyleElement | null
}

/** Let the raster upgrade's promise chain settle. */
async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

afterEach(() => {
  styleEl()?.remove()
  document.documentElement.removeAttribute(CURSOR_ROOT_ATTR)
  useSettingsStore.setState({ settings: null })
})

describe("resolveCursorStyle", () => {
  it("returns null when the feature is off", () => {
    expect(resolveCursorStyle({ ...DEFAULT_CURSOR, enabled: false }, "#7c3aed")).toBeNull()
  })

  it("returns null for the system sentinel even when enabled", () => {
    expect(
      resolveCursorStyle({ ...DEFAULT_CURSOR, enabled: true, packId: "system" }, "#7c3aed")
    ).toBeNull()
  })

  it("returns null for a pack id that no longer exists", () => {
    expect(
      resolveCursorStyle({ ...DEFAULT_CURSOR, enabled: true, packId: "removed" }, "#7c3aed")
    ).toBeNull()
  })

  it("renders every declared role of the chosen pack", () => {
    const resolved = resolveCursorStyle(
      { ...DEFAULT_CURSOR, enabled: true, packId: "sakura" },
      "#7c3aed"
    )!
    expect(resolved.packId).toBe("sakura")
    expect(resolved.svgs.map((s) => s.role)).toEqual([...CURSOR_PACKS_BY_ID.get("sakura")!.roles])
    expect(resolved.css).toContain("cursor: url(")
  })

  it("emits fewer rules for a pack that defers roles to the platform", () => {
    const full = resolveCursorStyle(
      { ...DEFAULT_CURSOR, enabled: true, packId: "aero" },
      "#7c3aed"
    )!
    const partial = resolveCursorStyle(
      { ...DEFAULT_CURSOR, enabled: true, packId: "graphite" },
      "#7c3aed"
    )!
    expect(partial.svgs.length).toBeLessThan(full.svgs.length)
    expect(partial.css).not.toContain("not-allowed")
  })

  it("applies the accent tint when the color mode asks for it", () => {
    const packMode = resolveCursorStyle(
      { ...DEFAULT_CURSOR, enabled: true, packId: "aero", colorMode: "pack" },
      "#7c3aed"
    )!
    const accentMode = resolveCursorStyle(
      { ...DEFAULT_CURSOR, enabled: true, packId: "aero", colorMode: "accent" },
      "#7c3aed"
    )!
    expect(accentMode.svgs[0].svg).toContain("%237c3aed".replace("%23", "#"))
    expect(accentMode.css).not.toBe(packMode.css)
  })

  it("grows the rendered art with the size setting", () => {
    const small = resolveCursorStyle(
      { ...DEFAULT_CURSOR, enabled: true, packId: "aero", size: 1 },
      undefined
    )!
    const large = resolveCursorStyle(
      { ...DEFAULT_CURSOR, enabled: true, packId: "aero", size: 2 },
      undefined
    )!
    expect(large.sizePx).toBe(small.sizePx * 2)
  })

  it("fills in defaults for a settings row written before this feature existed", () => {
    expect(resolveCursorStyle(undefined, "#7c3aed")).toBeNull()
  })
})

describe("CursorApplier", () => {
  it("writes nothing while the feature is off", async () => {
    setCursor({ enabled: false })
    render(<CursorApplier />)
    await flush()
    expect(styleEl()).toBeNull()
    expect(document.documentElement.hasAttribute(CURSOR_ROOT_ATTR)).toBe(false)
  })

  it("writes nothing for a settings row written before this feature existed", async () => {
    setCursor(undefined)
    render(<CursorApplier />)
    await flush()
    expect(styleEl()).toBeNull()
  })

  it("does not resurrect a sheet that was removed while the raster was in flight", async () => {
    let release: (value: string | null) => void = () => {}
    rasterMock.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          release = resolve
        })
    )
    setCursor({ enabled: true, packId: "aero" })
    render(<CursorApplier />)
    styleEl()!.remove()
    await act(async () => {
      release("data:image/png;base64,LATE")
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(styleEl()).toBeNull()
  })

  it("injects the sheet and stamps the pack id on <html>", async () => {
    setCursor({ enabled: true, packId: "mahou" })
    render(<CursorApplier />)
    await flush()
    expect(styleEl()?.textContent).toContain("cursor: url(")
    expect(document.documentElement.getAttribute(CURSOR_ROOT_ATTR)).toBe("mahou")
  })

  it("paints synchronously with SVG before the raster pass resolves", () => {
    setCursor({ enabled: true, packId: "aero" })
    render(<CursorApplier />)
    // No flush: this is the first-frame state.
    expect(styleEl()?.textContent).toContain("data:image/svg+xml")
  })

  it("upgrades to PNG when the engine gives one back", async () => {
    rasterMock.mockResolvedValue("data:image/png;base64,UPGRADED")
    setCursor({ enabled: true, packId: "aero" })
    render(<CursorApplier />)
    await flush()
    expect(styleEl()?.textContent).toContain("data:image/png;base64,UPGRADED")
  })

  it("keeps the SVG when rasterization is unavailable", async () => {
    rasterMock.mockResolvedValue(null)
    setCursor({ enabled: true, packId: "aero" })
    render(<CursorApplier />)
    await flush()
    expect(styleEl()?.textContent).toContain("data:image/svg+xml")
  })

  it("reuses the same style element rather than stacking sheets", async () => {
    setCursor({ enabled: true, packId: "aero" })
    const { rerender } = render(<CursorApplier />)
    await flush()
    act(() => setCursor({ enabled: true, packId: "neon" }))
    rerender(<CursorApplier />)
    await flush()
    expect(document.querySelectorAll(`#${CURSOR_STYLE_ELEMENT_ID}`)).toHaveLength(1)
    expect(document.documentElement.getAttribute(CURSOR_ROOT_ATTR)).toBe("neon")
  })

  it("tears the sheet and the attribute down on unmount", async () => {
    setCursor({ enabled: true, packId: "aero" })
    const { unmount } = render(<CursorApplier />)
    await flush()
    unmount()
    expect(styleEl()).toBeNull()
    expect(document.documentElement.hasAttribute(CURSOR_ROOT_ATTR)).toBe(false)
  })

  it("clears the sheet when the feature is switched back off", async () => {
    setCursor({ enabled: true, packId: "aero" })
    const { rerender } = render(<CursorApplier />)
    await flush()
    act(() => setCursor({ enabled: false, packId: "aero" }))
    rerender(<CursorApplier />)
    await flush()
    expect(styleEl()).toBeNull()
  })

  it("does not let an in-flight raster repaint after the pack changed", async () => {
    let release: (value: string | null) => void = () => {}
    rasterMock.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          release = resolve
        })
    )
    setCursor({ enabled: true, packId: "aero" })
    const { rerender } = render(<CursorApplier />)

    act(() => setCursor({ enabled: false, packId: "aero" }))
    rerender(<CursorApplier />)
    await act(async () => {
      release("data:image/png;base64,STALE")
      await Promise.resolve()
      await Promise.resolve()
    })
    // The stale upgrade must not resurrect a sheet the user just turned off.
    expect(styleEl()).toBeNull()
  })
})
