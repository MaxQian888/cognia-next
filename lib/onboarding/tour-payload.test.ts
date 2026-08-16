import {
  TOUR_SLIDE_HREFS,
  TOUR_SLIDE_ICONS,
  TOUR_SLIDE_IDS,
  buildTourPayload,
} from "./tour-payload"

const t = (key: string) => `tour.${key}`

describe("TOUR_SLIDE_IDS", () => {
  it("keeps the six slides unique", () => {
    expect(new Set(TOUR_SLIDE_IDS).size).toBe(TOUR_SLIDE_IDS.length)
    expect(TOUR_SLIDE_IDS).toHaveLength(6)
  })

  it("leads with sandbox — the invariant to know before touching shell tools", () => {
    expect(TOUR_SLIDE_IDS[0]).toBe("sandbox")
  })

  it("gives every slide a destination and an icon", () => {
    for (const id of TOUR_SLIDE_IDS) {
      expect(TOUR_SLIDE_HREFS[id]).toMatch(/^\/settings\?section=/)
      expect(TOUR_SLIDE_ICONS[id]).toBeTruthy()
    }
  })
})

describe("buildTourPayload", () => {
  it("produces an InteractiveGuide the A2UI renderer already knows", () => {
    const payload = buildTourPayload(t)
    expect(payload.component).toBe("InteractiveGuide")
    expect(payload.id).toBe("onboarding-tour")
  })

  it("carries one step per slide, in order", () => {
    const payload = buildTourPayload(t)
    expect(payload.steps.map((s) => s.id)).toEqual([...TOUR_SLIDE_IDS])
  })

  it("resolves copy through the caller's translator rather than reading a locale", () => {
    const payload = buildTourPayload(t)
    expect(payload.title).toBe("tour.title")
    expect(payload.steps[0]?.title).toBe("tour.sandbox.title")
    expect(payload.steps[0]?.description).toBe("tour.sandbox.description")
  })

  it("declares no child content ids — there are no child components to resolve", () => {
    // Dangling ids would leave the renderer looking up references that are not
    // in the payload.
    for (const step of buildTourPayload(t).steps) {
      expect(step.content).toEqual([])
    }
  })

  it("allows skipping, because the tour is optional now", () => {
    expect(buildTourPayload(t).allowSkip).toBe(true)
  })

  it("is deterministic — the same input yields an identical payload", () => {
    // This is what lets it render with no model and no provider configured.
    expect(buildTourPayload(t)).toEqual(buildTourPayload(t))
  })
})
