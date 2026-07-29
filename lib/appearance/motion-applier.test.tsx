import { act, render } from "@testing-library/react"
import { useSettingsStore } from "@/stores/settings"
import { MotionApplier, resolveMotionState, speedToDurationScale } from "./motion-applier"
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"
import type { MotionSettings } from "@/types/appearance"

const baseSettings = {
  id: "singleton" as const,
  permissionMode: "default" as const,
  alwaysAllowTools: [],
  builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
}

function setMotion(motion: MotionSettings | undefined) {
  useSettingsStore.setState({
    settings: motion ? { ...baseSettings, motion } : { ...baseSettings },
  })
}

afterEach(() => {
  document.documentElement.classList.remove("reduce-motion")
  document.documentElement.style.removeProperty("--motion-duration-scale")
  useSettingsStore.setState({ settings: null })
})

describe("resolveMotionState", () => {
  it("defaults to 1x speed and no reduce class", () => {
    expect(resolveMotionState(undefined)).toEqual({
      reduceClass: false,
      cssVarValue: "1",
    })
  })

  it("flips the class when reduce is true regardless of speed", () => {
    // 0.5x speed is the SLOW end, so durations double.
    expect(resolveMotionState({ speed: 0.5, reduce: true })).toEqual({
      reduceClass: true,
      cssVarValue: "2",
    })
  })

  it("inverts 1.5x speed into a 0.667x duration scale without touching the class", () => {
    expect(resolveMotionState({ speed: 1.5, reduce: false })).toEqual({
      reduceClass: false,
      cssVarValue: "0.667",
    })
  })
})

describe("speedToDurationScale", () => {
  it("is the reciprocal of the user-facing speed multiplier", () => {
    // The whole point of the function: the settings UI labels 1.5x as "Fast",
    // and a faster animation is a SHORTER one.
    expect(speedToDurationScale(1)).toBe(1)
    expect(speedToDurationScale(0.5)).toBe(2)
    expect(speedToDurationScale(1.5)).toBe(0.667)
  })

  it("falls back to neutral for a missing or non-finite preference", () => {
    expect(speedToDurationScale(undefined)).toBe(1)
    expect(speedToDurationScale(Number.NaN)).toBe(1)
    expect(speedToDurationScale(Number.POSITIVE_INFINITY)).toBe(1)
  })

  it("clamps a corrupt persisted speed instead of emitting Infinity", () => {
    // A 0 would divide to Infinity and silently invalidate every calc() that
    // reads the var, which fails far away from the cause.
    expect(speedToDurationScale(0)).toBe(4)
    expect(speedToDurationScale(-2)).toBe(4)
    expect(speedToDurationScale(1000)).toBe(0.25)
  })
})

describe("MotionApplier", () => {
  it("writes the var and toggles the class together", () => {
    setMotion({ speed: 0.5, reduce: true })
    const { unmount } = render(<MotionApplier />)
    const root = document.documentElement
    expect(root.style.getPropertyValue("--motion-duration-scale")).toBe("2")
    expect(root.classList.contains("reduce-motion")).toBe(true)
    unmount()
    expect(root.style.getPropertyValue("--motion-duration-scale")).toBe("")
    expect(root.classList.contains("reduce-motion")).toBe(false)
  })

  it("clears reduce class when settings change to reduce:false", () => {
    setMotion({ speed: 1, reduce: true })
    const { rerender } = render(<MotionApplier />)
    expect(document.documentElement.classList.contains("reduce-motion")).toBe(true)
    act(() => {
      setMotion({ speed: 1, reduce: false })
    })
    rerender(<MotionApplier />)
    expect(document.documentElement.classList.contains("reduce-motion")).toBe(false)
  })
})
