import { SITE_CONSOLE_TABS, isSiteConsoleTab, useSiteConsoleStore } from "./site-console-store"

beforeEach(() => useSiteConsoleStore.getState().reset())

it("starts with no selection so the console can auto-select the first Site", () => {
  expect(useSiteConsoleStore.getState().selectedId).toBeNull()
  expect(useSiteConsoleStore.getState().tab).toBe("publish")
})

it("returns to the publish flow when the Site changes", () => {
  // "Operations" for Site A is meaningless for Site B; an empty journal reads
  // as a broken tab rather than a different Site.
  useSiteConsoleStore.getState().setTab("operations")
  useSiteConsoleStore.getState().select("site_2")
  expect(useSiteConsoleStore.getState().tab).toBe("publish")
  expect(useSiteConsoleStore.getState().selectedId).toBe("site_2")
})

it("keeps the tab when only the tab changes", () => {
  useSiteConsoleStore.getState().select("site_1")
  useSiteConsoleStore.getState().setTab("versions")
  expect(useSiteConsoleStore.getState().tab).toBe("versions")
  expect(useSiteConsoleStore.getState().selectedId).toBe("site_1")
})

it("narrows a deep-link tab value and rejects anything else", () => {
  for (const tab of SITE_CONSOLE_TABS) expect(isSiteConsoleTab(tab)).toBe(true)
  expect(isSiteConsoleTab("nope")).toBe(false)
  expect(isSiteConsoleTab(null)).toBe(false)
  expect(isSiteConsoleTab(undefined)).toBe(false)
})
