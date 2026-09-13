/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import {
  CAPABILITY_LABEL_KEY,
  MODEL_CAPABILITY_ORDER,
  ModelCapabilityIcons,
  isKnownCapability,
} from "./model-capability-icons"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => `cap.${key}`,
}))

describe("ModelCapabilityIcons", () => {
  it("renders one labelled glyph per present capability, in the fixed order", () => {
    render(<ModelCapabilityIcons capabilities={["vision", "tools"]} />)
    const items = screen.getAllByRole("listitem")
    expect(items.map((el) => el.getAttribute("data-capability"))).toEqual(["tools", "vision"])
    expect(items[0]).toHaveAttribute("aria-label", "cap.tools")
    expect(items[0]).toHaveAttribute("title", "cap.tools")
  })

  it("renders nothing for a model with no capabilities", () => {
    const { container } = render(<ModelCapabilityIcons capabilities={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("is case-insensitive on the incoming ids", () => {
    render(<ModelCapabilityIcons capabilities={["Vision"]} />)
    expect(screen.getByRole("listitem")).toHaveAttribute("data-capability", "vision")
  })

  it("maps every ordered capability to a label key", () => {
    for (const id of MODEL_CAPABILITY_ORDER) {
      expect(isKnownCapability(id)).toBe(true)
      expect(CAPABILITY_LABEL_KEY[id]).toMatch(/^[a-zA-Z]+$/)
    }
    expect(isKnownCapability("teleport")).toBe(false)
  })
})
