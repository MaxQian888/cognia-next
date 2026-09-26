import {
  NAV_BADGE_ITEM_IDS,
  NAV_BADGE_TARGETS,
  __resetNavBadgesForTests,
  getNavBadgeServerSnapshot,
  getNavBadgeSnapshot,
  navBadgeCount,
  setNavBadgeSourceCount,
  subscribeNavBadges,
  sumNavBadges,
} from "./nav-badges"
import { SIDEBAR_NAV_META } from "@/types/shell/sidebar"

beforeEach(() => __resetNavBadgesForTests())

describe("nav badge targets", () => {
  it("badges only destinations that exist in the navigation catalog", () => {
    const ids = new Set(SIDEBAR_NAV_META.map((meta) => meta.id))
    for (const target of Object.values(NAV_BADGE_TARGETS)) expect(ids.has(target)).toBe(true)
    expect([...NAV_BADGE_ITEM_IDS].sort()).toEqual(["agent-runs", "bots", "inbox", "scheduler"])
  })
})

describe("setNavBadgeSourceCount", () => {
  it("folds several sources into one destination count", () => {
    setNavBadgeSourceCount("inbox.drafts", 2)
    setNavBadgeSourceCount("inbox.approvals", 1)
    setNavBadgeSourceCount("inbox.questions", 3)
    setNavBadgeSourceCount("bots.attention", 1)
    expect(getNavBadgeSnapshot()).toEqual({ inbox: 6, bots: 1 })
  })

  it("drops a destination whose sources all went to zero", () => {
    setNavBadgeSourceCount("scheduler.attention", 4)
    setNavBadgeSourceCount("scheduler.attention", 0)
    expect(getNavBadgeSnapshot()).toEqual({})
  })

  it("treats negative and non-finite counts as nothing waiting", () => {
    setNavBadgeSourceCount("agent-runs.attention", -3)
    setNavBadgeSourceCount("bots.attention", Number.NaN)
    setNavBadgeSourceCount("inbox.drafts", 2.7)
    expect(getNavBadgeSnapshot()).toEqual({ inbox: 2 })
  })

  it("keeps the snapshot and stays silent when no destination changed", () => {
    const listener = jest.fn()
    subscribeNavBadges(listener)
    setNavBadgeSourceCount("inbox.drafts", 1)
    const first = getNavBadgeSnapshot()
    expect(listener).toHaveBeenCalledTimes(1)
    setNavBadgeSourceCount("inbox.drafts", 1)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(getNavBadgeSnapshot()).toBe(first)
  })

  it("notifies until unsubscribed", () => {
    const listener = jest.fn()
    const unsubscribe = subscribeNavBadges(listener)
    setNavBadgeSourceCount("bots.attention", 2)
    unsubscribe()
    setNavBadgeSourceCount("bots.attention", 3)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe("readers", () => {
  it("counts a destination, or zero", () => {
    setNavBadgeSourceCount("agent-runs.attention", 5)
    expect(navBadgeCount(getNavBadgeSnapshot(), "agent-runs")).toBe(5)
    expect(navBadgeCount(getNavBadgeSnapshot(), "inbox")).toBe(0)
  })

  it("sums only the ids asked for — what is on screen", () => {
    setNavBadgeSourceCount("inbox.drafts", 2)
    setNavBadgeSourceCount("bots.attention", 1)
    expect(sumNavBadges(getNavBadgeSnapshot(), ["inbox", "skills"])).toBe(2)
    expect(sumNavBadges(getNavBadgeSnapshot(), [])).toBe(0)
  })

  it("serves an empty snapshot to a static render", () => {
    setNavBadgeSourceCount("inbox.drafts", 2)
    expect(getNavBadgeServerSnapshot()).toEqual({})
  })
})
