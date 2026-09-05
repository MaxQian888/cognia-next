import { render, screen, within } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import type { Evidence } from "@web/lib/evidence"
import { TrustSection } from "./trust-section"

const DOCS = "https://docs.cognia.example"

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    readAt: "2026-07-26T10:00:00.000Z",
    lastGoodReadAt: "2026-07-26T10:00:00.000Z",
    errors: [],
    repo: { stars: 52, license: "AGPL-3.0", description: null },
    contributors: 2,
    releases: [],
    changesets: [],
    inventory: {
      plugins: 59,
      connectors: 11,
      workflowNodeKinds: 185,
      crates: 35,
      packages: 32,
      adrs: 167,
      testFiles: 9496,
    },
    ...overrides,
  }
}

function renderTrust(data: Evidence = evidence(), locale: "en" | "zh" = "en") {
  const copy = locale === "en" ? en : zh
  return render(
    <TrustSection
      copy={copy.home.trust}
      common={copy.common}
      evidence={data}
      locale={locale}
      docsOrigin={DOCS}
    />
  )
}

describe("TrustSection bento", () => {
  it("renders the four evidence cards", () => {
    renderTrust()
    // Scoped to the bento: "Source" also labels a step on the provenance rail,
    // and an unscoped query would match both.
    const bento = screen.getByRole("list", { name: en.home.trust.title })
    for (const card of en.home.trust.cards) {
      expect(within(bento).getByText(card.label)).toBeInTheDocument()
      expect(within(bento).getByText(card.body)).toBeInTheDocument()
    }
  })

  it("distinguishes the bento's Source card from the rail's Source step", () => {
    renderTrust()
    const bento = screen.getByRole("list", { name: en.home.trust.title })
    const rail = screen.getByRole("complementary", { name: en.home.trust.provenanceLabel })
    expect(within(bento).getByText("Source")).toBeInTheDocument()
    expect(within(rail).getByText("Source")).toBeInTheDocument()
  })

  it("links the source card at the repository", () => {
    renderTrust()
    expect(screen.getByRole("link", { name: "Read the source" })).toHaveAttribute(
      "href",
      "https://github.com/MaxQian888/cognia-next"
    )
  })

  it("uses shared editorial dividers instead of a large rounded card", () => {
    const { container } = renderTrust()
    expect(container.querySelector(".rounded-stage")).toBeNull()
    expect(container.querySelector(".border-y.bg-hairline")).toBeInTheDocument()
  })
})

describe("TrustSection provenance rail", () => {
  it("threads source, action, permission and result", () => {
    renderTrust()
    const rail = screen.getByRole("complementary", { name: en.home.trust.provenanceLabel })
    expect(rail).toBeInTheDocument()
    for (const step of en.home.trust.provenance) {
      expect(within(rail).getByText(step.label)).toBeInTheDocument()
      expect(within(rail).getByText(step.value)).toBeInTheDocument()
    }
  })
})

describe("TrustSection figures", () => {
  it("reads every figure from the evidence snapshot", () => {
    const { container } = renderTrust()
    expect(screen.getByText("52")).toBeInTheDocument()
    expect(screen.getByText("2")).toBeInTheDocument()
    expect(screen.getByText("AGPL-3.0")).toBeInTheDocument()
    expect(container.querySelectorAll('[data-slot="number-ticker"]')).toHaveLength(2)
  })

  it("says there is no release rather than printing a zero or a blank", () => {
    renderTrust()
    expect(screen.getByText(en.home.trust.noReleasesYet)).toBeInTheDocument()
  })

  it("shows the latest release once one exists", () => {
    renderTrust(
      evidence({
        releases: [
          {
            tagName: "v0.2.0",
            name: "v0.2.0",
            prerelease: false,
            publishedAt: "2026-07-20T00:00:00.000Z",
            htmlUrl: "https://example.test",
            body: null,
            assets: [],
          },
        ],
      })
    )
    expect(screen.getByText("v0.2.0")).toBeInTheDocument()
  })

  it("stamps the figures with the moment they were read", () => {
    renderTrust()
    expect(screen.getByText("as of 2026-07-26")).toBeInTheDocument()
  })

  it("says the read failed rather than implying the figures were just checked", () => {
    renderTrust(
      evidence({
        errors: ["repo: 403"],
        readAt: "2026-07-28T10:00:00.000Z",
        lastGoodReadAt: "2026-07-26T10:00:00.000Z",
      })
    )
    expect(screen.getByText("last successful read 2026-07-26")).toBeInTheDocument()
    expect(screen.queryByText("as of 2026-07-28")).toBeNull()
  })

  it("renders an em dash instead of a zero when a figure is unavailable", () => {
    renderTrust(
      evidence({
        errors: ["repo: 403"],
        repo: { stars: null, license: null, description: null },
        contributors: null,
      })
    )
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3)
    expect(screen.queryByText("0")).toBeNull()
  })
})

describe("TrustSection localisation", () => {
  it("renders the Chinese cards and rail", () => {
    renderTrust(evidence(), "zh")
    expect(screen.getByRole("heading", { name: zh.home.trust.title })).toBeInTheDocument()
    expect(
      screen.getByRole("complementary", { name: zh.home.trust.provenanceLabel })
    ).toBeInTheDocument()
  })

  it("localises the freshness label", () => {
    renderTrust(evidence(), "zh")
    expect(screen.getByText("数据截至 2026-07-26")).toBeInTheDocument()
  })
})
