import {
  SETUP_MAX_SCHEDULES,
  buildSetupRecommendationsSection,
  shouldOfferSetup,
} from "./setup-recommendations"

describe("shouldOfferSetup", () => {
  it("offers once, before any thread exists", () => {
    expect(shouldOfferSetup({ setupOfferedAt: undefined, threadCount: 0 })).toBe(true)
    expect(shouldOfferSetup({ setupOfferedAt: 5, threadCount: 0 })).toBe(false)
    expect(shouldOfferSetup({ setupOfferedAt: undefined, threadCount: 1 })).toBe(false)
  })
})

describe("buildSetupRecommendationsSection", () => {
  it("suggests exploring the primary root and a thread per other root", () => {
    const section = buildSetupRecommendationsSection({
      project: {
        roots: [
          { id: "r1", path: "/src/app", isPrimary: true },
          { id: "r2", path: "/src/docs", label: "Docs" },
        ],
      },
      schedules: [],
    })
    expect(section).toContain("propose_threads")
    expect(section).toContain("An exploration thread that maps /src/app")
    expect(section).toContain("A thread for Docs (root_id r2)")
    expect(section).not.toContain("Schedules already running")
  })

  it("works for a rootless workspace and lists schedules, capped", () => {
    const schedules = Array.from({ length: SETUP_MAX_SCHEDULES + 2 }, (_, i) => ({
      name: `Job ${i}`,
      status: "active" as const,
    }))
    const section = buildSetupRecommendationsSection({ project: { roots: [] }, schedules })
    expect(section).toContain("maps the working folder")
    expect(section).toContain("- Job 0 (active)")
    expect(section).not.toContain(`Job ${SETUP_MAX_SCHEDULES} `)
    expect(section).toContain("…and 2 more")
  })
})
