import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

import type { SiteVersionRow } from "@/types/sites"
import { SiteHeroStats } from "./site-hero-stats"

const EMPTY = { versions: [], deployments: [], operations: [], resources: [] }

function version(over: Partial<SiteVersionRow> & Pick<SiteVersionRow, "id">): SiteVersionRow {
  return {
    siteId: "s1",
    sequence: 1,
    status: "ready",
    environmentRevisionId: "env",
    source: { commitSha: "a", dirty: false, lockfileDigest: "l", inputDigest: "i" },
    build: {
      command: "[]",
      runtime: "node@24",
      packageManager: "pnpm@10",
      compatibilityDate: "2026-01-01",
      compatibilityFlags: [],
      routes: [],
      bindings: [],
    },
    artifactDigest: `d-${over.id}`,
    artifactSize: 2048,
    artifactFileCount: 2,
    createdAt: 1,
    ...over,
  }
}

it("renders nothing at all rather than a strip of zeros", () => {
  // An empty tile reads as a value that failed to load.
  const { container } = render(<SiteHeroStats {...EMPTY} />)
  expect(container).toBeEmptyDOMElement()
})

it("shows ready versions against the total", () => {
  render(
    <SiteHeroStats
      {...EMPTY}
      versions={[version({ id: "a" }), version({ id: "b", status: "failed" })]}
    />
  )
  const stat = screen.getByTestId("site-stat-versions")
  expect(stat).toHaveTextContent("1/2")
  expect(stat).toHaveTextContent('stats.detail.versions:{"count":"1"}')
})

it("names each stat, so a number never stands alone", () => {
  render(<SiteHeroStats {...EMPTY} versions={[version({ id: "a" })]} />)
  expect(screen.getByTestId("site-stat-versions")).toHaveTextContent("stats.versions")
})

it("gives the column count to the stats it actually has", () => {
  // A fixed four-column grid would leave a hole.
  render(<SiteHeroStats {...EMPTY} versions={[version({ id: "a" })]} />)
  expect(screen.getByTestId("site-hero-stats").className).toContain("grid-cols-2")
})
