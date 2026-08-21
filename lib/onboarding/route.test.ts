import { ONBOARDING_ROUTE, isOnboardingRoute } from "./route"

describe("isOnboardingRoute", () => {
  it("matches the route itself and its static-export .html twin", () => {
    expect(isOnboardingRoute(ONBOARDING_ROUTE)).toBe(true)
    expect(isOnboardingRoute(`${ONBOARDING_ROUTE}.html`)).toBe(true)
  })

  it("matches nested steps under the takeover", () => {
    expect(isOnboardingRoute(`${ONBOARDING_ROUTE}/profile`)).toBe(true)
    expect(isOnboardingRoute(`${ONBOARDING_ROUTE}/`)).toBe(true)
  })

  it("tolerates a null or undefined pathname (the App Router hook can return null)", () => {
    expect(isOnboardingRoute(null)).toBe(false)
    expect(isOnboardingRoute(undefined)).toBe(false)
    expect(isOnboardingRoute("")).toBe(false)
  })

  it("does not match a sibling route that merely shares the prefix", () => {
    // The chrome suppression hangs off this predicate, so a false positive
    // would strip the title bar and rail from an unrelated page.
    expect(isOnboardingRoute("/onboarding-report")).toBe(false)
    expect(isOnboardingRoute("/settings/onboarding")).toBe(false)
    expect(isOnboardingRoute("/onboardings")).toBe(false)
  })

  it("pins the constant the gate, the page and the settings entry all share", () => {
    expect(ONBOARDING_ROUTE).toBe("/onboarding")
  })
})
