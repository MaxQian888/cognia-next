/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let reduce = false
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce, durationScale: 1 }),
}))

import { FirstRunScene } from "./first-run-scene"
import { CORE } from "./scene-primitives"

beforeEach(() => {
  reduce = false
})

describe("FirstRunScene", () => {
  it("reverses the flow — this is the one step where the core produces", () => {
    // Everywhere else the chips feed the core. Here it writes back out,
    // because the whole flow exists to reach that moment.
    render(<FirstRunScene />)
    const link = screen.getByTestId("onboarding-scene-link-output")
    // The path starts at the core's leading edge rather than ending there.
    expect(link.getAttribute("d")).toContain(`M${CORE.x - CORE.size / 2} ${CORE.y}`)
  })

  it("writes the output block line by line", () => {
    render(<FirstRunScene />)
    const first = screen.getByTestId("onboarding-scene-output-0")
    const last = screen.getByTestId("onboarding-scene-output-4")
    const delay = (el: Element) =>
      Number(/animation-delay: (\d+)ms/.exec(el.getAttribute("style") ?? "")?.[1] ?? -1)
    expect(delay(last)).toBeGreaterThan(delay(first))
  })

  it("blinks the caret, which is honest here", () => {
    // The next screen after this one is a real turn streaming into a real
    // conversation, so a caret is a promise the flow actually keeps.
    render(<FirstRunScene />)
    expect(screen.getByTestId("onboarding-scene-caret").getAttribute("class")).toContain(
      "animate-caret-blink"
    )
  })

  it("stops the caret when motion is reduced", () => {
    reduce = true
    render(<FirstRunScene />)
    expect(screen.getByTestId("onboarding-scene-caret").getAttribute("class") ?? "").not.toContain(
      "animate-caret-blink"
    )
  })

  it("keeps the core live — there is nothing left to wait for", () => {
    render(<FirstRunScene />)
    expect(screen.getByTestId("scene-core")).toHaveAttribute("data-active", "true")
  })
})
