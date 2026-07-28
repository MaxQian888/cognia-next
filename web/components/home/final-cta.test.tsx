import { render, screen } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import type { Evidence, ReleaseState } from "@web/lib/evidence"
import { FinalCta } from "./final-cta"

const DOCS = "https://docs.cognia.example"

const noRelease: ReleaseState = {
  hasRelease: false,
  version: null,
  publishedAt: null,
  htmlUrl: "https://github.com/MaxQian888/cognia-next/releases",
  byPlatform: { macos: [], windows: [], linux: [] },
}

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    readAt: "2026-07-26T00:00:00.000Z",
    lastGoodReadAt: "2026-07-26T00:00:00.000Z",
    errors: [],
    repo: { stars: 52, license: "AGPL-3.0-or-later", description: null },
    contributors: 2,
    releases: [],
    changesets: [],
    ...overrides,
  }
}

function renderCta(locale: "en" | "zh" = "en", state = noRelease, data: Evidence = evidence()) {
  const copy = locale === "en" ? en : zh
  return render(
    <FinalCta locale={locale} copy={copy} releaseState={state} evidence={data} docsOrigin={DOCS} />
  )
}

describe("FinalCta", () => {
  it("closes with the single headline", () => {
    renderCta()
    expect(screen.getByRole("heading", { name: en.home.finalCta.title })).toBeInTheDocument()
  })

  it("repeats the same primary action as the hero, including its degraded wording", () => {
    renderCta()
    expect(screen.getByRole("link", { name: en.common.download.unavailable })).toHaveAttribute(
      "href",
      "/download"
    )
  })

  it("becomes a download action once a release exists", () => {
    renderCta("en", { ...noRelease, hasRelease: true, version: "v0.2.0" })
    expect(screen.getByRole("link", { name: en.common.download.available })).toBeInTheDocument()
  })

  it("offers source and docs as the quieter follow-ups", () => {
    renderCta()
    expect(screen.getByRole("link", { name: en.common.viewSource })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: en.common.readDocs })).toHaveAttribute(
      "href",
      `${DOCS}/en/docs`
    )
  })

  it("carries the support line", () => {
    renderCta()
    expect(screen.getByText(en.home.finalCta.support)).toBeInTheDocument()
  })

  it("localises the close", () => {
    renderCta("zh")
    expect(screen.getByRole("heading", { name: zh.home.finalCta.title })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: zh.common.readDocs })).toHaveAttribute(
      "href",
      `${DOCS}/zh/docs`
    )
  })
})

// The evidence pipeline can come back without a license — a rate-limited or
// failed read leaves `repo.license` null — and the row must still say
// something true rather than rendering an empty cell.
describe("FinalCta with incomplete evidence", () => {
  it("falls back to the footer's license note when the repo read has none", () => {
    renderCta("en", noRelease, evidence({ repo: { stars: 52, license: null, description: null } }))
    expect(screen.getByText(en.footer.licenseNote)).toBeInTheDocument()
  })

  it("still names the license when the read did return one", () => {
    renderCta("en", noRelease, evidence())
    expect(screen.getByText("AGPL-3.0-or-later")).toBeInTheDocument()
  })
})
