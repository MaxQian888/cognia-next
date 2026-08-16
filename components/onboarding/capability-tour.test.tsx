/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"

const push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

const createSurface = jest.fn()
const updateComponents = jest.fn()
jest.mock("@/stores/a2ui/a2ui-store", () => ({
  useA2UIStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ createSurface, updateComponents }),
}))

// The tour's contribution is the fixed payload plus host navigation; the A2UI
// stack itself is exercised by its own suites.
jest.mock("@/components/a2ui/a2ui-context", () => ({
  A2UIProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
jest.mock("@/components/a2ui/a2ui-renderer", () => ({
  A2UIRenderer: ({ component }: { component: { id: string } }) => (
    <div data-testid={`a2ui-${component.id}`} />
  ),
}))

import { CapabilityTour } from "./capability-tour"
import { TOUR_SLIDE_IDS } from "@/lib/onboarding/tour-payload"

beforeEach(() => jest.clearAllMocks())

describe("CapabilityTour", () => {
  it("registers the tour as a real A2UI surface", () => {
    render(<CapabilityTour />)
    expect(createSurface).toHaveBeenCalledWith("onboarding-tour", "inline", expect.anything())
    expect(updateComponents).toHaveBeenCalledWith("onboarding-tour", [
      expect.objectContaining({ component: "InteractiveGuide" }),
    ])
  })

  it("renders through the A2UI renderer rather than importing the guide directly", () => {
    render(<CapabilityTour />)
    expect(screen.getByTestId("a2ui-onboarding-tour")).toBeInTheDocument()
  })

  it("offers a deep link for every subsystem, not just the visible slide", () => {
    render(<CapabilityTour />)
    for (const id of TOUR_SLIDE_IDS) {
      expect(screen.getByTestId(`onboarding-tour-cta-${id}`)).toBeInTheDocument()
    }
  })

  it("navigates to the matching Settings section", () => {
    render(<CapabilityTour />)
    fireEvent.click(screen.getByTestId("onboarding-tour-cta-ocr"))
    expect(push).toHaveBeenCalledWith("/settings?section=ocr")
  })

  it("renders with no model configured — the payload is a constant", () => {
    // The user most in need of "what can this do" is the one who skipped the
    // provider step, so nothing here may depend on a model turn.
    render(<CapabilityTour />)
    expect(screen.getByTestId("onboarding-capability-tour")).toBeInTheDocument()
  })
})
