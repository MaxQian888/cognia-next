import { act, render } from "@testing-library/react"
import { useSettingsStore } from "@/stores/settings"
import { MotionApplier, resolveMotionState } from "./motion-applier"
import { DEFAULT_BUILTIN_TOOLS } from "@/lib/claude/types"
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
    expect(resolveMotionState({ speed: 0.5, reduce: true })).toEqual({
      reduceClass: true,
      cssVarValue: "0.5",
    })
  })

  it("exposes 1.5x speed without touching the class", () => {
    expect(resolveMotionState({ speed: 1.5, reduce: false })).toEqual({
      reduceClass: false,
      cssVarValue: "1.5",
    })
  })
})

describe("MotionApplier", () => {
  it("writes the var and toggles the class together", () => {
    setMotion({ speed: 0.5, reduce: true })
    const { unmount } = render(<MotionApplier />)
    const root = document.documentElement
    expect(root.style.getPropertyValue("--motion-duration-scale")).toBe("0.5")
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
