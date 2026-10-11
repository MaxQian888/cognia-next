/**
 * @jest-environment jsdom
 */

import { render, renderHook, screen } from "@testing-library/react"

import { DEFAULT_GLANCE_PANEL_SETTINGS } from "@/lib/glance/presets"
import { GLANCE_SNAPSHOT_VERSION, type GlanceSnapshotV1 } from "@/lib/glance/snapshot"

import { GlanceProvider, useGlance, type GlanceContextValue } from "./glance-context"

function makeSnapshot(): GlanceSnapshotV1 {
  return {
    version: GLANCE_SNAPSHOT_VERSION,
    epoch: 1,
    revision: 1,
    generatedAt: 1_000,
    config: DEFAULT_GLANCE_PANEL_SETTINGS,
    workspace: null,
    when: {} as GlanceSnapshotV1["when"],
    fleet: null,
    usage: null,
    quota: null,
    agenda: null,
    activity: null,
    recents: null,
    pet: null,
  }
}

function makeValue(): GlanceContextValue {
  return {
    snapshot: makeSnapshot(),
    platform: "desktop",
    width: "standard",
    now: 5_000,
    send: jest.fn(async () => null),
    route: jest.fn(),
  }
}

describe("useGlance", () => {
  it("throws a descriptive error outside a GlanceProvider", () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(() => renderHook(() => useGlance())).toThrow(
        "useGlance must be used inside a GlanceProvider"
      )
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("returns the provided value inside a GlanceProvider", () => {
    const value = makeValue()
    const { result } = renderHook(() => useGlance(), {
      wrapper: ({ children }) => <GlanceProvider value={value}>{children}</GlanceProvider>,
    })
    expect(result.current).toBe(value)
    expect(result.current.platform).toBe("desktop")
    expect(result.current.now).toBe(5_000)
  })

  it("lets a consumer read the value while rendering", () => {
    function Consumer() {
      const { platform, width } = useGlance()
      return <p>{`${platform}/${width}`}</p>
    }
    render(
      <GlanceProvider value={{ ...makeValue(), platform: "mobile", width: "wide" }}>
        <Consumer />
      </GlanceProvider>
    )
    expect(screen.getByText("mobile/wide")).toBeInTheDocument()
  })

  it("exposes the same send and route functions the host supplied", async () => {
    const value = makeValue()
    const { result } = renderHook(() => useGlance(), {
      wrapper: ({ children }) => <GlanceProvider value={value}>{children}</GlanceProvider>,
    })
    await expect(result.current.send({ kind: "refresh" })).resolves.toBeNull()
    result.current.route({ kind: "open-fleet" })
    expect(value.send).toHaveBeenCalledWith({ kind: "refresh" })
    expect(value.route).toHaveBeenCalledWith({ kind: "open-fleet" })
  })
})
