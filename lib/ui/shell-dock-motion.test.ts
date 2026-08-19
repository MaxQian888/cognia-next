/**
 * @jest-environment jsdom
 */

import { MOBILE_DURATION, MOBILE_EASE } from "@/lib/ui/motion"

import {
  SHELL_DOCK_CLEANUP_SLACK_MS,
  SHELL_DOCK_DURATION_MS,
  SHELL_DOCK_EASE,
  SHELL_DOCK_TIMING_CLASS,
  shellDockAnimationMs,
  shellDockDurationScale,
} from "./shell-dock-motion"

describe("shell dock motion tokens", () => {
  it("takes its duration and curve from the shared motion tokens", () => {
    expect(SHELL_DOCK_DURATION_MS).toBe(MOBILE_DURATION.normal * 1000)
    expect(SHELL_DOCK_EASE).toBe(`cubic-bezier(${MOBILE_EASE.join(",")})`)
  })

  it("keeps the Tailwind literal in step with the constants", () => {
    // The literal cannot interpolate the constants and still compile, so this
    // is the only thing standing between the CSS and the JS drifting apart.
    expect(SHELL_DOCK_TIMING_CLASS).toContain(
      `duration-[calc(${SHELL_DOCK_DURATION_MS}ms*var(--motion-duration-scale,1))]`
    )
    expect(SHELL_DOCK_TIMING_CLASS).toContain(`ease-[${SHELL_DOCK_EASE}]`)
  })

  it("reads the motion-speed multiplier off the element", () => {
    const el = document.createElement("div")
    el.style.setProperty("--motion-duration-scale", "2")
    document.body.append(el)
    expect(shellDockDurationScale(el)).toBe(2)
    expect(shellDockAnimationMs(el)).toBe(SHELL_DOCK_DURATION_MS * 2 + SHELL_DOCK_CLEANUP_SLACK_MS)
    el.remove()
  })

  it("falls back to 1x for a missing element or an unparseable value", () => {
    expect(shellDockDurationScale(null)).toBe(1)
    const el = document.createElement("div")
    el.style.setProperty("--motion-duration-scale", "not-a-number")
    document.body.append(el)
    expect(shellDockDurationScale(el)).toBe(1)
    expect(shellDockAnimationMs(el)).toBe(SHELL_DOCK_DURATION_MS + SHELL_DOCK_CLEANUP_SLACK_MS)
    el.remove()
  })

  it("never returns a zero or negative scale", () => {
    const el = document.createElement("div")
    el.style.setProperty("--motion-duration-scale", "0")
    document.body.append(el)
    expect(shellDockDurationScale(el)).toBe(1)
    el.remove()
  })
})
