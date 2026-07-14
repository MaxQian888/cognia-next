/** @jest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react"
import { OverviewTab } from "./overview-tab"
import { getAppInstancesCache } from "@/hooks/a2ui/app-builder/persistence"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/db/a2ui-event-history", () => ({
  listEvents: jest.fn(async () => []),
}))

jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: (selector: (s: unknown) => unknown) => selector({ surfaces: {} }),
}))

describe("OverviewTab", () => {
  beforeEach(() => {
    getAppInstancesCache().clear()
  })

  it("counts saved apps from the localStorage instance store, not the empty Dexie table", async () => {
    const cache = getAppInstancesCache()
    cache.set("app-a", {
      id: "app-a",
      templateId: "calculator",
      name: "My Calculator",
      createdAt: 1,
      lastModified: 20,
    })
    cache.set("app-b", {
      id: "app-b",
      templateId: "todo",
      name: "My Todo",
      createdAt: 2,
      lastModified: 10,
    })

    render(<OverviewTab />)

    await waitFor(() => {
      // Count reflects the two saved instances (previously hard-coded to 0).
      expect(screen.getByText("2")).toBeInTheDocument()
    })
    // Recent list is newest-first by lastModified.
    expect(screen.getByText("My Calculator")).toBeInTheDocument()
    expect(screen.getByText("My Todo")).toBeInTheDocument()
    const links = screen.getAllByRole("link")
    expect(links.some((l) => l.getAttribute("href") === "/a2ui?app=app-a")).toBe(true)
  })

  it("shows the empty state when there are no saved apps", async () => {
    render(<OverviewTab />)
    await waitFor(() => {
      expect(screen.getByText("recent.empty")).toBeInTheDocument()
    })
  })
})
