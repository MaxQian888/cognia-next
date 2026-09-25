import { ONBOARDING_ROUTE, isOnboardingRoute, onboardingHref, readOnboardingFocus } from "./route"

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

describe("onboardingHref", () => {
  it("is the bare route when nothing in particular is missing", () => {
    expect(onboardingHref()).toBe(ONBOARDING_ROUTE)
  })

  it("carries the focus as a query param the flow reads on mount", () => {
    expect(onboardingHref("model")).toBe(`${ONBOARDING_ROUTE}?focus=model`)
    expect(onboardingHref("task")).toBe(`${ONBOARDING_ROUTE}?focus=task`)
  })

  it("stays inside the takeover, so the desktop chrome is still suppressed", () => {
    expect(isOnboardingRoute(onboardingHref("task").split("?")[0])).toBe(true)
  })
})

describe("readOnboardingFocus", () => {
  it("round-trips what onboardingHref writes", () => {
    expect(readOnboardingFocus(`?${onboardingHref("model").split("?")[1]}`)).toBe("model")
    expect(readOnboardingFocus("?focus=task")).toBe("task")
  })

  it("ignores values it does not know rather than trusting the URL", () => {
    expect(readOnboardingFocus("?focus=provider")).toBeNull()
    expect(readOnboardingFocus("?focus=")).toBeNull()
    expect(readOnboardingFocus("?other=task")).toBeNull()
  })

  it("tolerates an empty or missing query string", () => {
    expect(readOnboardingFocus("")).toBeNull()
    expect(readOnboardingFocus(null)).toBeNull()
    expect(readOnboardingFocus(undefined)).toBeNull()
  })
})
